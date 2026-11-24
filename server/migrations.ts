import type { DatabaseSync } from 'node:sqlite';
import { D, cents, isNum } from '../shared/decimal.ts';
import { expectedTotal } from '../shared/reconcile.ts';
import type { Operation } from '../shared/types.ts';
import { finishTrade } from './importers/common.ts';

/** Corrige solo la clasificación automática anterior, respetando los movimientos editados. */
export function migrateNetworkFees(database: DatabaseSync) {
  const rows = database.prepare("SELECT data FROM operations WHERE kind = 'sell'").all() as { data: string }[];
  const changes = rows.map((r) => JSON.parse(r.data) as Operation).filter((op) => op.broker === 'kraken' && op.sourceKey?.startsWith('kr-netfee:') && !op.edited);
  if (!changes.length) return;
  database.exec('BEGIN');
  try {
    for (const before of changes) {
      const fix = (op: Operation): Operation => ({ ...op, kind: 'fee', feeClass: 'non_deductible', reviewReasons: op.reviewReasons?.filter((r) => r !== 'Comisión de retirada pagada en cripto: cuenta como una pequeña venta.') });
      const after = fix(before);
      if (before.original) after.original = fix(before.original as Operation);
      database.prepare("UPDATE operations SET kind = 'fee', data = ? WHERE id = ?").run(JSON.stringify(after), before.id);
      database.prepare('INSERT INTO op_history (op_id, at, action, before, after) VALUES (?, ?, ?, ?, ?)')
        .run(before.id, new Date().toISOString(), 'comisión de retirada reclasificada (DGT V0648-24)', JSON.stringify(before), JSON.stringify(after));
    }
    database.exec('COMMIT');
  } catch (e) { database.exec('ROLLBACK'); throw e; }
}

const LEGACY_BOND_REVIEW = 'Renta fija: tributa como rendimiento (casilla 0031), no como venta de acciones.';

function fixTradeRepublicBond(op: Operation, imported = op): Operation {
  if (!imported.reviewReasons?.includes(LEGACY_BOND_REVIEW)) return op;
  const next = { ...op, reviewReasons: op.reviewReasons?.filter((reason) => reason !== LEGACY_BOND_REVIEW) };
  if (op.currency !== 'EUR' || !isNum(op.totalEur) || !isNum(op.grossEur) || !D(op.quantity).gt(0)) return next;

  const amount = D(op.totalEur);
  const mismatch = `El total del bróker (${cents(amount)} €) difiere del calculado (${cents(expectedTotal(op))} €).`;
  // El importador anterior guardó `amount` como total si difería de cantidad × cotización.
  // Solo se recupera como bruto si el aviso importado confirma ese caso y hay cupón corrido positivo.
  if (!imported.reviewReasons.includes(mismatch) || amount.lte(D(op.grossEur))) return next;

  next.reviewReasons = next.reviewReasons?.filter((reason) => reason !== mismatch);
  return finishTrade(next, {
    qty: D(op.quantity), price: op.unitPrice == null ? null : D(op.unitPrice), grossLocal: amount, grossEur: null,
    fee: D(op.feeEur), other: D(op.otherCostsEur),
  });
}

export function migrateTradeRepublicBonds(database: DatabaseSync) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const rows = database.prepare("SELECT data FROM operations WHERE broker = 'trade_republic' AND kind IN ('buy', 'sell')").all() as { data: string }[];
    const update = database.prepare('UPDATE operations SET data = ? WHERE id = ?');
    const history = database.prepare('INSERT INTO op_history (op_id, at, action, before, after) VALUES (?, ?, ?, ?, ?)');
    for (const row of rows) {
      const before = JSON.parse(row.data) as Operation;
      if (before.assetClass !== 'bond' || !before.sourceKey?.startsWith('tr:') || before.edited) continue;
      const original = before.original as Operation | undefined;
      const after = fixTradeRepublicBond(before, original ?? before);
      if (after === before) continue;
      if (original) after.original = fixTradeRepublicBond(original);
      const data = JSON.stringify(after);
      if (data === row.data) continue;
      update.run(data, before.id);
      history.run(before.id, new Date().toISOString(), 'importe del bono ajustado al cupón corrido', row.data, data);
    }
    database.exec('COMMIT');
  } catch (e) { database.exec('ROLLBACK'); throw e; }
}
