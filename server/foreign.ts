import { D, Decimal, ZERO, cents, toStr } from '../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type ForeignClosure, type ForeignForm, type ForeignFormReport, type ForeignHolding, type ForeignReport, type OpKind, type Operation, type Position } from '../shared/types.ts';
import { custodianFor, fileItems, missingFor } from './aeat.ts';
import { db, getSettings } from './db.ts';
import { storedQuotes } from './quotes.ts';
import { calculationOps, engine, today } from './service.ts';

/** Brókers que custodian fuera de España cada tipo de activo. Lo que está en una cartera propia no va al 721. */
export const FOREIGN: Record<ForeignForm, { brokers: Broker[]; classes: string[] }> = {
  '720': { brokers: ['degiro', 'trade_republic', 'revolut'], classes: ['stock', 'etf', 'fund', 'bond'] },
  '721': { brokers: ['kraken', 'trade_republic', 'revolut', 'coinbase'], classes: ['crypto'] },
};
const THRESHOLD = D(50000);
const INCREASE = D(20000);
/** Movimientos con los que algo deja de estar en un bróker. Una comisión suelta no lo cierra. */
const OUTFLOWS: OpKind[] = ['sell', 'swap', 'withdrawal', 'transfer_out', 'isin_change'];

const key = (h: { broker: string; assetId: string }) => `${h.broker}|${h.assetId}`;

type Price = (assetId: string) => { eur: Decimal; priced: ForeignHolding['priced']; source: string | null } | null;

function holdings(positions: Position[], form: ForeignForm, price: Price, brokers: string[] = FOREIGN[form].brokers): ForeignHolding[] {
  const { classes } = FOREIGN[form];
  const out: ForeignHolding[] = [];
  for (const p of positions) {
    if (!classes.includes(p.class) || D(p.quantity).lte(0)) continue;
    for (const [broker, q] of Object.entries(p.byBroker)) {
      if (!brokers.includes(broker) || D(q).lte(0)) continue;
      const quantity = Decimal.min(D(q), D(p.quantity));
      const cost = D(p.costEur).times(quantity).div(D(p.quantity));
      const px = price(p.assetId);
      out.push({
        broker, assetId: p.assetId, assetName: p.assetName, quantity: quantity.toFixed(),
        costEur: cents(cost), valueEur: cents(px ? quantity.times(px.eur) : cost), priced: px?.priced ?? 'cost',
        class: p.class, since: p.since ?? null, priceSource: px?.source ?? null,
      });
    }
  }
  return out.sort((a, b) => D(b.valueEur).cmp(D(a.valueEur)));
}

const yahooOrKraken = (symbol: string | null | undefined) => (!symbol || symbol === 'Kraken' ? 'KRAKEN' : 'YAHOO FINANCE');

/** Cierres mensuales guardados, con su origen. */
function monthCloses(month: string) {
  const rows = db.prepare('SELECT h.asset_id, h.price_eur, s.symbol FROM price_history h LEFT JOIN price_symbols s ON s.asset_id = h.asset_id WHERE h.month = ?')
    .all(month) as { asset_id: string; price_eur: string; symbol: string | null }[];
  return new Map(rows.map((r) => [r.asset_id, { eur: D(r.price_eur), source: yahooOrKraken(r.symbol) }]));
}

/** Valor a 31 de diciembre: el cierre de ese mes; el año en curso, con la cotización de hoy. */
function priceAt(year: number): Price {
  const current = Number(today().slice(0, 4));
  if (year >= current) {
    const quotes = storedQuotes();
    return (assetId) => (quotes[assetId]?.priceEur ? { eur: D(quotes[assetId]!.priceEur!), priced: 'quote', source: yahooOrKraken(quotes[assetId]!.symbol) } : null);
  }
  const closes = monthCloses(`${year}-12`);
  return (assetId) => {
    const c = closes.get(assetId);
    return c ? { eur: c.eur, priced: 'close', source: c.source } : null;
  };
}

/** Fecha de la última salida del año, lo que había justo antes y su valor: el de la venta o, si salió sin venderse, el cierre de ese mes. */
function extinction(c: ForeignClosure, start: ForeignHolding | undefined, outflows: Operation[]): ForeignClosure {
  const res = engine();
  const last = outflows.filter((o) => o.assetId === c.assetId && o.broker === c.broker).at(-1);
  const date = last?.datetime.slice(0, 10) ?? null;
  const endQuantity = last?.quantity && D(last.quantity).abs().gt(0) ? Decimal.min(D(last.quantity).abs(), D(c.quantity)) : D(c.quantity);
  const sold = last ? res.disposals.filter((d) => d.opId === last.id && d.assetId === c.assetId && !d.derived) : [];
  let value: Decimal;
  let priceSource: string | null;
  if (sold.length) {
    const soldQty = sold.reduce((s, d) => s.plus(D(d.quantity)), ZERO);
    value = sold.reduce((s, d) => s.plus(D(d.proceedsEur)), ZERO).times(soldQty.gt(0) ? Decimal.min(endQuantity.div(soldQty), D(1)) : D(1));
    priceSource = (BROKER_LABEL[c.broker as Broker] ?? c.broker).toUpperCase();
  } else {
    const close = date ? monthCloses(date.slice(0, 7)).get(c.assetId) : undefined;
    value = close ? endQuantity.times(close.eur) : D(start?.costEur).times(endQuantity.div(D(c.quantity)));
    priceSource = close?.source ?? null;
  }
  return { ...c, date, endQuantity: toStr(endQuantity, 10), valueEur: cents(value), since: start?.since ?? null, priceSource };
}

export function foreignReport(year: number): ForeignReport {
  const res = engine();
  const settings = getSettings();
  const filings = settings.foreignFilings ?? [];
  const estimated = year >= Number(today().slice(0, 4));
  const at = (y: number) => res.snapshots[y] ?? [];
  let outflows: Operation[] | null = null;
  const yearOutflows = () => (outflows ??= calculationOps()
    .filter((o) => o.datetime.startsWith(`${year}-`) && OUTFLOWS.includes(o.kind))
    .sort((a, b) => a.datetime.localeCompare(b.datetime)));
  const forms = (['720', '721'] as ForeignForm[]).map((form): ForeignFormReport => {
    const price = priceAt(year);
    const mine = filings.filter((f) => f.form === form);
    const filed = mine.find((f) => f.year === year) ?? null;
    const lastFiled = mine.filter((f) => f.year < year).sort((a, b) => b.year - a.year)[0] ?? null;
    // Solo lo que entró en la última declaración: se vuelve a declarar como «M».
    const declared = new Set(lastFiled ? holdings(at(lastFiled.year), form, () => null).map(key) : []);
    const items = holdings(at(year), form, price).map((h) => ({ ...h, origin: declared.has(key(h)) ? 'M' as const : 'A' as const }));
    // Las criptomonedas retiradas de un exchange quedan como «externo».
    const outside = form === '721' ? holdings(at(year), form, price, ['externo']) : [];
    const value = items.reduce((s, h) => s.plus(D(h.valueEur)), ZERO);
    const cost = items.reduce((s, h) => s.plus(D(h.costEur)), ZERO);
    let closures: ForeignClosure[] = [];
    if (lastFiled) {
      // Lo que entró en la última declaración y seguía ahí al empezar el año.
      const now = new Set(items.map(key));
      const before = holdings(at(year - 1), form, () => null);
      closures = before
        .filter((h) => declared.has(key(h)) && !now.has(key(h)))
        .map((h) => extinction({ broker: h.broker, assetId: h.assetId, assetName: h.assetName, quantity: h.quantity, class: h.class }, h, yearOutflows()));
    }
    const increase = lastFiled ? value.minus(D(lastFiled.valueEur)) : null;
    const reasons: ForeignFormReport['reasons'] = [];
    if (!lastFiled && value.gt(THRESHOLD)) reasons.push('over50k');
    if (increase?.gt(INCREASE)) reasons.push('increase');
    if (closures.length) reasons.push('closures');
    const report: ForeignFormReport = {
      form, valueEur: cents(value), costEur: cents(cost), holdings: items, closures, lastFiled, filed,
      outside: { valueEur: cents(outside.reduce((s, h) => s.plus(D(h.valueEur)), ZERO)), holdings: outside },
      increaseEur: increase ? cents(increase) : null, required: reasons.length > 0, reasons,
    };
    const inFile = fileItems(report);
    const brokers = [...new Set([...inFile.holdings, ...inFile.closures].map((h) => h.broker))];
    return {
      ...report, onlyClosures: inFile.onlyClosures, missing: missingFor(report, settings, estimated),
      entities: brokers.map((broker) => ({ broker, custodian: custodianFor(form, broker, settings) })),
    };
  });
  return { year, estimated, forms };
}
