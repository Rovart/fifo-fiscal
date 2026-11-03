import { D, isNum } from './decimal.ts';
import type { EngineResult, Operation, Settings } from './types.ts';

export function effectiveFifoSettings(settings: Settings, result: EngineResult): Settings {
  if (!result.fifoAuto?.verified) return settings;
  const dates = { ...settings.fifoStartDates };
  for (const [id, date] of Object.entries(result.fifoAuto.starts)) dates[id] = [dates[id], date].filter(Boolean).sort().at(-1)!;
  return { ...settings, fifoStartDates: dates };
}

/** Un canje no permite separar los costes del ISIN viejo y del nuevo. */
export function fifoStarts(ops: Operation[], settings: Settings): Map<string, string> {
  const starts = new Map(Object.entries(settings.fifoStartDates ?? {}));
  const cryptoStart = starts.get('CRYPTO:*');
  if (cryptoStart) for (const o of ops) {
    if (o.assetClass !== 'crypto') continue;
    for (const id of [o.assetId, ...(o.kind === 'swap' && o.counterAsset ? [o.counterAsset] : [])]) {
      starts.set(id, [starts.get(id), cryptoStart].filter(Boolean).sort().at(-1)!);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const o of ops) {
      if (o.deleted || o.kind !== 'isin_change' || !o.counterAsset) continue;
      const date = [starts.get(o.assetId), starts.get(o.counterAsset)].filter(Boolean).sort().at(-1);
      if (!date) continue;
      for (const id of [o.assetId, o.counterAsset]) if (starts.get(id) !== date) { starts.set(id, date); changed = true; }
    }
  }
  return starts;
}

export const fifoStartFor = (starts: Map<string, string>, assetId: string) => [starts.get('*'), starts.get(assetId)].filter(Boolean).sort().at(-1);

export function beforeFifoStart(op: Operation, starts: Map<string, string>, assetId = op.assetId) {
  const date = fifoStartFor(starts, assetId);
  return !!date && op.datetime.slice(0, 10) < date;
}

/** Vista de cálculo reversible. Una permuta conserva el lado del otro activo:
 * recortar USDC no puede borrar una compra de BTC pagada con ese USDC. */
export function fifoOperations(ops: Operation[], settings: Settings): Operation[] {
  if (!Object.keys(settings.fifoStartDates ?? {}).length) return ops;
  const starts = fifoStarts(ops, settings);
  return ops.flatMap((o) => {
    const main = beforeFifoStart(o, starts);
    if (o.kind !== 'swap' || !o.counterAsset) {
      if (!main) return [o];
      // Aunque el ciclo cripto esté cerrado, su dinero en otra moneda puede
      // seguir sosteniendo el FIFO de divisas de ejercicios abiertos.
      if (['buy', 'sell', 'dividend', 'interest', 'return_capital'].includes(o.kind) && o.settleCurrency && o.settleCurrency !== 'EUR') return [{ ...o, fifoLeg: 'cash_only' as const, reviewReasons: [] }];
      return [];
    }
    const counter = beforeFifoStart(o, starts, o.counterAsset);
    if (main && counter) return [];
    if (!main && !counter) return [o];
    if (counter) return [{ ...o, kind: 'sell' as const, fifoLeg: 'swap_out' as const }];
    const value = o.grossEur, qty = o.counterQuantity ?? null;
    return [{ ...o, kind: 'buy' as const, fifoLeg: 'swap_in' as const, assetId: o.counterAsset, assetName: o.counterName ?? o.counterAsset,
      quantity: qty, unitPrice: isNum(value) && isNum(qty) && D(qty).gt(0) ? D(value).div(D(qty)).toFixed() : null,
      currency: 'EUR', settleCurrency: 'EUR', fxRate: '1', grossLocal: value, grossEur: value, totalEur: value,
      feeEur: '0', otherCostsEur: '0', withholdingEur: '0', counterAsset: null, counterQuantity: null, counterName: null, reviewReasons: [],
    }];
  });
}
