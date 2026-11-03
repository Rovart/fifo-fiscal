import YahooFinance from 'yahoo-finance2';
import { D, type Decimal } from '../shared/decimal.ts';
import { db, listAssets, rateAt } from './db.ts';
import { engine, priceEur, refreshEcbRates, today } from './service.ts';

export interface Quote { assetId: string; symbol: string | null; currency: string | null; price: string | null; priceEur: string | null; at: string | null; fetchedAt: string | null }

export function storedQuotes(): Record<string, Quote> {
  const rows = db.prepare('SELECT * FROM quotes').all() as { asset_id: string; symbol: string | null; currency: string | null; price: string | null; price_eur: string | null; at: string | null; fetched_at: string | null }[];
  return Object.fromEntries(rows.map((r) => [r.asset_id, { assetId: r.asset_id, symbol: r.symbol, currency: r.currency, price: r.price, priceEur: r.price_eur, at: r.at, fetchedAt: r.fetched_at }]));
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

const searchSymbol = async (query: string, isin: string): Promise<string | null> => (await searchSymbols(query, isin))[0] ?? null;

/** ISIN que el buscador de Yahoo no reconoce y que por nombre darían otra clase de acción. */
const KNOWN: Record<string, string> = { US02079K3059: 'GOOGL', US02079K1079: 'GOOG' };

/** Busca por ISIN y, si Yahoo no lo conoce, por nombre. */
async function resolveSymbol(assetId: string, name: string, klass: string): Promise<string | null> {
  if (klass === 'crypto') return `${assetId}-EUR`;
  if (KNOWN[assetId]) return KNOWN[assetId];
  // Sin ISIN, como en Revolut, el identificador ya es el símbolo.
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(assetId)) return assetId;
  const byIsin = await searchSymbol(assetId, assetId).catch(() => null);
  if (byIsin) return byIsin;
  const clean = name.replace(/\(.*?\)/g, ' ').replace(/\s[-–]\s.*$/, '').trim();
  return clean ? searchSymbol(clean, assetId).catch(() => null) : null;
}

/** Símbolos posibles en orden de preferencia: no todos los que da el buscador tienen histórico. */
export async function symbolCandidates(assetId: string, name: string, klass: string): Promise<string[]> {
  if (klass === 'crypto') return [`${assetId}-EUR`];
  if (KNOWN[assetId]) return [KNOWN[assetId]];
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(assetId)) return [assetId];
  const list = (query: string) => searchSymbols(query, assetId).catch(() => [] as string[]);
  const clean = name.replace(/\(.*?\)/g, ' ').replace(/\s[-–]\s.*$/, '').trim();
  const short = clean.replace(/\s+(UCITS|ETF|ACC|DIST|CLASS)\b.*$/i, '').trim();
  const shorter = short.split(/\s+/).slice(0, 6).join(' ');
  // Lo que el buscador da por ISIN a veces no tiene histórico: el nombre queda como reserva.
  const found = [...(await list(assetId))];
  for (const q of new Set([short, shorter, clean])) {
    if (!q) continue;
    const byName = await list(q);
    found.push(...byName);
    if (byName.length) break;
  }
  // La bolsa principal va primero, venga del ISIN o del nombre.
  const home = HOME[assetId.slice(0, 2)];
  const unique = [...new Set(found)];
  return home ? [...unique.filter((s) => home.test(s)), ...unique.filter((s) => !home.test(s))] : unique;
}

const toEur = (price: Decimal, currency: string): Decimal | null => {
  if (currency === 'EUR') return price;
  const r = rateAt(currency, today());
  return r ? price.div(r) : null;
};

/** Solo se envían a Yahoo ISIN y símbolos, nunca cantidades ni importes. */
export async function refreshQuotes() {
  await refreshEcbRates().catch(() => null);
  const positions = engine().positions.filter((p) => p.class !== 'fx' && D(p.quantity).gt(0));
  const known = storedQuotes();
  const assets = new Map(listAssets().map((a) => [a.id, a]));
  const symbols = new Map<string, string>();
  for (const p of positions) {
    const klass = assets.get(p.assetId)?.class ?? p.class;
    const cached = known[p.assetId]?.symbol;
    const sym = KNOWN[p.assetId] ?? (cached && cached !== 'Kraken' ? cached : await resolveSymbol(p.assetId, p.assetName, klass));
    if (sym) symbols.set(p.assetId, sym);
  }
  const quotes = symbols.size
    ? ((await yf.quote([...new Set(symbols.values())], {}, { validateResult: false })) as unknown as { symbol: string; currency?: string; regularMarketPrice?: number; regularMarketTime?: Date | string | number }[])
    : [];
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  const now = new Date().toISOString();
  const save = db.prepare(`INSERT INTO quotes (asset_id, symbol, currency, price, price_eur, at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(asset_id) DO UPDATE SET symbol = excluded.symbol, currency = excluded.currency, price = excluded.price, price_eur = excluded.price_eur, at = excluded.at, fetched_at = excluded.fetched_at`);
  const missing: string[] = [];
  for (const p of positions) {
    const klass = assets.get(p.assetId)?.class ?? p.class;
    const sym = symbols.get(p.assetId) ?? null;
    const q = sym ? bySymbol.get(sym) : undefined;
    if (q?.regularMarketPrice && q.currency) {
      const price = D(q.regularMarketPrice);
      const eur = toEur(price, q.currency);
      const at = q.regularMarketTime ? new Date(q.regularMarketTime).toISOString() : now;
      save.run(p.assetId, sym, q.currency, price.toFixed(), eur ? eur.toFixed(8) : null, at, now);
      if (!eur) missing.push(p.assetName);
      continue;
    }
    // Criptomonedas que Yahoo no tiene: su último precio en Kraken.
    const kraken = klass === 'crypto' ? await priceEur(p.assetId, now.slice(0, 19)).catch(() => null) : null;
    if (kraken) {
      save.run(p.assetId, 'Kraken', 'EUR', kraken.toDecimalPlaces(8).toFixed(), kraken.toFixed(8), now, now);
    } else {
      save.run(p.assetId, null, null, null, null, null, now);
      missing.push(p.assetName);
    }
  }
  return { updated: positions.length - missing.length, missing, at: now };
}
