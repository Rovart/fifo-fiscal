import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateNetworkFees } from '../server/migrations.ts';
import { trade } from './helpers.ts';

it('corrige las comisiones ya importadas una vez, conserva el original y respeta ediciones', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE operations (id TEXT PRIMARY KEY, kind TEXT, data TEXT); CREATE TABLE op_history (op_id TEXT, at TEXT, action TEXT, before TEXT, after TEXT)');
  const sale = { ...trade('sell', '2025-01-01', '0.0001', '10000'), broker: 'kraken' as const, assetClass: 'crypto' as const, sourceKey: 'kr-netfee:one', reviewReasons: ['Comisión de retirada pagada en cripto: cuenta como una pequeña venta.'] };
  const before = { ...sale, original: { ...sale } };
  const edited = { ...sale, id: 'edited', edited: true };
  for (const op of [before, edited]) db.prepare('INSERT INTO operations VALUES (?, ?, ?)').run(op.id, op.kind, JSON.stringify(op));
  migrateNetworkFees(db);
  migrateNetworkFees(db);
  const read = (id: string) => JSON.parse((db.prepare('SELECT data FROM operations WHERE id = ?').get(id) as { data: string }).data);
  expect(read(before.id)).toMatchObject({ kind: 'fee', feeClass: 'non_deductible', quantity: '0.0001', reviewReasons: [], original: { kind: 'fee', feeClass: 'non_deductible' } });
  expect(read(edited.id).kind).toBe('sell');
  expect(db.prepare('SELECT * FROM op_history').all()).toHaveLength(1);
  db.close();
});
