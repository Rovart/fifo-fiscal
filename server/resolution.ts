import { D, Decimal, cents, isNum } from '../shared/decimal.ts';
import { CONNECTIVITY_FEE, CORPORATE_ACTION, REVOLUT_DIVIDEND, REVOLUT_ISIN, STOCK_SPLIT } from '../shared/review.ts';
import { reconcile } from '../shared/reconcile.ts';
import type { Operation } from '../shared/types.ts';
import { addHistory, allOps, currentProfileId, db, getOp, listAssets, putOp, withProfile } from './db.ts';
import { marketReference, type DividendReference, type MarketReference } from './reference.ts';
import { setAssetIsin, valueImportedCrypto } from './service.ts';

export function heldBefore(ops: Operation[], assetId: string, broker: string, date: string): Decimal {
  let held = D(0);
  for (const op of ops) {
    if (op.deleted || op.broker !== broker || op.datetime.slice(0, 10) >= date) continue;
    if (op.assetId === assetId) {
      if (['buy', 'transfer_in', 'split'].includes(op.kind)) held = held.plus(D(op.quantity));
      if (['sell', 'transfer_out', 'isin_change'].includes(op.kind)) held = held.minus(D(op.quantity));
    }
    if (op.kind === 'isin_change' && op.counterAsset === assetId) held = held.plus(D(op.counterQuantity));
  }
  return held;
}

/** Reconstruye el bruto con el reparto publicado y las acciones con derecho, nunca dividiendo el neto por 0,85. */
export function matchDividend(op: Operation, operations: Operation[], events: DividendReference[]) {
  if (op.kind !== 'dividend' || !isNum(op.grossLocal) || !isNum(op.fxRate) || D(op.fxRate).lte(0)) return null;
  const paid = op.datetime.slice(0, 10), net = D(op.grossLocal);
  const matches = events.flatMap((event) => {
    const elapsed = (Date.parse(paid) - Date.parse(event.exDate)) / 86400000;
    const paymentDelay = event.payDate ? (Date.parse(paid) - Date.parse(event.payDate)) / 86400000 : null;
    if (event.currency !== op.currency || elapsed < 0 || elapsed > 45 || (paymentDelay !== null && (paymentDelay < 0 || paymentDelay > 7))) return [];
    const quantity = heldBefore(operations, op.assetId, op.broker, event.exDate);
    if (quantity.lte(0) || !isNum(event.amount) || D(event.amount).lte(0)) return [];
    const rawGross = quantity.times(event.amount), gross = D(cents(rawGross));
    if (gross.lt(net)) return [];
    // El tipo solo sirve para comprobar la conciliación. El bruto viene de una fuente independiente.
    const consistent = [0, 0.15, 0.30].some((rate) => {
      const afterTax = D(1).minus(rate);
      // Algunos repartos de fondos se publican con 6 decimales y llegan al bróker
      // con 4. Acota ese efecto por acción; nunca amplía el margen sin un límite.
      const precisionGap = D(event.amount).minus(D(event.amount).toDecimalPlaces(4)).abs().times(quantity).times(afterTax);
      const margin = Decimal.min(D('0.05'), D('0.01').plus(precisionGap));
      return rawGross.times(afterTax).minus(net).abs().lte(margin);
    });
    if (!consistent) return [];
    return [{ event, quantity, grossLocal: cents(rawGross), withholdingLocal: cents(gross.minus(net)), precisionGap: D(event.amount).minus(D(event.amount).toDecimalPlaces(4)).abs().times(quantity) }];
  });
  return matches.length === 1 ? matches[0]! : null;
}

function resolvedOperation(before: Operation, reason: string, evidence: NonNullable<Operation['resolutions']>[number], fields: Partial<Operation> = {}): Operation {
  const reviewReasons = before.reviewReasons?.filter((r) => r !== reason);
  return {
    ...before, ...fields, reviewReasons,
    resolutions: [...(before.resolutions ?? []), evidence],
    original: before.original ? { ...before.original, ...fields, reviewReasons: before.original.reviewReasons?.filter((r) => r !== reason) } : before.original,
  };
}

function saveResolution(before: Operation, after: Operation, action: string) {
  db.exec('BEGIN');
  try { putOp(after); addHistory(before.id, action, before, after); db.exec('COMMIT'); }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export async function resolveWarnings(reference: (symbol: string) => Promise<MarketReference> = marketReference) {
  const result = { identities: 0, dividends: 0, corporateActions: 0, fees: 0 };
  const at = new Date().toISOString();
  for (const op of allOps()) {
    if (op.edited || op.kind !== 'fee' || op.feeClass !== 'non_deductible' || !op.reviewReasons?.includes(CONNECTIVITY_FEE)) continue;
    const next = resolvedOperation(op, CONNECTIVITY_FEE, { code: 'fee', at, source: 'import:degiro', detail: 'Comisión de conectividad clasificada como gasto no deducible.' });
    saveResolution(op, next, 'comisión reconocida automáticamente');
    result.fees++;
  }
  const references = new Map<string, MarketReference>();
  const symbolByAsset = new Map((db.prepare('SELECT asset_id, symbol FROM quotes WHERE symbol IS NOT NULL').all() as { asset_id: string; symbol: string }[]).map((q) => [q.asset_id, q.symbol]));
  for (const a of listAssets()) if (a.ticker) symbolByAsset.set(a.id, a.ticker);
  const pending = allOps().filter((o) => !o.edited && o.reviewReasons?.some((r) => [REVOLUT_ISIN, REVOLUT_DIVIDEND, CORPORATE_ACTION, STOCK_SPLIT].includes(r)));
  const symbols = [...new Set(pending.flatMap((op) => {
    const symbol = symbolByAsset.get(op.assetId) ?? (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(op.assetId) ? op.assetId : null);
    return symbol && /^[A-Z0-9][A-Z0-9.-]{0,14}$/.test(symbol) ? [symbol] : [];
  }))];
  for (let start = 0; start < symbols.length; start += 4) {
    await Promise.all(symbols.slice(start, start + 4).map(async (symbol) => {
      try { references.set(symbol, await reference(symbol)); } catch { /* Se conserva el aviso si la fuente no responde. */ }
    }));
  }

  for (const [symbol, ref] of references) {
    const assets = listAssets();
    if (!assets.some((a) => a.id === symbol)) continue;
    const local = ref.securities.filter((s) => assets.some((a) => a.id === s.isin));
    const candidate = ref.securities.length === 1 ? ref.securities[0] : local.length === 1 ? local[0] : null;
    if (!candidate) continue;
    // Una edición manual conserva su identificador y nunca se fusiona por detrás.
    if (allOps(true).some((o) => o.edited && (o.assetId === symbol || o.counterAsset === symbol))) continue;
    setAssetIsin(symbol, candidate.isin, { name: candidate.name, class: ref.class, source: candidate.source });
    result.identities++;
  }
  const assets = new Map(listAssets().map((a) => [a.id, a]));
  for (const a of assets.values()) if (a.ticker) symbolByAsset.set(a.id, a.ticker);

  for (const snapshot of allOps()) {
    const op = getOp(snapshot.id);
    if (!op || op.deleted || op.edited) continue;
    if (op.reviewReasons?.includes(REVOLUT_DIVIDEND)) {
      const symbol = symbolByAsset.get(op.assetId) ?? op.assetId;
      const ref = references.get(symbol);
      if (!ref) continue;
      // Las series históricas pueden ajustar dividendos anteriores a splits posteriores.
      const events = ref.dividends.filter((d) => !ref.splits.some((s) => s.date > d.exDate));
      const match = matchDividend(op, allOps(), events);
      if (!match) continue;
      const grossEur = cents(D(match.grossLocal).div(D(op.fxRate)));
      const netEur = op.totalEur;
      if (!isNum(netEur) || D(grossEur).lt(D(netEur))) continue;
      const next = resolvedOperation(op, REVOLUT_DIVIDEND, {
        code: 'dividend', at, source: match.event.source,
        detail: `${match.event.exDate}: ${match.quantity.toFixed()} × ${match.event.amount} ${op.currency}. Bruto reconstruido ${match.grossLocal}; neto del extracto ${op.grossLocal}. La retención se obtiene por diferencia. Margen de 0,01 ${op.currency}${match.precisionGap.gt(0) ? ` y diferencia de precisión del reparto (4–6 decimales, hasta ${match.precisionGap.toDecimalPlaces(4).toFixed()} ${op.currency})` : ''}.`,
      }, { grossLocal: match.grossLocal, grossEur, withholdingEur: cents(D(grossEur).minus(D(netEur))), totalEur: netEur });
      if (!reconcile(next).ok) continue;
      saveResolution(op, next, 'dividendo conciliado automáticamente con reparto publicado');
      result.dividends++;
    }
    const reason = op.reviewReasons?.find((r) => r === CORPORATE_ACTION || r === STOCK_SPLIT);
    if (!reason) continue;
    const symbol = symbolByAsset.get(op.counterAsset ?? '') ?? symbolByAsset.get(op.assetId);
    const ref = symbol ? references.get(symbol) : null;
    if (!ref || !isNum(op.quantity) || D(op.quantity).lte(0) || !isNum(op.counterQuantity)) continue;
    const event = ref.splits.find((s) => s.date === op.datetime.slice(0, 10) && D(s.denominator).gt(0)
      && D(op.quantity).times(s.numerator).div(s.denominator).minus(D(op.counterQuantity)).abs().lte('0.000001'));
    if (!event) continue;
    const next = resolvedOperation(op, reason, { code: 'corporate_action', at, source: event.source, detail: `Canje ${event.numerator}:${event.denominator}, fecha y cantidades coincidentes con el extracto.` });
    saveResolution(op, next, 'canje verificado automáticamente');
    result.corporateActions++;
  }
  return result;
}

let enabled = false;
const jobs = new Map<string, { running: boolean; at: number; rerun: boolean }>();
export const enableAutoResolution = () => { enabled = true; };
export const resolutionRunning = () => jobs.get(currentProfileId())?.running ?? false;
export function scheduleResolution(force = false) {
  if (!enabled) return;
  const id = currentProfileId();
  const previous = jobs.get(id);
  if (previous?.running) { if (force) previous.rerun = true; return; }
  if (!force && previous && Date.now() - previous.at < 300_000) return;
  const job = { running: true, at: Date.now(), rerun: false };
  jobs.set(id, job);
  void withProfile(id, async () => {
    const resolved = await resolveWarnings();
    if (!allOps().length) return;
    await valueImportedCrypto();
    const { performance, refreshPriceHistory } = await import('./history.ts');
    const prices = performance();
    if (resolved.identities || !prices.hasHistory || prices.missingPrices.now.length) await refreshPriceHistory();
  }).catch((e: unknown) => console.error('No se pudo completar la revisión automática:', (e as Error).message)).finally(() => {
    job.running = false;
    if (job.rerun) withProfile(id, () => scheduleResolution(true));
  });
}
