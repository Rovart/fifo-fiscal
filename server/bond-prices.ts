import { D, type Decimal } from '../shared/decimal.ts';

// OAT a cupón anual fijo, nominal de 1 EUR y base ACT/ACT.
// https://www.aft.gouv.fr/fr/titre/fr0010070060
export const OAT_2035 = { isin: 'FR0010070060', symbol: 'FR0010070060-MOTX', coupon: '0.0475', maturity: '2035-04-25' };

interface BondPrice { date: string; price: Decimal }

/** Precio por euro nominal, con el cupón corrido a fecha de la cotización. */
export async function oatPrices(period: '1M' | 'max', through: string): Promise<BondPrice[]> {
  const url = `https://live.euronext.com/en/ajax/getChartData/${OAT_2035.symbol}/${period}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) return [];
  const rows: unknown = await response.json();
  if (!Array.isArray(rows)) return [];
  const prices: BondPrice[] = [];
  for (const row of rows as { time?: unknown; price?: unknown }[]) {
    if (typeof row?.time !== 'string' || typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0) continue;
    const date = row.time.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > through || date >= OAT_2035.maturity) continue;
    const at = Date.parse(date);
    if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 10) !== date) continue;
    const couponDay = OAT_2035.maturity.slice(4);
    const year = Number(date.slice(0, 4)) - Number(date.slice(4) < couponDay);
    const last = Date.parse(`${year}${couponDay}`);
    const next = Date.parse(`${year + 1}${couponDay}`);
    const accrued = D(OAT_2035.coupon).times(at - last).div(next - last);
    prices.push({ date, price: D(row.price).div(100).plus(accrued) });
  }
  return prices.sort((a, b) => a.date.localeCompare(b.date));
}
