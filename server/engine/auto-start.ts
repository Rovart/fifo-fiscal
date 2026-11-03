import { D } from '../../shared/decimal.ts';
import { fifoOperations } from '../../shared/fifo-start.ts';
import type { EngineResult, Settings } from '../../shared/types.ts';
import { runEngine, type EngineInput } from './fifo.ts';
import { buildYearReport } from './report.ts';

/** Verifica el inicio del FIFO actual sin retirar ningún resultado histórico. */
export function runAutomaticFifo(input: EngineInput): EngineResult {
  const settings = { ...input.settings, fifoAutoStart: false };
  const original = fifoOperations(input.ops, settings).filter((o) => !o.deleted);
  const ops = original;
  const baseline = runEngine({ ...input, ops, settings });
  const firstYear = Number(ops.map((o) => o.datetime.slice(0, 4)).sort()[0] ?? input.today.slice(0, 4));
  const year = settings.lastFiledYear ? settings.lastFiledYear + 1 : firstYear;
  const preserveFrom = `${year}-01-01`;
  const assets = new Set(ops.filter((o) => o.assetClass !== 'other').flatMap((o) => [o.assetId, ...(['swap', 'isin_change'].includes(o.kind) && o.counterAsset ? [o.counterAsset] : [])]));
  const dates = new Map([...assets].map((id) => [id, preserveFrom]));
  const need = (id: string, date: string) => {
    if (dates.has(id) && date.slice(0, 10) < dates.get(id)!) dates.set(id, date.slice(0, 10));
  };
  for (const l of baseline.openLots) need(l.assetId, l.acqDate);
  const externalAssets = baseline.positions.filter((p) => p.class === 'crypto' && D(p.byBroker.externo ?? 0).gt(0)).map((p) => p.assetId);
  for (const t of baseline.tranches) if (t.status !== 'integrated' || t.date >= preserveFrom) {
    need(t.assetId, t.originDate);
    const sale = baseline.disposals.find((d) => d.id === t.originDisposalId);
    for (const m of sale?.matches ?? []) need(t.assetId, m.acqDate);
  }
  // Un depósito sin coste conocido tampoco puede borrarse si aún queda pendiente.
  for (const t of baseline.unmatchedTransfers ?? []) {
    const first = ops.find((o) => o.assetId === t.assetId);
    if (first) need(t.assetId, first.datetime);
  }
  let previous = '';
  while (previous !== JSON.stringify([...dates])) {
    previous = JSON.stringify([...dates]);
    for (const d of baseline.disposals) {
      if (d.simulated) need(d.assetId, d.date);
      if (!dates.has(d.assetId) || d.date < dates.get(d.assetId)!) continue;
      for (const m of d.matches) need(d.assetId, m.acqDate);
    }
    for (const use of baseline.lotUses ?? []) {
      if (!dates.has(use.assetId) || use.date < dates.get(use.assetId)!) continue;
      for (const date of use.acqDates) need(use.assetId, date);
    }
    for (const o of ops) {
      if (o.kind !== 'isin_change' || !o.counterAsset || !dates.has(o.assetId) || !dates.has(o.counterAsset)) continue;
      const since = [dates.get(o.assetId)!, dates.get(o.counterAsset)!].sort()[0]!;
      if (o.datetime.slice(0, 10) < since) continue;
      need(o.assetId, since); need(o.counterAsset, since);
    }
  }
  const lastYear = Math.max(Number(input.today.slice(0, 4)), ...baseline.years);
  const expected = signature(baseline, preserveFrom, settings, lastYear);
  const recalculate = () => {
    const effective = fifoOperations(original, { ...settings, fifoStartDates: { ...settings.fifoStartDates, ...Object.fromEntries(dates) } });
    const result = runEngine({ ...input, ops: effective, settings });
    return { effective, result, verified: expected === signature(result, preserveFrom, settings, lastYear) };
  };
  let checked = recalculate();
  // Un saldo externo puede necesitar retornos anteriores a sus lotes actuales.
  // Se amplía el historial y se vuelve a comprobar; nunca se da por vendido.
  for (const id of externalAssets) {
    if (checked.verified) break;
    const first = ops.find((o) => o.assetId === id || o.counterAsset === id);
    if (first && first.datetime.slice(0, 10) < dates.get(id)!) { need(id, first.datetime); checked = recalculate(); }
  }
  if (!checked.verified) {
    // Si una regla de valores enlaza un ciclo anterior, conserva sus antecedentes.
    for (const o of ops) if (o.assetClass !== 'crypto') need(o.assetId, o.datetime);
    checked = recalculate();
  }
  const { verified, effective } = checked;
  return {
    ...baseline,
    issues: baseline.issues.map((i) => verified && i.assetId && i.date && i.date < (dates.get(i.assetId) ?? '') ? { ...i, settled: true, affectsFuture: false } : i),
    fifoAuto: { verified, starts: Object.fromEntries(dates), previousOperations: verified ? original.length - effective.filter((o) => o.fifoLeg !== 'cash_only').length : 0, externalAssets },
  };
}

function signature(res: EngineResult, from: string, settings: Settings, lastYear: number) {
  const sort = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort();
  // No confunde unos nanocéntimos/últimos decimales de Kraken con un lote
  // distinto. Además exige que las casillas y resultados fiscales coincidan
  // exactamente al céntimo en todos los ejercicios sin presentar.
  const quantity = (value: string | undefined) => value === undefined ? value : D(value).toDecimalPlaces(8).toFixed();
  const money = (value: string) => D(value).toDecimalPlaces(4).toFixed();
  const tax = [];
  for (let year = Number(from.slice(0, 4)); year <= lastYear; year++) {
    const r = buildYearReport(res, settings, year);
    tax.push([year, r.sections, r.rcm, r.rewards, r.doubleTax, r.doubleTaxDeduction, r.art80Limit,
      r.deferred.generated, r.deferred.released, r.deferred.pendingEnd, r.savings]);
  }
  return JSON.stringify({
    positions: sort(res.positions.filter((p) => D(p.quantity).gt(0)).map((p) => [p.assetId, quantity(p.quantity), money(p.costEur), Object.entries(p.byBroker).map(([b, q]) => [b, quantity(q)]).filter(([, q]) => q !== '0').sort()])),
    lots: sort(res.openLots.map((l) => [l.assetId, l.acqOpId, l.acqDate, quantity(l.quantity), money(l.costEur), quantity(l.blockedQuantity)])),
    pending: sort(res.tranches.filter((t) => t.status !== 'integrated' || t.date >= from).map((t) => [t.assetId, t.originDate, t.date, quantity(t.quantity), money(t.amountEur), t.status, t.windowEnd, t.blockerDate, quantity(t.aheadQty)])),
    disposals: sort(res.disposals.filter((d) => d.date >= from || d.simulated).map((d) => [d.opId, d.date, d.assetId, quantity(d.quantity), money(d.costEur), money(d.proceedsEur), money(d.gainEur), quantity(d.shortfall), d.incomplete, d.clave])),
    incomes: sort(res.incomes.filter((i) => i.date >= from)),
    fees: sort(res.fees.filter((f) => f.date >= from)),
    external: sort(res.unmatchedTransfers ?? []),
    fx: sort(res.fxShorts ?? []),
    tax,
  });
}
