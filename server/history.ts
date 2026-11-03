import { D, Decimal, ZERO, cents } from '../shared/decimal.ts';
import type { PerformanceData } from '../shared/types.ts';
import { fifoOperations } from '../shared/fifo-start.ts';
import { db, allOps, getSettings, rateAt } from './db.ts';
import { nextMonth } from './engine/dates.ts';
import { runEngine } from './engine/fifo.ts';
import { computePerformance } from './engine/performance.ts';
import { buildYearReport } from './engine/report.ts';
import { refreshQuotes, storedQuotes, symbolCandidates, yf } from './quotes.ts';
import { assetsMap, today, withAssetMeta } from './service.ts';

function monthlyEngine() {
  const assets = assetsMap();
  const ops = fifoOperations(withAssetMeta(allOps(), assets), getSettings());
  const res = runEngine({ ops, assets, settings: getSettings(), rateAt, today: today(), monthly: true });
  return { ops, res };
}

const lastDay = (month: string) => new Date(Date.parse(`${nextMonth(month)}-01T00:00:00Z`) - 86400000).toISOString().slice(0, 10);

interface Chart {
  meta?: { currency?: string };
  quotes?: { date: Date | string; close?: number | null }[];
  events?: { splits?: { date: Date | string; numerator: number; denominator: number }[] };
}

/** Cierres mensuales en euros. Yahoo ajusta por splits posteriores: se deshace para que case con la cantidad de cada fecha. */
async function monthlyCloses(symbol: string, from: string, to: string): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>();
  // Un activo vendido hace años también tiene precios ajustados por splits de
  // después de la venta. Hay que consultar esos eventos para deshacer el ajuste.
  const through = to > today().slice(0, 7) ? to : today().slice(0, 7);
  const chart = (await yf.chart(symbol, { period1: `${from}-01`, period2: `${nextMonth(through)}-01`, interval: '1mo', events: 'split' }, { validateResult: false }).catch(() => null)) as Chart | null;
  if (!chart?.quotes?.length) return out;
  let currency = chart.meta?.currency ?? 'USD';
  const pence = currency === 'GBp' || currency === 'GBX';
  if (pence) currency = 'GBP';
  const splits = chart.events?.splits ?? [];
  for (const q of chart.quotes) {
    if (q.close === null || q.close === undefined) continue;
    // Las filas van fechadas a principio de mes en la hora de cada bolsa: en UTC pueden caer el día anterior.
    const month = new Date(new Date(q.date).getTime() + 36 * 3600 * 1000).toISOString().slice(0, 7);
    if (month < from || month > to) continue;
    const end = Date.parse(`${nextMonth(month)}-01T00:00:00Z`);
    let px = D(q.close).div(pence ? 100 : 1);
    for (const s of splits) if (new Date(s.date).getTime() >= end && s.denominator) px = px.times(s.numerator).div(s.denominator);
    const rate = currency === 'EUR' ? D(1) : rateAt(currency, lastDay(month));
    if (rate) out.set(month, px.div(rate));
  }
  return out;
}

/** Solo se envían a Yahoo ISIN y símbolos, nunca cantidades ni importes. */
export async function refreshPriceHistory() {
  await refreshQuotes().catch(() => null);
  const { res } = monthlyEngine();
  const ranges = new Map<string, { name: string; klass: string; from: string; to: string; unit: Decimal; months: Set<string> }>();
  for (const month of Object.keys(res.monthly ?? {}).sort()) {
    for (const p of res.monthly?.[month] ?? []) {
      if (p.class === 'fx' || D(p.quantity).lte(0)) continue;
      const r = ranges.get(p.assetId);
      if (r) { r.to = month; r.months.add(month); }
      else ranges.set(p.assetId, { name: p.assetName, klass: p.class, from: month, to: month, unit: D(p.costEur).div(D(p.quantity)), months: new Set([month]) });
    }
  }
  const known = new Map((db.prepare('SELECT asset_id, symbol FROM price_symbols WHERE symbol IS NOT NULL').all() as { asset_id: string; symbol: string }[]).map((r) => [r.asset_id, r.symbol]));
  // El símbolo de la cotización actual ya está comprobado.
  for (const q of Object.values(storedQuotes())) if (q.symbol && q.symbol !== 'Kraken' && !known.has(q.assetId)) known.set(q.assetId, q.symbol);
  const saveSymbol = db.prepare('INSERT INTO price_symbols (asset_id, symbol, fetched_at) VALUES (?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET symbol = excluded.symbol, fetched_at = excluded.fetched_at');
  const savePrice = db.prepare('INSERT INTO price_history (asset_id, month, price_eur) VALUES (?, ?, ?) ON CONFLICT(asset_id, month) DO UPDATE SET price_eur = excluded.price_eur');
  const now = new Date().toISOString();
  const missing: string[] = [];
  const queue = [...ranges.entries()];

  const work = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [assetId, r] = next;
      const remembered = known.get(assetId);
      const candidates = [...new Set([...(remembered ? [remembered] : []), ...await symbolCandidates(assetId, r.name, r.klass)])];
      // Un nombre puede dar otra clase del mismo fondo: el precio debe parecerse al de tu primera compra.
      let chosen: { symbol: string; closes: Map<string, Decimal> } | null = null;
      let coverage = 0;
      for (const symbol of candidates) {
        const closes = await monthlyCloses(symbol, r.from, r.to);
        if (closes.size === 0) continue;
        const first = closes.get(r.from);
        const fits = !first || (first.div(r.unit).gt('0.6') && first.div(r.unit).lt('1.6'));
        const covered = [...r.months].filter((m) => closes.has(m)).length;
        if (fits && covered > coverage) { chosen = { symbol, closes }; coverage = covered; }
        if (coverage === r.months.size) break;
        // Si no coincide con el coste por unidad, no se usa otra clase por parecido de nombre.
      }
      if (chosen) {
        for (const [month, px] of chosen.closes) savePrice.run(assetId, month, px.toFixed(8));
        saveSymbol.run(assetId, chosen.symbol, now);
      } else {
        saveSymbol.run(assetId, null, now);
        // Comprado este mes aún no tiene cierre: basta su cotización de hoy.
        if (!storedQuotes()[assetId]?.priceEur) missing.push(r.name);
      }
    }
  };
  await Promise.all(Array.from({ length: 5 }, work));
  return { assets: ranges.size - missing.length, missing, at: now };
}

export function performance(): PerformanceData {
  const { ops, res } = monthlyEngine();
  const settings = getSettings();
  const rows = db.prepare('SELECT asset_id, month, price_eur FROM price_history').all() as { asset_id: string; month: string; price_eur: string }[];
  const history = new Map(rows.map((r) => [`${r.asset_id}|${r.month}`, D(r.price_eur)]));
  const quotes = storedQuotes();
  const current = (id: string) => (quotes[id]?.priceEur ? D(quotes[id].priceEur) : null);
  const base = computePerformance(res, ops, { monthly: (id, m) => history.get(`${id}|${m}`) ?? null, current }, today());

  // Los años ya presentados no se estiman: lo pagado es lo que dice tu declaración.
  for (const y of base.years) {
    if (!settings.lastFiledYear || y.year > settings.lastFiledYear) y.taxEur = buildYearReport(res, settings, y.year).savings.tax;
  }

  const places = new Map<string, Decimal>();
  for (const p of res.positions) {
    const px = current(p.assetId);
    if (p.class === 'fx' || !px) continue;
    for (const [broker, qty] of Object.entries(p.byBroker)) {
      if (D(qty).gt(0)) places.set(broker, (places.get(broker) ?? ZERO).plus(D(qty).times(px)));
    }
  }
  const fetched = (db.prepare('SELECT MAX(fetched_at) AS at FROM price_symbols').get() as { at: string | null }).at;
  return {
    ...base,
    places: [...places.entries()].map(([broker, v]) => ({ broker, valueEur: cents(v) })).sort((a, b) => D(b.valueEur).minus(D(a.valueEur)).toNumber()),
    hasHistory: rows.length > 0,
    fetchedAt: fetched,
  };
}
