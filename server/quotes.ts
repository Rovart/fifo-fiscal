import YahooFinance from 'yahoo-finance2';
import { OAT_2035, oatPrices } from './bond-prices.ts';
import { compatiblePriceSymbol, securityFor } from './securities.ts';
import { D, Decimal } from '../shared/decimal.ts';
import { allOps, db, listAssets, rateAt } from './db.ts';
import { engine, priceEur, refreshEcbRates, today } from './service.ts';

export interface Quote { assetId: string; symbol: string | null; currency: string | null; price: string | null; priceEur: string | null; at: string | null; fetchedAt: string | null }

export function storedQuotes(): Record<string, Quote> {
  const rows = db.prepare('SELECT * FROM quotes').all() as { asset_id: string; symbol: string | null; currency: string | null; price: string | null; price_eur: string | null; at: string | null; fetched_at: string | null }[];
  return Object.fromEntries(rows.filter((r) => compatiblePriceSymbol(r.asset_id, r.symbol))
    .map((r) => [r.asset_id, { assetId: r.asset_id, symbol: r.symbol, currency: r.currency, price: r.price, priceEur: r.price_eur, at: r.at, fetchedAt: r.fetched_at }]));
}

export const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

/** Bolsa preferida según el país del ISIN, para no quedarse con una cotización secundaria. */
const HOME: Record<string, RegExp> = {
  AU: /\.AX$/, US: /^[A-Z-]+$/, KY: /^[A-Z-]+$/, BM: /\.HK$|^[A-Z-]+$/, DE: /\.DE$/, ES: /\.MC$/, FR: /\.PA$/, NL: /\.AS$/, BE: /\.BR$/, IT: /\.MI$/, PT: /\.LS$/, LU: /\.AS$|\.PA$/,
  SE: /\.ST$/, DK: /\.CO$/, NO: /\.OL$/, FI: /\.HE$/, GB: /\.L$/, CH: /\.SW$/, IE: /\.L$|\.DE$|\.AS$/, HK: /\.HK$/, JP: /\.T$/, CA: /\.TO$/,
};

async function searchSymbols(query: string, isin: string): Promise<string[]> {
  const res = (await yf.search(query, { quotesCount: 8, newsCount: 0 }, { validateResult: false })) as { quotes?: { symbol?: string; quoteType?: string; isYahooFinance?: boolean }[] };
  const list = (res.quotes ?? []).filter((q) => q.symbol && q.isYahooFinance !== false && (!q.quoteType || ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType))).map((q) => q.symbol as string);
  const home = HOME[isin.slice(0, 2)];
  return home ? [...list.filter((x) => home.test(x)), ...list.filter((x) => !home.test(x))] : list;
}

/** Clases de Alphabet que el buscador confunde por nombre. */
const KNOWN: Record<string, string> = { US02079K3059: 'GOOGL', US02079K1079: 'GOOG' };

/** Símbolos posibles en orden de preferencia: no todos los que da el buscador tienen histórico. */
export async function symbolCandidates(assetId: string, name: string, klass: string): Promise<string[]> {
  // Yahoo no cotiza en euros todos los tokens (stETH solo en dólares): el dólar pasa a euros al cambio del BCE.
  if (klass === 'crypto') return [`${assetId}-EUR`, `${assetId}-USD`];
  if (KNOWN[assetId]) return [KNOWN[assetId]];
  const verified = securityFor(assetId);
  if (verified) return verified.symbols;
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(assetId)) {
    // Un ticker europeo suele necesitar el sufijo de su bolsa. Solo acepta el
    // mismo ticker exacto: el buscador también devuelve valores parecidos.
    const found = await searchSymbols(assetId, '').catch(() => [] as string[]);
    return [...new Set([assetId, ...found.filter((s) => s.split('.')[0] === assetId)])];
  }
  const list = (query: string) => searchSymbols(query, assetId).catch(() => [] as string[]);
  const clean = name.replace(/\(.*?\)/g, ' ').replace(/\s[-–]\s.*$/, '').trim();
  const short = clean.replace(/\s+(UCITS|ETF|ACC|DIST|CLASS)\b.*$/i, '').trim();
  const shorter = short.split(/\s+/).slice(0, 6).join(' ');
  // Lo que el buscador da por ISIN a veces no tiene histórico: el nombre queda como reserva.
  const byIsin = await list(assetId);
  const byName: string[] = [];
  for (const q of new Set([short, shorter, clean])) {
    if (!q) continue;
    const found = await list(q);
    byName.push(...found);
    if (found.length) break;
  }
  // Lo que da el ISIN es ese valor; por nombre puede salir otra clase del mismo fondo, así que va detrás.
  // Dentro de cada grupo, la bolsa principal primero.
  const home = HOME[assetId.slice(0, 2)];
  const byHome = (list: string[]) => (home ? [...list.filter((s) => home.test(s)), ...list.filter((s) => !home.test(s))] : list);
  return [...new Set([...byHome(byIsin), ...byHome(byName)])];
}

/** Último precio al que operaste un activo, en euros por unidad y sin comisiones. */
function lastTrade(assetId: string): { date: string; eur: Decimal } | null {
  const last = allOps()
    .filter((o) => o.assetId === assetId && (o.kind === 'buy' || o.kind === 'sell') && D(o.quantity).abs().gt(0) && D(o.grossEur).abs().gt(0))
    .sort((a, b) => b.datetime.localeCompare(a.datetime))[0];
  return last ? { date: last.datetime.slice(0, 10), eur: D(last.grossEur).abs().div(D(last.quantity).abs()) } : null;
}

interface DailyChart {
  meta?: { currency?: string };
  quotes?: { date: Date | string; low?: number | null; high?: number | null }[];
  events?: { splits?: { date: Date | string; numerator: number; denominator: number }[] };
}
const TRADE_WINDOW_DAYS = 400;
const checked = new Map<string, boolean>();

/**
 * ¿Cotizaba el símbolo cerca de tu última compra o venta a un precio parecido al que pagaste o cobraste?
 * Descarta otra clase del mismo fondo (acumulación y distribución) o un valor con el mismo nombre.
 * A Yahoo solo se le pide el último año del símbolo, nunca la fecha ni el importe de la operación.
 * Sin operación reciente ni cotizaciones con que comparar, no se descarta.
 */
export async function fitsLastTrade(symbol: string, assetId: string): Promise<boolean> {
  const trade = lastTrade(assetId);
  const start = Date.parse(`${today()}T12:00:00Z`) - TRADE_WINDOW_DAYS * 864e5;
  if (!trade || Date.parse(`${trade.date}T12:00:00Z`) < start) return true;
  const key = `${symbol}|${assetId}|${trade.date}|${trade.eur.toFixed(4)}`;
  const known = checked.get(key);
  if (known !== undefined) return known;
  let chart: DailyChart | null = null;
  try { chart = (await yf.chart(symbol, { period1: new Date(start), interval: '1d', events: 'split' }, { validateResult: false })) as DailyChart; } catch { return true; }
  if (!chart?.quotes?.length) return true;
  let currency = chart.meta?.currency ?? 'USD';
  const pence = currency === 'GBp' || currency === 'GBX';
  if (pence) currency = 'GBP';
  const splits = chart.events?.splits ?? [];
  const at = Date.parse(`${trade.date}T12:00:00Z`);
  let low: Decimal | null = null, high: Decimal | null = null;
  for (const q of chart.quotes) {
    const t = new Date(q.date).getTime();
    if (Math.abs(t - at) > 4 * 864e5 || !q.low || !q.high) continue;
    const day = new Date(t).toISOString().slice(0, 10);
    const rate = currency === 'EUR' ? D(1) : rateAt(currency, day);
    if (!rate) continue;
    // Yahoo ajusta por splits posteriores: se deshace para comparar con lo que pagaste ese día.
    let factor = D(pence ? '0.01' : 1);
    for (const sp of splits) if (new Date(sp.date).getTime() > t && sp.denominator) factor = factor.times(sp.numerator).div(sp.denominator);
    const lo = D(q.low).times(factor).div(rate), hi = D(q.high).times(factor).div(rate);
    low = low ? Decimal.min(low, lo) : lo;
    high = high ? Decimal.max(high, hi) : hi;
  }
  const fits = !low || !high || (trade.eur.gte(low.times('0.96')) && trade.eur.lte(high.times('1.04')));
  checked.set(key, fits);
  return fits;
}

const toEur = (price: Decimal, currency: string): Decimal | null => {
  if (currency === 'EUR') return price;
  const r = rateAt(currency, today());
  return r ? price.div(r) : null;
};

/** A los proveedores solo se envían ISIN y símbolos. */
export async function refreshQuotes() {
  await refreshEcbRates().catch(() => null);
  const positions = engine().positions.filter((p) => p.class !== 'fx' && D(p.quantity).gt(0));
  const known = storedQuotes();
  const assets = new Map(listAssets().map((a) => [a.id, a]));
  const now = new Date().toISOString();
  const save = db.prepare(`INSERT INTO quotes (asset_id, symbol, currency, price, price_eur, at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id) DO UPDATE SET symbol = excluded.symbol, currency = excluded.currency, price = excluded.price, price_eur = excluded.price_eur, at = excluded.at, fetched_at = excluded.fetched_at`);
  const missing: string[] = [];
  const queue = [...positions];
  const work = async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      const klass = assets.get(p.assetId)?.class ?? p.class;
      const cached = known[p.assetId];
      if (p.assetId === OAT_2035.isin) {
        const latest = (await oatPrices('1M', today()).catch(() => [])).at(-1);
        if (latest) save.run(p.assetId, 'Euronext MOT', 'EUR', latest.price.toFixed(8), latest.price.toFixed(8), latest.date, now);
        else missing.push(p.assetName);
        continue;
      }
      const candidates = [...new Set([
        ...(cached?.priceEur && cached.symbol && cached.symbol !== 'Kraken' ? [cached.symbol] : []),
        ...await symbolCandidates(p.assetId, p.assetName, klass),
      ])];
      let found = false;
      let wrongCached = false;
      for (const sym of candidates) {
        const q = await yf.quote(sym, {}, { validateResult: false }).catch(() => null);
        if (!q?.regularMarketPrice || !q.currency) continue;
        if (!(await fitsLastTrade(sym, p.assetId))) {
          if (sym === cached?.symbol) wrongCached = true;
          continue;
        }
        const pence = q.currency === 'GBp' || q.currency === 'GBX';
        const currency = pence ? 'GBP' : q.currency;
        const price = D(q.regularMarketPrice).div(pence ? 100 : 1);
        const eur = toEur(price, currency);
        const at = q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : now;
        save.run(p.assetId, sym, currency, price.toFixed(), eur ? eur.toFixed(8) : null, at, now);
        if (!eur) missing.push(p.assetName);
        found = true;
        break;
      }
      if (found) continue;
      // Criptomonedas que Yahoo no tiene: su último precio en Kraken.
      const kraken = klass === 'crypto' ? await priceEur(p.assetId, now.slice(0, 19)).catch(() => null) : null;
      if (kraken) {
        save.run(p.assetId, 'Kraken', 'EUR', kraken.toDecimalPlaces(8).toFixed(), kraken.toFixed(8), now, now);
      } else {
        // Un fallo puntual del proveedor no borra una cotización ya disponible; la de otra clase, sí.
        if (!known[p.assetId]?.priceEur || wrongCached) save.run(p.assetId, null, null, null, null, null, now);
        missing.push(p.assetName);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, work));
  return { updated: positions.length - missing.length, missing, at: now };
}
