import { D, Decimal, ZERO, cents } from '../shared/decimal.ts';
import type { Broker, ForeignClosure, ForeignForm, ForeignFormReport, ForeignHolding, ForeignReport, Position } from '../shared/types.ts';
import { db, getSettings } from './db.ts';
import { storedQuotes } from './quotes.ts';
import { engine, today } from './service.ts';

/** Brókers que custodian fuera de España cada tipo de activo. Lo que está en una cartera propia no va al 721. */
export const FOREIGN: Record<ForeignForm, { brokers: Broker[]; classes: string[] }> = {
  '720': { brokers: ['degiro', 'trade_republic', 'revolut'], classes: ['stock', 'etf', 'fund', 'bond'] },
  '721': { brokers: ['kraken', 'trade_republic', 'revolut', 'coinbase'], classes: ['crypto'] },
};
const THRESHOLD = D(50000);
const INCREASE = D(20000);

const key = (h: { broker: string; assetId: string }) => `${h.broker}|${h.assetId}`;

type Price = (assetId: string) => { eur: Decimal; priced: ForeignHolding['priced'] } | null;

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
      });
    }
  }
  return out.sort((a, b) => D(b.valueEur).cmp(D(a.valueEur)));
}

/** Valor a 31 de diciembre: el cierre de ese mes; el año en curso, con la cotización de hoy. */
function priceAt(year: number) {
  const current = Number(today().slice(0, 4));
  if (year >= current) {
    const quotes = storedQuotes();
    return (assetId: string) => (quotes[assetId]?.priceEur ? { eur: D(quotes[assetId]!.priceEur!), priced: 'quote' as const } : null);
  }
  const rows = db.prepare('SELECT asset_id, price_eur FROM price_history WHERE month = ?').all(`${year}-12`) as { asset_id: string; price_eur: string }[];
  const closes = new Map(rows.map((r) => [r.asset_id, D(r.price_eur)]));
  return (assetId: string) => (closes.has(assetId) ? { eur: closes.get(assetId)!, priced: 'close' as const } : null);
}

export function foreignReport(year: number): ForeignReport {
  const res = engine();
  const filings = getSettings().foreignFilings ?? [];
  const at = (y: number) => res.snapshots[y] ?? [];
  const forms = (['720', '721'] as ForeignForm[]).map((form): ForeignFormReport => {
    const price = priceAt(year);
    const items = holdings(at(year), form, price);
    // Las criptomonedas retiradas de un exchange quedan como «externo».
    const outside = form === '721' ? holdings(at(year), form, price, ['externo']) : [];
    const value = items.reduce((s, h) => s.plus(D(h.valueEur)), ZERO);
    const cost = items.reduce((s, h) => s.plus(D(h.costEur)), ZERO);
    const mine = filings.filter((f) => f.form === form);
    const filed = mine.find((f) => f.year === year) ?? null;
    const lastFiled = mine.filter((f) => f.year < year).sort((a, b) => b.year - a.year)[0] ?? null;
    let closures: ForeignClosure[] = [];
    if (lastFiled) {
      // Solo lo que entró en la última declaración y seguía ahí al empezar el año.
      const declared = new Set(holdings(at(lastFiled.year), form, () => null).map(key));
      const now = new Set(items.map(key));
      closures = holdings(at(year - 1), form, () => null)
        .filter((h) => declared.has(key(h)) && !now.has(key(h)))
        .map(({ broker, assetId, assetName, quantity }) => ({ broker, assetId, assetName, quantity }));
    }
    const increase = lastFiled ? value.minus(D(lastFiled.valueEur)) : null;
    const reasons: ForeignFormReport['reasons'] = [];
    if (!lastFiled && value.gt(THRESHOLD)) reasons.push('over50k');
    if (increase?.gt(INCREASE)) reasons.push('increase');
    if (closures.length) reasons.push('closures');
    return {
      form, valueEur: cents(value), costEur: cents(cost), holdings: items, closures, lastFiled, filed,
      outside: { valueEur: cents(outside.reduce((s, h) => s.plus(D(h.valueEur)), ZERO)), holdings: outside },
      increaseEur: increase ? cents(increase) : null, required: reasons.length > 0, reasons,
    };
  });
  return { year, estimated: year >= Number(today().slice(0, 4)), forms };
}
