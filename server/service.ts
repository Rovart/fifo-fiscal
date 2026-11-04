import { createHash, randomUUID } from 'node:crypto';
import { D, Decimal, cents, toStr } from '../shared/decimal.ts';
import { applyEdit, expectedTotal, reconcile } from '../shared/reconcile.ts';
import { REVOLUT_ISIN } from '../shared/review.ts';
import { effectiveFifoSettings, fifoOperations, fifoStartFor, fifoStarts } from '../shared/fifo-start.ts';
import type { Asset, AssetClass, Broker, Market, Operation, Settings , Disposal, SaleSimulation, SalesSimulation } from '../shared/types.ts';
import {
  addHistory, allOps, bump, currentProfileId, db, getOp, getSettings, hasSourceKey, insertRates, latestRateDate, listAssets, putOp, rateAt, rev, saveAsset, saveSettings,
} from './db.ts';
import { runEngine } from './engine/fifo.ts';
import { buildYearReport, issuesForYear, type YearReport } from './engine/report.ts';
import { addMonths } from './engine/dates.ts';
import { krakenAsset } from './importers/kraken.ts';
import { baseOp, review } from './importers/common.ts';
import { parseFile, type Coverage, type ParsedImport } from './importers/index.ts';

export const today = (): string => new Date().toISOString().slice(0, 10);

export function assetsMap(): Map<string, Asset> {
  return new Map(listAssets().map((a) => [a.id, a]));
}

/** Cada ISIN se muestra con un solo nombre, venga del bróker que venga, y con su clase guardada. */
export const withAssetMeta = (ops: Operation[], assets: Map<string, Asset>): Operation[] =>
  ops.map((o) => {
    const a = assets.get(o.assetId);
    const assetClass = a?.class ?? o.assetClass;
    const assetName = a?.name || o.assetName;
    const counterName = (o.counterAsset && assets.get(o.counterAsset)?.name) || o.counterName;
    return assetClass === o.assetClass && assetName === o.assetName && counterName === o.counterName ? o : { ...o, assetClass, assetName, counterName };
  });

/** Cómo llama cada bróker a un activo cuando no se reconoce en el nombre que se muestra. */
export function brokerNames(): Record<string, { broker: Broker; name: string }[]> {
  const assets = assetsMap();
  const plain = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const out: Record<string, { broker: Broker; name: string }[]> = {};
  for (const o of allOps()) {
    const shown = assets.get(o.assetId)?.name;
    if (!shown || !o.assetName || plain(shown).includes(plain(o.assetName)) || plain(o.assetName).includes(plain(shown))) continue;
    const list = (out[o.assetId] ??= []);
    if (!list.some((x) => x.broker === o.broker && x.name === o.assetName)) list.push({ broker: o.broker, name: o.assetName });
  }
  return out;
}

let cache: { profile: string; rev: number; date: string; result: ReturnType<typeof runEngine> } | null = null;

export function engine() {
  const date = today();
  if (cache?.profile === currentProfileId() && cache.rev === rev() && cache.date === date) return cache.result;
  const assets = assetsMap();
  const result = runEngine({ ops: withAssetMeta(allOps(), assets), assets, settings: getSettings(), rateAt, today: date });
  cache = { profile: currentProfileId(), rev: rev(), date, result };
  return result;
}

export const report = (year: number): YearReport => buildYearReport(engine(), getSettings(), year);

export const calculationOps = () => fifoOperations(withAssetMeta(allOps(), assetsMap()), effectiveFifoSettings(getSettings(), engine()));

// ---- Importación ----
export interface ImportPreview {
  broker: string;
  format: string;
  rows: number;
  newOps: number;
  duplicates: number;
  warnings: string[];
  ignored: Record<string, number>;
  needsReview: number;
  needsValue: number;
  kinds: Record<string, number>;
  sample: Operation[];
  costs: number;
  from: string | null;
  to: string | null;
}

const isIsin = (id: string) => /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(id);
const NEEDS_ISIN = REVOLUT_ISIN;

/** Un símbolo puede conservarse después de un canje: importa el ISIN vigente en cada fecha. */
export function isinAtDate(isin: string, datetime: string, operations = allOps()): string {
  let id = isin;
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const action = operations.find((o) => o.kind === 'isin_change' && o.counterAsset === id && o.datetime > datetime);
    if (!action) break;
    id = action.assetId;
  }
  return id;
}

/**
 * Revolut identifica por símbolo y el FIFO es por ISIN: se une si ya se conoce esa pareja,
 * por una elección anterior o por el símbolo con el que se consulta su precio.
 */
function linkTickers(parsed: ParsedImport) {
  if (parsed.broker !== 'revolut') return;
  const known = new Map<string, Asset>();
  const assets = assetsMap();
  for (const a of assets.values()) if (a.ticker && isIsin(a.id)) known.set(a.ticker, a);
  const quoted = db.prepare('SELECT asset_id, symbol FROM quotes').all() as { asset_id: string; symbol: string | null }[];
  for (const q of quoted) {
    const a = assets.get(q.asset_id);
    if (a && q.symbol && isIsin(a.id) && !known.has(q.symbol)) known.set(q.symbol, a);
  }
  const flagged = new Set<string>();
  const operations = allOps();
  for (const op of parsed.ops) {
    if (op.assetClass === 'crypto' || !['buy', 'sell', 'dividend', 'split'].includes(op.kind)) continue;
    const a = known.get(op.assetId);
    if (a) {
      if (parsed.markets[op.assetId]) { parsed.markets[a.id] = parsed.markets[op.assetId] as Market; delete parsed.markets[op.assetId]; }
      op.assetId = isinAtDate(a.id, op.datetime, operations);
      op.assetName = assets.get(op.assetId)?.name ?? a.name;
    } else if (!isIsin(op.assetId) && !assets.has(op.assetId) && !flagged.has(op.assetId)) {
      flagged.add(op.assetId);
      review(op, NEEDS_ISIN);
    }
  }
}

/** Pasa todos los movimientos de un símbolo a su ISIN. */
export function setAssetIsin(oldId: string, isinRaw: string, reference?: { name: string; class?: AssetClass; source: string }) {
  const isin = isinRaw.trim().toUpperCase();
  if (!isIsin(isin)) throw new ValidationError('Eso no parece un ISIN: son 12 caracteres, como US0378331005.', null);
  if (oldId === isin) return;
  const assets = assetsMap();
  const asset = assets.get(oldId);
  if (!asset) throw new ValidationError('Activo no encontrado.', null);
  const operations = allOps(true);
  db.exec('BEGIN');
  try {
    for (const op of operations) {
      if (op.assetId !== oldId && op.counterAsset !== oldId) continue;
      const next: Operation = { ...op, reviewReasons: op.reviewReasons?.filter((r) => r !== NEEDS_ISIN) };
      const datedIsin = isinAtDate(isin, op.datetime, operations.filter((o) => !o.deleted));
      if (op.assetId === oldId) next.assetId = datedIsin;
      if (op.counterAsset === oldId) next.counterAsset = datedIsin;
      if (op.original) next.original = {
        ...op.original,
        ...(op.original.assetId === oldId ? { assetId: datedIsin } : {}),
        ...(op.original.counterAsset === oldId ? { counterAsset: datedIsin } : {}),
        reviewReasons: op.original.reviewReasons?.filter((r) => r !== NEEDS_ISIN),
      };
      if (reference) next.resolutions = [...(op.resolutions ?? []), { code: 'isin', at: new Date().toISOString(), source: reference.source, detail: `${oldId} → ${datedIsin}` }];
      addHistory(op.id, `ISIN ${isin} en lugar de ${oldId}`, op, next);
      putOp(next);
    }
    saveAsset({ ...(assets.get(isin) ?? { ...asset, id: isin, name: reference?.name || asset.name, class: reference?.class ?? asset.class }), ticker: oldId });
    // Solo traslada precios si no hay un cambio de unidad/ISIN entre medias.
    // Las series de un símbolo actual no son la cotización del ISIN anterior a un canje.
    const changedUnits = operations.some((o) => o.kind === 'isin_change' && (o.assetId === isin || o.counterAsset === isin));
    if (!changedUnits) {
      db.prepare('INSERT OR IGNORE INTO quotes SELECT ?, symbol, currency, price, price_eur, at, fetched_at FROM quotes WHERE asset_id = ?').run(isin, oldId);
      db.prepare('INSERT OR IGNORE INTO price_history SELECT ?, month, price_eur FROM price_history WHERE asset_id = ?').run(isin, oldId);
      db.prepare('INSERT OR IGNORE INTO price_symbols SELECT ?, symbol, fetched_at FROM price_symbols WHERE asset_id = ?').run(isin, oldId);
    }
    db.prepare('DELETE FROM quotes WHERE asset_id = ?').run(oldId);
    db.prepare('DELETE FROM price_history WHERE asset_id = ?').run(oldId);
    db.prepare('DELETE FROM price_symbols WHERE asset_id = ?').run(oldId);
    db.prepare('DELETE FROM assets WHERE id = ?').run(oldId);
    const settings = getSettings();
    const dates = { ...settings.fifoStartDates };
    if (dates[oldId]) {
      dates[isin] = [dates[isin], dates[oldId]].filter(Boolean).sort().at(-1)!;
      delete dates[oldId];
      saveSettings({ ...settings, fifoStartDates: dates });
    }
    db.exec('COMMIT');
    bump();
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Periodo de cada exchange con extracto propio: CoinTracking no lo duplica. */
function nativeCoverage(): Coverage {
  const range = db.prepare('SELECT broker, MIN(datetime) AS "from", MAX(datetime) AS "to" FROM operations WHERE deleted = 0 AND broker IN (?, ?) GROUP BY broker').all('kraken', 'coinbase') as { broker: Broker; from: string; to: string }[];
  return Object.fromEntries(range.map((r) => [r.broker, { from: r.from, to: r.to }]));
}

export function previewImport(text: string): { parsed: ParsedImport; preview: ImportPreview } {
  const parsed = parseFile(text, rateAt, nativeCoverage());
  linkTickers(parsed);
  const from = parsed.ops.map((o) => o.datetime).sort()[0], to = parsed.ops.map((o) => o.datetime).sort().at(-1);
  const label = { kraken: 'Kraken', coinbase: 'Coinbase' }[parsed.broker as string];
  const overlap = label && from && to ? allOps().filter((o) => o.broker === 'cointracking' && o.sourceExchange?.toLowerCase().startsWith(label.toLowerCase()) && o.datetime >= from && o.datetime <= to).length : 0;
  if (overlap) parsed.warnings.push(`CoinTracking ya trae ${overlap === 1 ? '1 movimiento' : `${overlap} movimientos`} de ${label} de estas fechas. Borra ese documento y vuelve a añadirlo después de este: así no se duplican.`);
  const fresh = parsed.ops.filter((o) => !o.sourceKey || !hasSourceKey(o.sourceKey));
  const kinds: Record<string, number> = {};
  for (const o of fresh) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  return {
    parsed,
    preview: {
      broker: parsed.broker, format: parsed.format, rows: parsed.rows, newOps: fresh.length, duplicates: parsed.ops.length - fresh.length,
      warnings: parsed.warnings, ignored: parsed.ignored, needsReview: fresh.filter((o) => o.reviewReasons?.length).length,
      needsValue: fresh.filter((o) => !o.grossEur && !['split', 'isin_change', 'transfer_in', 'transfer_out'].includes(o.kind)).length,
      kinds, sample: fresh.slice(0, 8), costs: parsed.pendingCosts.length,
      from: parsed.ops.map((o) => o.datetime.slice(0, 10)).sort()[0] ?? null,
      to: parsed.ops.map((o) => o.datetime.slice(0, 10)).sort().at(-1) ?? null,
    },
  };
}

const COST_PREFIX = 'dg-itf:';

function attachCost(target: Operation, amount: Decimal, label: string, key: string, importId: string): Operation {
  const next: Operation = {
    ...target,
    otherCostsEur: cents(D(target.otherCostsEur).plus(amount)),
    appliedCosts: [...(target.appliedCosts ?? []), { key, amountEur: amount.toFixed(), importId }],
  };
  next.totalEur = cents(expectedTotal(next));
  next.note = [target.note, label].filter(Boolean).join(' · ');
  if (target.original) next.original = { ...target.original, otherCostsEur: next.otherCostsEur, totalEur: next.totalEur };
  addHistory(target.id, 'coste asociado', target, next);
  putOp(next);
  return next;
}

/** Cuenta el ITF, TTF o stamp duty como mayor coste o menor valor de la operación a la que pertenece. */
function resolveCosts(parsed: Pick<ParsedImport, 'pendingCosts'>, importId: string, ops: Operation[]) {
  let attached = 0, orphan = 0;
  const trades = ops.filter((o) => o.kind === 'buy' || o.kind === 'sell');
  const isLegacyApplied = db.prepare('SELECT 1 FROM applied_costs WHERE key = ?');

  for (const c of parsed.pendingCosts) {
    if (isLegacyApplied.get(c.sourceKey) || hasSourceKey(c.sourceKey)) continue;
    const target = (c.orderRef && trades.find((t) => t.orderRef === c.orderRef)) ||
      trades.find((t) => t.assetId === c.assetId && t.datetime.slice(0, 10) === c.datetime.slice(0, 10));
    if (target?.appliedCosts?.some((x) => x.key === c.sourceKey)) continue;
    if (target) {
      const updated = attachCost(target, D(c.amountEur), c.label, c.sourceKey, importId);
      trades[trades.indexOf(target)] = updated;
      attached++;
    } else {
      const op = baseOp({ broker: 'degiro', kind: 'fee', datetime: c.datetime, assetId: c.assetId || 'DEGIRO', assetName: c.assetName || 'DEGIRO', assetClass: 'other', sourceKey: c.sourceKey, note: c.label });
      op.importId = importId;
      op.feeClass = 'non_deductible';
      op.orderRef = c.orderRef;
      op.grossLocal = cents(D(c.amountEur));
      op.grossEur = op.grossLocal;
      op.totalEur = op.grossLocal;
      review(op, 'Tributo de la operación sin compra o venta asociada: importa Transactions para sumarlo a su coste.');
      op.original = { ...op };
      putOp(op);
      orphan++;
    }
  }

  // Tributos importados antes que su operación.
  for (const fee of allOps().filter((o) => o.kind === 'fee' && o.sourceKey?.startsWith(COST_PREFIX))) {
    const target = (fee.orderRef && trades.find((t) => t.orderRef === fee.orderRef)) ||
      trades.find((t) => t.assetId === fee.assetId && t.datetime.slice(0, 10) === fee.datetime.slice(0, 10));
    if (!target) continue;
    const updated = attachCost(target, D(fee.grossEur), fee.note ?? 'Tributo', fee.sourceKey as string, fee.importId ?? importId);
    trades[trades.indexOf(target)] = updated;
    putOp({ ...fee, deleted: true });
    db.prepare('UPDATE operations SET source_key = NULL WHERE id = ?').run(fee.id);
    addHistory(fee.id, 'tributo asociado a su operación', fee, null);
    attached++;
  }
  return { attached, orphan };
}

export function commitImport(file: string, text: string) {
  const { parsed, preview } = previewImport(text);
  const hash = createHash('sha256').update(text).digest('hex');
  const existing = db.prepare('SELECT id FROM imports WHERE content_hash = ? AND file = ?').get(hash, file) as { id: string } | undefined;
  if (existing) return { importId: existing.id, ...preview, newOps: 0, sample: undefined, costsAttached: 0, costsOrphan: 0, alreadyImported: true };
  const importId = randomUUID();
  const assets = assetsMap();
  const fresh = parsed.ops.filter((o) => !o.sourceKey || !hasSourceKey(o.sourceKey));
  db.exec('BEGIN');
  try {
    for (const op of fresh) {
      op.importId = importId;
      op.original = { ...op, original: undefined };
      putOp(op);
      registerAsset(assets, op.assetId, op.assetName, op.assetClass, parsed.markets[op.assetId]);
      if (op.counterAsset && op.kind !== 'fx') registerAsset(assets, op.counterAsset, op.counterName ?? op.counterAsset, op.assetClass, parsed.markets[op.counterAsset]);
      addHistory(op.id, 'importada', null, op);
    }
    const costs = resolveCosts(parsed, importId, allOps());
    db.prepare('INSERT INTO imports (id, at, file, broker, format, summary, content_hash, costs, balances) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(importId, new Date().toISOString(), file, parsed.broker, parsed.format, JSON.stringify({ ...preview, sample: undefined, costs }), hash, JSON.stringify(parsed.pendingCosts), JSON.stringify(parsed.balances));
    // Recuerda también los duplicados omitidos: otra fuente puede conservar el movimiento.
    const link = db.prepare('INSERT OR IGNORE INTO import_operations (import_id, op_id) SELECT ?, id FROM operations WHERE source_key = ?');
    for (const op of parsed.ops) if (op.sourceKey) link.run(importId, op.sourceKey);
    for (const cost of parsed.pendingCosts) link.run(importId, cost.sourceKey);
    rebuildImportedBalances(parsed.broker);
    db.exec('COMMIT');
    bump();
    return { importId, ...preview, sample: undefined, costsAttached: costs.attached, costsOrphan: costs.orphan };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function registerAsset(assets: Map<string, Asset>, id: string, name: string, klass: AssetClass, market?: Market) {
  if (!id) return;
  const prev = assets.get(id);
  if (prev) {
    if (market && !prev.marketByUser && prev.market !== market && prev.market === 'eu') {
      const next = { ...prev, market };
      assets.set(id, next);
      saveAsset(next);
    }
    return;
  }
  const a: Asset = { id, name, class: klass, market: market ?? (klass === 'crypto' || klass === 'other' ? 'other' : 'eu') };
  assets.set(id, a);
  saveAsset(a);
}

export function listImports() {
  const rows = db.prepare(`SELECT i.id, i.at, i.file, i.broker, i.format, i.summary,
    (SELECT COUNT(*) FROM import_operations io JOIN operations o ON o.id = io.op_id WHERE io.import_id = i.id AND o.deleted = 0) AS operations
    FROM imports i ORDER BY i.at DESC, i.rowid DESC`).all() as unknown as { id: string; at: string; file: string; broker: Broker; format: string; summary: string; operations: number }[];
  return rows.map((r) => ({ ...r, summary: JSON.parse(r.summary) as Omit<ImportPreview, 'sample' | 'costs'> & { costs: { attached: number; orphan: number } } }));
}

function rebuildImportedBalances(broker: string) {
  db.prepare("DELETE FROM balances WHERE broker = ? AND source = 'import'").run(broker);
  const upsert = db.prepare(`INSERT INTO balances (broker, asset_id, quantity, as_of, source) VALUES (?, ?, ?, ?, 'import')
    ON CONFLICT(broker, asset_id) DO UPDATE SET quantity = excluded.quantity, as_of = excluded.as_of, source = excluded.source
    WHERE balances.source <> 'manual' AND (excluded.as_of >= balances.as_of OR balances.as_of IS NULL)`);
  const rows = db.prepare('SELECT balances FROM imports WHERE broker = ? ORDER BY at, rowid').all(broker) as { balances: string }[];
  for (const row of rows) for (const b of JSON.parse(row.balances) as ParsedImport['balances']) upsert.run(b.broker, b.assetId, b.quantity, b.asOf);
}

function undoImportInner(importId: string): number {
  const imported = db.prepare('SELECT broker FROM imports WHERE id = ?').get(importId) as { broker: string } | undefined;
  if (!imported) return 0;
  const remainingCosts = db.prepare('SELECT id, costs FROM imports WHERE id <> ? AND broker = ? ORDER BY at, rowid').all(importId, imported.broker) as { id: string; costs: string }[];
  const costOwners = new Map(remainingCosts.flatMap((r) => (JSON.parse(r.costs) as ParsedImport['pendingCosts']).map((c) => [c.sourceKey, r.id] as const)));
  // Quita de las operaciones de otros ficheros los tributos que aportó este.
  for (const op of allOps(true).filter((o) => o.appliedCosts?.some((x) => x.importId === importId))) {
    const mine = (op.appliedCosts ?? []).filter((x) => x.importId === importId && !costOwners.has(x.key));
    const next: Operation = {
      ...op,
      otherCostsEur: cents(mine.reduce((s, x) => s.minus(D(x.amountEur)), D(op.otherCostsEur))),
      appliedCosts: (op.appliedCosts ?? []).filter((x) => !mine.includes(x)).map((x) => x.importId === importId ? { ...x, importId: costOwners.get(x.key)! } : x),
    };
    next.totalEur = cents(expectedTotal(next));
    if (op.original) next.original = { ...op.original, otherCostsEur: next.otherCostsEur, totalEur: next.totalEur };
    putOp(next);
    addHistory(op.id, 'tributo retirado al quitar su fichero', op, next);
  }
  db.prepare('DELETE FROM applied_costs').run();
  db.prepare('DELETE FROM import_operations WHERE import_id = ?').run(importId);
  const owned = db.prepare('SELECT id FROM operations WHERE import_id = ?').all(importId) as { id: string }[];
  const rows: { id: string }[] = [];
  for (const row of owned) {
    const owner = db.prepare('SELECT import_id FROM import_operations WHERE op_id = ? LIMIT 1').get(row.id) as { import_id: string } | undefined;
    if (owner) {
      const op = getOp(row.id)!;
      putOp({ ...op, importId: owner.import_id, original: op.original ? { ...op.original, importId: owner.import_id } : op.original });
    } else rows.push(row);
  }
  let removed = 0;
  for (const r of rows) {
    const op = getOp(r.id);
    if (!op) continue;
    if (!op.deleted) removed++;
    putOp({ ...op, deleted: true });
    addHistory(op.id, 'importación deshecha', op, null);
  }
  db.prepare('UPDATE operations SET source_key = NULL WHERE import_id = ?').run(importId);
  db.prepare('DELETE FROM imports WHERE id = ?').run(importId);
  // Si se quitan las compras antes que Account, sus tributos siguen perteneciendo a Account.
  for (const row of remainingCosts) resolveCosts({ pendingCosts: JSON.parse(row.costs) as ParsedImport['pendingCosts'] }, row.id, allOps());
  rebuildImportedBalances(imported.broker);
  bump();
  return removed;
}

function importTransaction(action: () => number): number {
  db.exec('BEGIN');
  try {
    const removed = action();
    db.exec('COMMIT');
    return removed;
  } catch (e) {
    db.exec('ROLLBACK');
    bump();
    throw e;
  }
}

export const undoImport = (importId: string): number => importTransaction(() => undoImportInner(importId));

export function removeBrokerImports(broker: string): number {
  return importTransaction(() => {
    const ids = db.prepare('SELECT id FROM imports WHERE broker = ?').all(broker) as { id: string }[];
    return ids.reduce((count, r) => count + undoImportInner(r.id), 0);
  });
}

// ---- Edición ----
export class ValidationError extends Error {
  detail: unknown;
  constructor(message: string, detail: unknown) { super(message); this.detail = detail; }
}

function validate(op: Operation, settings: Settings) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(op.datetime)) throw new ValidationError('Fecha y hora no válidas.', null);
  if (!op.assetId) throw new ValidationError('Falta el activo.', null);
  const r = reconcile(op, settings.toleranceEur);
  if (!r.ok) throw new ValidationError('La operación no cuadra.', r);
}

const EDITABLE: (keyof Operation)[] = [
  'kind', 'datetime', 'assetId', 'assetName', 'assetClass', 'broker', 'quantity', 'unitPrice', 'currency', 'fxRate', 'fxSource', 'grossLocal', 'grossEur',
  'feeEur', 'otherCostsEur', 'withholdingEur', 'spanishTaxEur', 'totalEur', 'settleCurrency', 'counterAsset', 'counterName', 'counterQuantity', 'feeClass', 'note', 'reviewReasons',
];

export function updateOp(id: string, patch: Partial<Operation>): Operation {
  const before = getOp(id);
  if (!before) throw new ValidationError('Operación no encontrada.', null);
  const next: Operation = { ...before };
  for (const k of EDITABLE) if (k in patch) (next as unknown as Record<string, unknown>)[k] = patch[k];
  next.edited = true;
  validate(next, getSettings());
  putOp(next);
  // El nombre es del ISIN: si lo cambias en un movimiento, cambia en todos.
  const asset = assetsMap().get(next.assetId);
  if (asset && next.assetId === before.assetId && next.assetName && next.assetName !== before.assetName && next.assetName !== asset.name) {
    saveAsset({ ...asset, name: next.assetName });
  }
  addHistory(id, 'editada', before, next);
  return next;
}

export function createOp(patch: Partial<Operation>): Operation {
  const op: Operation = {
    ...baseOp({
      broker: patch.broker ?? 'manual', kind: patch.kind ?? 'buy', datetime: patch.datetime ?? `${today()}T12:00:00`, assetId: patch.assetId ?? '', assetName: patch.assetName ?? patch.assetId ?? '',
      assetClass: patch.assetClass ?? 'stock', currency: patch.currency ?? 'EUR', sourceKey: `manual:${randomUUID()}`,
    }),
    ...patch,
    reviewReasons: [],
  };
  validate(op, getSettings());
  op.original = null;
  putOp(op);
  registerAsset(assetsMap(), op.assetId, op.assetName, op.assetClass);
  if (op.counterAsset && op.kind !== 'fx') registerAsset(assetsMap(), op.counterAsset, op.counterName ?? op.counterAsset, op.assetClass);
  addHistory(op.id, 'creada a mano', null, op);
  return op;
}

export function deleteOp(id: string) {
  const op = getOp(id);
  if (!op) return;
  putOp({ ...op, deleted: true });
  addHistory(id, 'eliminada', op, null);
}
export function restoreDeleted(id: string) {
  const op = getOp(id);
  if (!op) return;
  putOp({ ...op, deleted: false });
  addHistory(id, 'recuperada', null, op);
}
export function restoreOriginal(id: string): Operation {
  const op = getOp(id);
  if (!op?.original) throw new ValidationError('No hay valores importados que restaurar.', null);
  const next: Operation = { ...op, ...op.original, id: op.id, original: op.original, edited: false, deleted: false };
  putOp(next);
  addHistory(id, 'valores importados restaurados', op, next);
  return next;
}

/** El usuario da por bueno un motivo de revisión. No cuenta como edición de importes. */
export function confirmReview(ids: string[], reason?: string): number {
  let n = 0;
  for (const id of ids) {
    const op = getOp(id);
    if (!op?.reviewReasons?.length) continue;
    const next: Operation = { ...op, reviewReasons: reason ? op.reviewReasons.filter((r) => r !== reason) : [] };
    putOp(next);
    addHistory(id, 'revisada', op, next);
    n++;
  }
  return n;
}

// ---- Tipos del BCE ----
export async function refreshEcbRates() {
  const from = latestRateDate() ?? '2010-01-01';
  const url = `https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?startPeriod=${from}&format=csvdata`;
  const res = await fetch(url, { headers: { Accept: 'text/csv' } });
  if (!res.ok) throw new Error(`El BCE respondió ${res.status}`);
  const text = await res.text();
  const lines = text.trim().split('\n');
  const head = (lines[0] as string).split(',');
  const iCur = head.indexOf('CURRENCY'), iDate = head.indexOf('TIME_PERIOD'), iVal = head.indexOf('OBS_VALUE');
  const items: { date: string; currency: string; rate: string }[] = [];
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    if (c[iVal]) items.push({ date: c[iDate] as string, currency: c[iCur] as string, rate: c[iVal] as string });
  }
  insertRates(items);
  return { added: items.length, latest: latestRateDate() };
}

// ---- Valoración de cripto con la API pública de Kraken ----
const KRAKEN_CODE: Record<string, string> = { BTC: 'XBT', DOGE: 'XDG' };

const madridToUnix = (dt: string): number => {
  const asUtc = Date.parse(`${dt}Z`);
  const fmt = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const shown = Date.parse(`${fmt.format(new Date(asUtc)).replace(' ', 'T')}Z`);
  return Math.floor((asUtc - (shown - asUtc)) / 1000);
};

let lastCall = 0;
// Un par que Kraken no tiene no se vuelve a pedir: las altcoins antiguas se valoran por su contrapartida.
const unknownPairs = new Set<string>();
// Kraken devuelve la primera operación posterior aunque sea años después (un par aún sin cotizar):
// solo vale un precio cercano, y se recuerda el hueco para no volver a preguntar.
const NEAR = 3 * 3600;
const gaps = new Map<string, { from: number; to: number }[]>();
async function krakenFirstTrade(pair: string, since: number): Promise<Decimal | null> {
  if (unknownPairs.has(pair) || gaps.get(pair)?.some((g) => since >= g.from && since + NEAR < g.to)) return null;
  const wait = 1100 - (Date.now() - lastCall);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const res = await fetch(`https://api.kraken.com/0/public/Trades?pair=${pair}&since=${since}&count=1`);
  const data = (await res.json()) as { error: string[]; result?: Record<string, unknown> };
  if (data.error?.some((e) => e.includes('Unknown asset pair'))) unknownPairs.add(pair);
  if (data.error?.length || !data.result) return null;
  const key = Object.keys(data.result).find((k) => k !== 'last');
  const trades = key ? (data.result[key] as [string, string, number][]) : [];
  const first = trades[0];
  if (!first) return null;
  if (Number(first[2]) - since > NEAR) {
    gaps.set(pair, [...(gaps.get(pair) ?? []), { from: since, to: Number(first[2]) }]);
    return null;
  }
  return D(first[0]);
}

const krakenPairs = (asset: string) => {
  const code = KRAKEN_CODE[krakenAsset(asset)] ?? krakenAsset(asset);
  return [`${code}EUR`, `${code}USD`];
};
const hourOf = (datetime: string) => {
  const ts = madridToUnix(datetime);
  return ts - (ts % 3600);
};

// Pares que Kraken cotiza hoy: así no se pregunta uno a uno por monedas que nunca tuvo.
let listedPairs: Set<string> | null = null;
export async function krakenListed(asset: string): Promise<boolean> {
  if (!listedPairs) {
    const data = (await fetch('https://api.kraken.com/0/public/AssetPairs').then((r) => r.json()).catch(() => null)) as { result?: Record<string, { altname: string }> } | null;
    if (!data?.result) return false;
    listedPairs = new Set(Object.values(data.result).map((p) => p.altname));
  }
  return krakenPairs(asset).some((p) => listedPairs!.has(p));
}

/** Sin precio porque Kraken no tuvo operaciones cerca, no por un fallo de red: se puede recordar. */
export function krakenNoTrade(asset: string, datetime: string): boolean {
  const hour = hourOf(datetime);
  return krakenPairs(asset).every((pair) => unknownPairs.has(pair) || !!gaps.get(pair)?.some((g) => hour >= g.from && hour + NEAR < g.to));
}

/** Precio en euros del activo en el instante. Usa EUR o, si no existe el par, USD al tipo del BCE. */
export async function priceEur(asset: string, datetime: string): Promise<Decimal | null> {
  const hour = hourOf(datetime);
  const cached = db.prepare('SELECT eur FROM crypto_prices WHERE asset = ? AND ts = ?').get(asset, hour) as { eur: string } | undefined;
  if (cached) return D(cached.eur);
  const [eurPair, usdPair] = krakenPairs(asset) as [string, string];
  let price = await krakenFirstTrade(eurPair, hour);
  if (!price) {
    const usd = await krakenFirstTrade(usdPair, hour);
    const r = rateAt('USD', datetime.slice(0, 10));
    if (usd && r) price = usd.div(r);
  }
  if (price) db.prepare('INSERT OR REPLACE INTO crypto_prices (asset, ts, eur) VALUES (?, ?, ?)').run(asset, hour, price.toFixed());
  return price;
}

const missingValue = (o: Operation) =>
  !o.deleted && o.fifoLeg !== 'cash_only' && o.assetClass === 'crypto' && !o.grossEur && ['swap', 'staking', 'reward', 'sell', 'buy'].includes(o.kind);

export const countMissingValues = () => calculationOps().filter(missingValue).length;

/** Valor de mercado del activo entregado o, si Kraken no lo cotiza, de lo recibido a cambio. */
async function valueFromKraken(op: Operation): Promise<boolean> {
  const qty = D(op.quantity);
  let price = await priceEur(op.assetId, op.datetime);
  if (!price && op.kind === 'swap' && op.counterAsset && op.counterQuantity) {
    const counter = await priceEur(op.counterAsset, op.datetime);
    if (counter) price = counter.times(D(op.counterQuantity)).div(qty);
  }
  // Puede haberse editado mientras se esperaba el precio.
  const current = getOp(op.id);
  if (!price || !current || current.grossEur || current.deleted) return false;
  const value = cents(qty.times(price));
  const next: Operation = {
    ...current, unitPrice: toStr(price, 10), grossLocal: value, grossEur: value, currency: 'EUR', fxRate: '1',
    note: [current.note, 'Valor de mercado: API pública de Kraken'].filter(Boolean).join(' · '),
  };
  next.totalEur = cents(expectedTotal(next));
  putOp(next);
  addHistory(op.id, 'valor en euros obtenido de Kraken', current, next);
  return true;
}

export async function resolveCryptoValues(limit = 40) {
  const active = new Set(calculationOps().filter(missingValue).map((o) => o.id));
  const pending = allOps().filter((o) => active.has(o.id));
  let done = 0;
  const failed: string[] = [];
  for (const op of pending.slice(0, limit)) {
    if (await valueFromKraken(op)) done++;
    else failed.push(`${op.assetId} ${op.datetime.slice(0, 10)}`);
  }
  return { done, failed, remaining: Math.max(0, pending.length - done - failed.length) };
}

const unpriced = new Set<string>();
/** CoinTracking no trae euros en las permutas entre criptos: se valoran todas, también las de ciclos anteriores. */
export async function valueImportedCrypto(): Promise<number> {
  let done = 0;
  for (const op of allOps().filter((o) => o.broker === 'cointracking' && missingValue(o) && !o.edited && !unpriced.has(`${currentProfileId()}:${o.id}`))) {
    if (await valueFromKraken(op)) done++;
    else unpriced.add(`${currentProfileId()}:${op.id}`);
  }
  return done;
}

// ---- Simulador ----
export function simulateSales(p: { sales: { assetId: string; quantity: string; priceEur: string; feeEur?: string }[]; date: string }): SalesSimulation {
  const assets = assetsMap();
  const settings = getSettings();
  const ops = withAssetMeta(allOps(), assets);
  const sold = p.sales.filter((s) => D(s.quantity).gt(0));
  const starts = fifoStarts(ops, effectiveFifoSettings(settings, engine()));
  for (const sale of sold) {
    const start = fifoStartFor(starts, sale.assetId);
    if (start && p.date < start) throw new ValidationError(`La simulación es anterior al inicio del FIFO de ${sale.assetId} (${start}).`, null);
  }
  const sims = sold.map((s): Operation => {
    const ref = ops.find((o) => o.assetId === s.assetId || o.counterAsset === s.assetId);
    const asset = assets.get(s.assetId);
    const gross = D(s.quantity).times(D(s.priceEur));
    const fee = D(s.feeEur ?? 0);
    return {
      ...baseOp({ broker: 'manual', kind: 'sell', datetime: `${p.date}T23:59:59`, assetId: s.assetId, assetName: asset?.name ?? ref?.assetName ?? s.assetId, assetClass: asset?.class ?? ref?.assetClass ?? 'stock', sourceKey: `sim:${s.assetId}` }),
      id: `SIM:${s.assetId}`, quantity: s.quantity, unitPrice: s.priceEur, grossLocal: gross.toFixed(2), grossEur: gross.toFixed(2), feeEur: fee.toFixed(2),
      totalEur: gross.minus(fee).toFixed(2), simulated: true,
    };
  });
  const year = Number(p.date.slice(0, 4));
  const withSim = runEngine({ ops: [...ops, ...sims], assets, settings, rateAt, today: p.date });
  const before = buildYearReport(engine(), settings, year);
  const after = buildYearReport(withSim, settings, year);
  const sales = sims.map((sim): SaleSimulation => {
    const d = withSim.disposals.find((x) => x.opId === sim.id) as Disposal;
    const klass = sim.assetClass;
    const asset = assets.get(sim.assetId);
    const months = klass === 'crypto' ? null : (asset?.washMonthsOverride ?? settings.washMonths[asset?.market ?? 'eu']);
    return {
      assetId: sim.assetId, quantity: sim.quantity as string, proceedsEur: cents(D(d.proceedsEur)), costEur: cents(D(d.costEur)), gainEur: cents(D(d.gainEur)),
      deferredEur: cents(withSim.tranches.filter((t) => t.originDisposalId === d.id && t.status === 'blocked').reduce((s, t) => s.plus(D(t.amountEur)), D(0))),
      releasedEur: cents(withSim.tranches
        .filter((t) => t.assetId === sim.assetId && t.originDisposalId !== d.id && t.status !== 'blocked' && t.date === p.date)
        .reduce((s, t) => s.plus(D(t.amountEur)), D(0))),
      safeRebuyFrom: months ? addMonths(p.date, months) : null,
      matches: d.matches,
    };
  });
  const sum = (k: 'proceedsEur' | 'gainEur' | 'deferredEur' | 'releasedEur') => cents(sales.reduce((s, x) => s.plus(D(x[k])), D(0)));
  const gppBefore = D(before.savings.gppBalance), gppAfter = D(after.savings.gppBalance);
  const useful = Decimal.max(0, gppBefore.plus(D(before.savings.rcmBalance).times('0.25')));
  const lost = Decimal.max(0, gppBefore.minus(gppAfter));
  return {
    sales, proceedsEur: sum('proceedsEur'), gainEur: sum('gainEur'), deferredEur: sum('deferredEur'), releasedEur: sum('releasedEur'),
    payBefore: before.savings.taxAfterCredits, payAfter: after.savings.taxAfterCredits, year,
    usefulLossEur: cents(useful), usedLossEur: cents(Decimal.min(lost, useful)), extraLossEur: cents(Decimal.max(0, lost.minus(useful))),
  };
}

// ---- Cuadre ----
const pendingCount = (res: ReturnType<typeof runEngine>, year: number): number => issuesForYear(res, year, getSettings().lastFiledYear).filter((i) => i.severity !== 'info').length;

/** Pendientes de cada año, para que lo de otro ejercicio no bloquee el que se está declarando. */
export function pendingByYear(): Record<number, { errors: number; warnings: number }> {
  const res = engine();
  const out: Record<number, { errors: number; warnings: number }> = {};
  for (const y of res.years) {
    const list = issuesForYear(res, y, getSettings().lastFiledYear);
    out[y] = { errors: list.filter((i) => i.severity === 'error').length, warnings: list.filter((i) => i.severity === 'warning').length };
  }
  return out;
}

export function checks(year?: number) {
  const res = engine();
  const issues = year ? issuesForYear(res, year, getSettings().lastFiledYear) : res.issues;
  const starts = fifoStarts(allOps(), effectiveFifoSettings(getSettings(), res));
  const balances = (db.prepare('SELECT broker, asset_id, quantity, as_of, source FROM balances').all() as { broker: string; asset_id: string; quantity: string; as_of: string | null; source: string | null }[])
    .filter((b) => !b.as_of || b.as_of.slice(0, 10) >= (fifoStartFor(starts, b.asset_id) ?? ''));
  // Un activo cuyo último movimiento es anterior a su inicio del FIFO pertenece
  // a un ciclo anterior: sus restos de historial incompleto no se cuadran.
  const lastOp = new Map(allOps().flatMap((o) => [o.assetId, ...(o.counterAsset ? [o.counterAsset] : [])].map((id) => [id, o.datetime.slice(0, 10)] as const)));
  const positions = res.positions.filter((p) => {
    const last = lastOp.get(p.assetId);
    return !last || last >= (fifoStartFor(starts, p.assetId) ?? '');
  });
  const rows = positions.flatMap((p) =>
    Object.entries(p.byBroker).filter(([b]) => b !== 'externo' || balances.some((v) => v.broker === 'externo' && v.asset_id === p.assetId)).map(([broker, qty]) => {
      const declared = balances.find((b) => b.broker === broker && b.asset_id === p.assetId);
      const diff = declared ? D(qty).minus(D(declared.quantity)) : null;
      return {
        broker, assetId: p.assetId, assetName: p.assetName, class: p.class, computed: qty, declared: declared?.quantity ?? null, asOf: declared?.as_of ?? null,
        source: declared?.source ?? null, diff: diff ? toStr(diff, 8) : null, ok: diff ? diff.abs().lte(p.class === 'fx' ? '0.05' : '0.00001') : null,
      };
    }));
  for (const b of balances) {
    if (!rows.some((r) => r.broker === b.broker && r.assetId === b.asset_id) && !D(b.quantity).isZero()) {
      rows.push({
        broker: b.broker, assetId: b.asset_id, assetName: b.asset_id, class: 'other', computed: '0', declared: b.quantity, asOf: b.as_of, source: b.source,
        diff: toStr(D(b.quantity).neg(), 8), ok: D(b.quantity).abs().lte('0.00001'),
      });
    }
  }
  return {
    issues,
    otherYears: year ? res.years.filter((y) => y !== year).map((y) => ({ year: y, count: pendingCount(res, y) })).filter((x) => x.count > 0) : [],
    summary: {
      errors: issues.filter((i) => i.severity === 'error').length,
      warnings: issues.filter((i) => i.severity === 'warning').length,
      infos: issues.filter((i) => i.severity === 'info').length,
      operations: allOps().length,
      edited: allOps().filter((o) => o.edited).length,
      missingValues: countMissingValues(),
    },
    positions: rows.sort((a, b) => a.broker.localeCompare(b.broker) || a.assetName.localeCompare(b.assetName)),
  };
}

export function setDeclaredBalance(broker: string, assetId: string, quantity: string | null) {
  if (quantity === null || quantity === '') {
    db.prepare('DELETE FROM balances WHERE broker = ? AND asset_id = ?').run(broker, assetId);
  } else {
    db.prepare(`INSERT INTO balances (broker, asset_id, quantity, as_of, source) VALUES (?, ?, ?, ?, 'manual')
      ON CONFLICT(broker, asset_id) DO UPDATE SET quantity = excluded.quantity, as_of = excluded.as_of, source = excluded.source`).run(broker, assetId, quantity, today());
  }
}

export { applyEdit };
