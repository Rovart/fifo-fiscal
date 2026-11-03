import { D } from '../../shared/decimal.ts';
import type { EngineResult, FifoHistory } from '../../shared/types.ts';
import { effectiveFifoSettings, fifoOperations, fifoStartFor } from '../../shared/fifo-start.ts';
import { runEngine, type EngineInput } from './fifo.ts';

/** Dependencias del FIFO que queda abierto, incluidos lotes consumidos después
 * de una compra aún viva y pérdidas de una vuelta anterior del mismo valor. */
export function fifoHistory(input: EngineInput, result = runEngine(input)): FifoHistory {
  const settings = effectiveFifoSettings(input.settings, result);
  const ops = fifoOperations(input.ops, settings).filter((o) => !o.deleted);
  const first = ops.map((o) => o.datetime.slice(0, 10)).sort()[0] ?? null;
  const required = new Map<string, { assetId: string; assetName: string; from: string; deferred: boolean }>();
  const need = (id: string, name: string, date: string, deferred = false) => {
    const from = date.slice(0, 10), old = required.get(id);
    if (!old) required.set(id, { assetId: id, assetName: name, from, deferred });
    else { if (from < old.from) old.from = from; old.deferred ||= deferred; }
  };
  for (const lot of result.openLots) if (D(lot.quantity).gt(0)) need(lot.assetId, lot.assetName, lot.acqDate);
  for (const s of result.fxShorts ?? []) need(`FX:${s.currency}`, s.currency, s.date);
  for (const t of result.tranches) {
    if (t.status === 'integrated') continue;
    need(t.assetId, t.assetName, t.originDate, true);
    const sale = result.disposals.find((d) => d.id === t.originDisposalId);
    for (const m of sale?.matches ?? []) need(t.assetId, t.assetName, m.acqDate, true);
  }
  // Conserva los antecedentes de cada venta que seguiría apareciendo al recortar.
  // También une los ISIN antiguos y nuevos: un canje mantiene el coste original.
  let previous = '';
  while (previous !== JSON.stringify([...required])) {
    previous = JSON.stringify([...required]);
    for (const action of ops.filter((o) => o.kind === 'isin_change' && o.counterAsset)) {
      const a = required.get(action.assetId), b = required.get(action.counterAsset!);
      if (!a && !b) continue;
      const from = [a?.from, b?.from, action.datetime.slice(0, 10)].filter((x): x is string => !!x).sort()[0]!;
      need(action.assetId, action.assetName, from, a?.deferred || b?.deferred);
      need(action.counterAsset!, action.counterName ?? action.counterAsset!, from, a?.deferred || b?.deferred);
    }
    for (const sale of result.disposals) {
      const r = required.get(sale.assetId);
      if (!r || sale.date < r.from) continue;
      for (const m of sale.matches) need(sale.assetId, sale.assetName, m.acqDate, r.deferred);
    }
    for (const use of result.lotUses ?? []) {
      const r = required.get(use.assetId);
      if (!r || use.date < r.from) continue;
      for (const date of use.acqDates) need(use.assetId, r.assetName, date, r.deferred);
    }
  }
  const assets = [...required.values()].sort((a, b) => a.from.localeCompare(b.from) || a.assetName.localeCompare(b.assetName));
  let from = assets[0]?.from ?? null;
  const complete = !result.issues.some((i) => i.severity === 'error' && !i.settled)
    && !result.openLots.some((l) => !l.acqOpId) && !result.unmatchedTransfers?.length;
  if (from && from !== first) {
    // La fecha se ofrece solo si recalcular desde ella reproduce lotes, costes,
    // ubicación y pérdidas pendientes. Las reglas de recompra y divisa también
    // pueden enlazar operaciones que no se ven en los lotes abiertos.
    const replay = runEngine({ ...input, settings: { ...settings, fifoAutoStart: false }, ops: ops.filter((o) => o.datetime.slice(0, 10) >= from!), monthly: false });
    if (fingerprint(replay) !== fingerprint(result)) from = first;
  }
  if (!complete) from = first;
  const held = new Set(result.openLots.map((l) => l.assetId));
  const traded = new Set(ops.filter((o) => ['buy', 'sell', 'swap', 'staking', 'reward'].includes(o.kind)).map((o) => o.assetId));
  const cryptoFrom = input.settings.fifoStartDates?.['CRYPTO:*'] ? fifoStartFor(new Map(Object.entries(input.settings.fifoStartDates)), 'CRYPTO:*') ?? null : null;
  return { from, cryptoFrom, complete, assets, closedAssets: [...traded].filter((id) => !held.has(id) && !required.has(id)).length, auto: result.fifoAuto };
}

function fingerprint(result: EngineResult) {
  const sort = <T,>(rows: T[]) => rows.map((x) => JSON.stringify(x)).sort();
  return JSON.stringify({
    positions: sort(result.positions.map((p) => [p.assetId, p.quantity, p.costEur, Object.entries(p.byBroker).sort()])),
    lots: sort(result.openLots.map((l) => [l.assetId, l.acqDate, l.quantity, l.costEur, l.blockedQuantity, l.acqOpId])),
    pending: sort(result.tranches.filter((t) => t.status !== 'integrated').map((t) => [t.assetId, t.originDate, t.date, t.quantity, t.amountEur, t.status, t.windowEnd, t.blockerDate, t.aheadQty])),
    fxShorts: sort(result.fxShorts ?? []),
    unmatchedTransfers: sort(result.unmatchedTransfers ?? []),
  });
}
