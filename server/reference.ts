import { validIsin } from '../shared/review.ts';
import { yf } from './quotes.ts';
import { securityFor } from './securities.ts';

export interface SecurityReference { symbol: string; isin: string; name: string; source: string }
export interface DividendReference { exDate: string; payDate?: string; amount: string; currency: string; source: string }
export interface SplitReference { date: string; numerator: string; denominator: string; source: string }
export interface MarketReference { securities: SecurityReference[]; dividends: DividendReference[]; splits: SplitReference[]; class?: 'stock' | 'etf' }
interface ChartReferenceData {
  meta: { currency?: string; instrumentType?: string };
  events?: { dividends?: { date: Date; amount: number }[]; splits?: { date: Date; numerator: number; denominator: number }[] };
}

/** Solo interpreta los datos de la respuesta; nunca ejecuta el JavaScript del proveedor. */
export function parseSecurityReferences(text: string, symbol: string): SecurityReference[] {
  const source = `https://markets.businessinsider.com/ajax/SearchController_Suggest?max_results=25&query=${encodeURIComponent(symbol)}`;
  const found = new Map<string, SecurityReference>();
  for (const match of text.matchAll(/new Array\(((?:"(?:[^"\\]|\\.)*"\s*,?\s*)+)\)/g)) {
    let row: string[];
    try { row = JSON.parse(`[${match[1]}]`) as string[]; } catch { continue; }
    if (!['Stocks', 'Funds'].includes(row[1] ?? '')) continue;
    const [ticker, isin] = (row[2] ?? '').split('|');
    if (ticker?.toUpperCase() !== symbol.toUpperCase() || !isin || !validIsin(isin)) continue;
    found.set(isin, { symbol, isin, name: row[0]!, source });
  }
  return [...found.values()];
}

/** iShares publica seis decimales; las series de precios redondean algunos repartos a tres. */
export function parseIsharesDividends(html: string, source: string): DividendReference[] {
  for (const match of html.matchAll(/componentprops="([^"<>]*incomeAmount[^"<>]*)"/g)) {
    let value: { distributionTableData?: { name: string; formattedValue: string[] }[] };
    try { value = JSON.parse(match[1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&')); } catch { continue; }
    const columns = value.distributionTableData;
    if (!columns) continue;
    const column = (name: string) => columns.find((c) => c.name === name)?.formattedValue ?? [];
    const dates = column('exDate'), payments = column('payableDate');
    const amounts = column('totalDistribution'), income = column('incomeAmount');
    if (!dates.length || dates.length !== amounts.length) continue;
    return dates.flatMap((date, i) => {
      // Las fechas del emisor son fechas civiles, no medianoches en la zona del servidor.
      const ex = Date.parse(`${date} UTC`), pay = Date.parse(`${payments[i] ?? ''} UTC`);
      const amount = (amounts[i] ?? '').replace(/[$,]/g, '');
      if (!Number.isFinite(ex) || !/^\d+(\.\d+)?$/.test(amount) || income[i] !== amounts[i]) return [];
      return [{ exDate: new Date(ex).toISOString().slice(0, 10), ...(Number.isFinite(pay) ? { payDate: new Date(pay).toISOString().slice(0, 10) } : {}), amount, currency: 'USD', source }];
    });
  }
  return [];
}

const publicCache = new Map<string, { at: number; value: Promise<MarketReference> }>();
export function marketReference(symbol: string): Promise<MarketReference> {
  const cached = publicCache.get(symbol);
  if (cached && Date.now() - cached.at < 300_000) return cached.value;
  const value = fetchReference(symbol);
  publicCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function fetchReference(symbol: string): Promise<MarketReference> {
  const known = securityFor(symbol);
  const pricingSymbol = known?.symbols[0] ?? symbol;
  const quoteSource = `https://finance.yahoo.com/quote/${encodeURIComponent(pricingSymbol)}/history/`;
  const identitySource = `https://markets.businessinsider.com/ajax/SearchController_Suggest?max_results=25&query=${encodeURIComponent(symbol)}`;
  const isharesSource = 'https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf';
  const results = await Promise.allSettled([
    known ? Promise.resolve([{ symbol, isin: known.isin, name: known.name, source: known.source }]) : fetch(identitySource, { signal: AbortSignal.timeout(15_000) }).then(async (r) => r.ok ? parseSecurityReferences(await r.text(), symbol) : []),
    yf.chart(pricingSymbol, { period1: '2010-01-01', events: 'div,splits' }, { validateResult: false }) as Promise<ChartReferenceData>,
    symbol === 'TLT' ? fetch(isharesSource, { signal: AbortSignal.timeout(15_000) }).then(async (r) => r.ok ? parseIsharesDividends(await r.text(), isharesSource) : []) : Promise.resolve([] as DividendReference[]),
  ] as const);
  const securities = results[0]!.status === 'fulfilled' ? results[0]!.value : [];
  const chart = results[1]!.status === 'fulfilled' ? results[1]!.value : null;
  const precise = results[2]!.status === 'fulfilled' ? results[2]!.value : [];
  const currency = chart?.meta.currency;
  const dividends = precise.length ? precise : currency ? (chart?.events?.dividends ?? []).map((d) => ({ exDate: d.date.toISOString().slice(0, 10), amount: String(d.amount), currency, source: quoteSource })) : [];
  const splits = (chart?.events?.splits ?? []).map((s) => ({ date: s.date.toISOString().slice(0, 10), numerator: String(s.numerator), denominator: String(s.denominator), source: quoteSource }));
  return { securities, dividends, splits, class: known || chart?.meta.instrumentType === 'ETF' ? 'etf' : chart?.meta.instrumentType === 'EQUITY' ? 'stock' : undefined };
}
