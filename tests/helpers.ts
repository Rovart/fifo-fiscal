import { D } from '../shared/decimal.ts';
import { DEFAULT_SETTINGS, type Asset, type Operation, type Settings } from '../shared/types.ts';
import { runEngine } from '../server/engine/fifo.ts';

let n = 0;
export function trade(kind: 'buy' | 'sell', date: string, qty: string, price: string, extra: Partial<Operation> = {}): Operation {
  const gross = D(qty).times(D(price));
  const fee = D(extra.feeEur ?? 0);
  const total = kind === 'buy' ? gross.plus(fee) : gross.minus(fee);
  return {
    id: `op${String(++n).padStart(5, '0')}`, broker: 'degiro', kind, datetime: `${date}T10:00:00`, assetId: 'US0378331005', assetName: 'Apple', assetClass: 'stock',
    quantity: qty, unitPrice: price, currency: 'EUR', fxRate: '1', grossLocal: gross.toFixed(2), grossEur: gross.toFixed(2), feeEur: fee.toFixed(2),
    otherCostsEur: '0', withholdingEur: '0', totalEur: total.toFixed(2), settleCurrency: 'EUR', ...extra,
  };
}

export const ASSETS = new Map<string, Asset>([
  ['US0378331005', { id: 'US0378331005', name: 'Apple', class: 'stock', market: 'eu' }],
  ['USA', { id: 'USA', name: 'Valor de EE. UU.', class: 'stock', market: 'us' }],
]);

export function run(ops: Operation[], settings: Partial<Settings> = {}, rate: (c: string, d: string) => string | null = () => null, today = '2030-01-01') {
  return runEngine({
    ops, assets: ASSETS, settings: { ...DEFAULT_SETTINGS, ...settings },
    rateAt: (c, d) => { const r = rate(c, d); return r ? D(r) : null; }, today,
  });
}
