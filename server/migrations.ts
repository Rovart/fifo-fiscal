import type { DatabaseSync } from 'node:sqlite';
import type { Operation } from '../shared/types.ts';

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
