import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../shared/types.ts';

process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const { app } = await import('../server/app.ts');
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const csv = fixture('degiro_transactions_es.csv');

beforeAll(() => db.seedRatesIfEmpty());

const request = (path: string, profile = 'default', method = 'GET', body?: unknown) => app.request(`http://127.0.0.1${path}`, {
  method, headers: { Host: '127.0.0.1', 'X-Fifo-Profile': profile, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

describe('Cuentas independientes', () => {
  it('importa el mismo documento en dos personas sin compartir operaciones, ajustes, activos ni historial', () => {
    const a = db.createProfile('Ana');
    const b = db.createProfile('Bea');
    let aId = '', aImport = '';
    db.withProfile(a.id, () => {
      const imported = svc.commitImport('Ana.csv', csv);
      aImport = imported.importId;
      aId = db.allOps()[0]!.id;
      db.saveSettings({ ...DEFAULT_SETTINGS, lastFiledYear: 2023 });
      db.saveAsset({ ...db.listAssets()[0]!, name: 'Solo Ana' });
      expect(svc.engine().disposals.length).toBeGreaterThan(0);
    });
    db.withProfile(b.id, () => {
      expect(svc.engine().disposals).toEqual([]);
      expect(db.getOp(aId)).toBeNull();
      expect(db.getHistory(aId)).toEqual([]);
      expect(svc.undoImport(aImport)).toBe(0);
      expect(db.getSettings().lastFiledYear).toBe(DEFAULT_SETTINGS.lastFiledYear);
      expect(svc.commitImport('Bea.csv', csv).newOps).toBe(4);
      expect(db.listAssets().some((x) => x.name === 'Solo Ana')).toBe(false);
      svc.removeBrokerImports('degiro');
      expect(svc.engine().disposals).toEqual([]);
    });
    db.withProfile(a.id, () => {
      expect(db.allOps()).toHaveLength(4);
      expect(svc.engine().disposals.length).toBeGreaterThan(0);
    });
    expect(db.allOps()).toEqual([]);
  });

  it('mantiene la cuenta durante tareas asíncronas concurrentes', async () => {
    const a = db.createProfile('Concurrente A');
    const b = db.createProfile('Concurrente B');
    await Promise.all([
      db.withProfile(a.id, async () => {
        svc.commitImport('A.csv', csv);
        await new Promise((resolve) => setTimeout(resolve, 15));
        expect(db.currentProfileId()).toBe(a.id);
        expect(db.allOps()).toHaveLength(4);
      }),
      db.withProfile(b.id, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(db.currentProfileId()).toBe(b.id);
        expect(svc.engine().disposals).toEqual([]);
      }),
    ]);
  });

  it('rechaza cuentas desconocidas y nombres vacíos', async () => {
    expect(() => db.withProfile('../../otro', () => db.allOps())).toThrow(/Cuenta no encontrada/);
    expect(() => db.createProfile('  ')).toThrow(/nombre/);
    expect(() => db.createProfile('a'.repeat(61))).toThrow(/60/);
    const res = await request('/api/state', 'no-existe');
    expect(res.status).toBe(422);
  });

  it('crea, cambia el nombre y consulta cada cuenta por API', async () => {
    const created = await request('/api/profiles', 'default', 'POST', { name: '  María  ' });
    expect(created.status).toBe(201);
    const profile = await created.json();
    expect(profile.name).toBe('María');
    await request('/api/import/commit', profile.id, 'POST', { file: 'María.csv', content: csv });
    const state = await (await request('/api/state', profile.id)).json();
    expect(state.profileId).toBe(profile.id);
    expect(state.counts.operations).toBe(4);
    expect((await (await request('/api/state')).json()).counts.operations).toBe(0);
    expect((await (await request(`/api/profiles/${profile.id}`, profile.id, 'PUT', { name: 'María López' })).json()).name).toBe('María López');
    const opId = (await (await request('/api/operations', profile.id)).json()).items[0].id;
    expect((await request(`/api/operations/${opId}`)).status).toBe(404);
    await request(`/api/operations/${opId}`, 'default', 'DELETE');
    expect((await (await request('/api/state', profile.id)).json()).counts.operations).toBe(4);
  });

  it('la descarga de Excel respeta la cuenta de la URL', async () => {
    const profile = db.createProfile('Exportación');
    const ExcelJS = (await import('exceljs')).default;
    const response = await app.request(`http://127.0.0.1/api/export/2024?profile=${profile.id}`, { headers: { Host: '127.0.0.1' } });
    expect(response.status).toBe(200);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await response.arrayBuffer());
    expect(workbook.getWorksheet('Operaciones')!.rowCount).toBe(1);
  });
});

describe('Documentos de un mismo exchange', () => {
  it('no crea otra entrada al subir exactamente el mismo archivo', () => {
    db.withProfile(db.createProfile('Duplicados').id, () => {
      const first = svc.commitImport('uno.csv', csv);
      const repeated = svc.commitImport('uno.csv', csv);
      expect(repeated.importId).toBe(first.importId);
      expect(repeated.newOps).toBe(0);
      expect(svc.listImports()).toHaveLength(1);
      expect(svc.undoImport(first.importId)).toBe(4);
      expect(svc.commitImport('de nuevo.csv', csv).newOps).toBe(4);
    });
  });

  it('dos archivos de distinto nombre e idéntico contenido conservan una sola copia de cada movimiento', () => {
    db.withProfile(db.createProfile('Archivos idénticos').id, () => {
      const first = svc.commitImport('Primero.csv', csv);
      const second = svc.commitImport('Segundo.csv', csv);
      expect(second.newOps).toBe(0);
      expect(svc.listImports()).toHaveLength(2);
      expect(db.allOps()).toHaveLength(4);
      expect(svc.undoImport(first.importId)).toBe(0);
      expect(db.allOps()).toHaveLength(4);
      expect(svc.undoImport(second.importId)).toBe(4);
      expect(db.allOps()).toEqual([]);
    });
  });

  it('conserva los duplicados idénticos de otros archivos sin perder ediciones ni duplicar filas', () => {
    db.withProfile(db.createProfile('Solapados').id, () => {
      const first = svc.commitImport('todo.csv', csv);
      const partial = csv.trim().split('\n').slice(0, 3).join('\n') + '\n';
      const second = svc.commitImport('parte.csv', partial);
      expect(second.newOps).toBe(0);
      expect(svc.listImports().find((r) => r.id === second.importId)?.operations).toBe(2);
      const op = db.allOps()[0]!;
      svc.updateOp(op.id, { note: 'Revisada' });
      expect(svc.undoImport(first.importId)).toBe(2);
      expect(db.allOps()).toHaveLength(2);
      expect(db.getOp(op.id)).toMatchObject({ note: 'Revisada', edited: true, importId: second.importId });
      expect(svc.undoImport(second.importId)).toBe(2);
      expect(db.allOps()).toEqual([]);
    });
  });

  it('retira todo un exchange y conserva los demás y los movimientos manuales', async () => {
    const profile = db.createProfile('Quitar exchange');
    db.withProfile(profile.id, () => {
      svc.commitImport('DEGIRO.csv', csv);
      svc.commitImport('Revolut.csv', fixture('revolut_stocks.csv'));
      const sample = db.allOps().find((o) => o.broker === 'degiro')!;
      svc.createOp({ ...sample, id: 'manual-degiro', sourceKey: 'manual:degiro', importId: undefined, original: null });
    });
    const response = await request('/api/imports/broker/degiro', profile.id, 'DELETE');
    expect((await response.json()).removed).toBe(4);
    db.withProfile(profile.id, () => {
      expect(db.allOps().filter((o) => o.broker === 'degiro').map((o) => o.id)).toEqual(['manual-degiro']);
      expect(db.allOps().some((o) => o.broker === 'revolut')).toBe(true);
      expect(svc.listImports().every((r) => r.broker === 'revolut')).toBe(true);
    });
  });

  it('al quitar el último documento de Kraken desaparecen sus saldos importados', () => {
    db.withProfile(db.createProfile('Saldos').id, () => {
      const imported = svc.commitImport('Kraken.csv', fixture('kraken_ledgers.csv'));
      expect(svc.checks().positions.some((p) => p.source === 'import')).toBe(true);
      svc.undoImport(imported.importId);
      expect(svc.checks().positions).toEqual([]);
    });
  });

  it('permite importar un documento que solo aporta tributos y los conserva al quitar las compras', () => {
    db.withProfile(db.createProfile('Tributos').id, () => {
      const trades = `Fecha,Hora,Producto,ISIN,Bolsa de referencia,Centro de ejecución,Número,Precio,,Valor local,,Valor EUR,Tipo de cambio,Comisión AutoFX,Costes de transacción y/o externos EUR,Total EUR,ID Orden
01-03-2026,10:00,EJEMPLO HK,HK0000000001,HKS,X,100,"10,0000",EUR,"-1000,00",EUR,"-1000,00","0,0000","0,00","-2,00","-1002,00",hk-1
`;
      const account = `Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden
01-03-2026,10:00,01-03-2026,EJEMPLO HK,HK0000000001,Hong Kong Stamp Duty,,EUR,"-1,50",EUR,"10,00",hk-1
`;
      const t = svc.commitImport('Compras.csv', trades);
      const a = svc.commitImport('Tributos.csv', account);
      expect(a.newOps).toBe(0);
      expect(a.costsAttached).toBe(1);
      svc.undoImport(t.importId);
      expect(db.allOps()).toHaveLength(1);
      expect(db.allOps()[0]).toMatchObject({ kind: 'fee', grossEur: '1.50', importId: a.importId });
      svc.commitImport('Compras.csv', trades);
      expect(db.allOps()).toHaveLength(1);
      expect(db.allOps()[0]).toMatchObject({ kind: 'buy', otherCostsEur: '1.50', totalEur: '1003.50' });
    });
  });
});
