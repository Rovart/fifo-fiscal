import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { migrateNetworkFees, migrateTradeRepublicBonds } from '../server/migrations.ts';
import { reconcile } from '../shared/reconcile.ts';
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

it('corrige el cupón corrido de bonos importados sin duplicar el ajuste ni sobreescribir ediciones', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE operations (id TEXT PRIMARY KEY, broker TEXT, kind TEXT, data TEXT); CREATE TABLE op_history (op_id TEXT, at TEXT, action TEXT, before TEXT, after TEXT)');
  const buy = {
    ...trade('buy', '2026-01-19', '5820', '1.0032'),
    broker: 'trade_republic' as const, assetClass: 'bond' as const, sourceKey: 'tr:bond',
    grossLocal: '5838.62', grossEur: '5838.62', feeEur: '1.00', totalEur: '5999.19',
    reviewReasons: [
      'El total del bróker (5999.19 €) difiere del calculado (5839.62 €).',
      'Renta fija: tributa como rendimiento (casilla 0031), no como venta de acciones.',
    ],
  };
  const before = { ...buy, reviewReasons: [], original: { ...buy } };
  const edited = { ...buy, id: 'edited', edited: true };
  for (const op of [before, edited]) db.prepare('INSERT INTO operations VALUES (?, ?, ?, ?)').run(op.id, op.broker, op.kind, JSON.stringify(op));
  migrateTradeRepublicBonds(db);
  migrateTradeRepublicBonds(db);
  const read = (id: string) => JSON.parse((db.prepare('SELECT data FROM operations WHERE id = ?').get(id) as { data: string }).data);
  const corrected = { grossLocal: '5999.19', grossEur: '5999.19', feeEur: '1.00', totalEur: '6000.19', reviewReasons: [] };
  const after = read(before.id);
  expect(after).toMatchObject({ ...corrected, original: corrected });
  expect(reconcile(after).ok).toBe(true);
  expect(read(edited.id)).toEqual(edited);
  expect(db.prepare('SELECT * FROM op_history').all()).toHaveLength(1);
  db.close();
});
