import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';
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
  it('el inicio del FIFO corresponde a la persona seleccionada', async () => {
    const empty = db.createProfile('Sin posiciones');
    const invested = db.createProfile('Con posiciones');
    db.withProfile(invested.id, () => svc.createOp({ kind: 'buy', datetime: '2026-01-02T12:00:00', assetId: 'US0378331005', assetName: 'Apple', assetClass: 'stock', quantity: '1', unitPrice: '100', currency: 'EUR', fxRate: '1', grossLocal: '100', grossEur: '100', totalEur: '100' }));
    expect(await (await request('/api/fifo/history', empty.id)).json()).toMatchObject({ from: null, complete: true });
    expect(await (await request('/api/fifo/history', invested.id)).json()).toMatchObject({ from: '2026-01-02', complete: true });
  });
  it('el recorte es por cuenta, conserva operaciones y documentos y se puede quitar', async () => {
    const profile = db.createProfile('Recorte');
    db.withProfile(profile.id, () => svc.commitImport('Extracto.csv', csv));
    const original = await (await request('/api/state', profile.id)).json();
    const settings = { ...original.settings, fifoStartDates: { '*': '2026-01-01' } };
    expect((await request('/api/settings', profile.id, 'PUT', settings)).status).toBe(200);
    expect((await (await request('/api/operations', profile.id)).json()).items.every((o: { _excluded: boolean; _partial: boolean }) => o._excluded || o._partial)).toBe(true);
    expect((await (await request('/api/imports', profile.id)).json()).length).toBe(1);
    expect((await (await request('/api/state', profile.id)).json()).counts.operations).toBe(original.counts.operations);
    expect((await (await request('/api/settings')).json()).fifoStartDates).toBeUndefined();
    const ExcelJS = (await import('exceljs')).default;
    const exported = await request('/api/export/2024', profile.id);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exported.arrayBuffer());
    const sheet = workbook.getWorksheet('Operaciones')!;
    const column = (sheet.getRow(1).values as string[]).indexOf('Cálculo FIFO');
    expect(['Fuera del FIFO', 'Recorte parcial']).toContain(sheet.getRow(2).getCell(column).value);
    expect((await request('/api/simulate', profile.id, 'POST', { date: '2024-01-01', sales: [{ assetId: 'US0378331005', quantity: '1', priceEur: '100' }] })).status).toBe(422);
    expect((await request('/api/settings', profile.id, 'PUT', { ...settings, fifoStartDates: { '*': '2026-02-30' } })).status).toBe(422);
    await request('/api/settings', profile.id, 'PUT', { ...settings, fifoStartDates: {} });
    expect((await (await request('/api/operations', profile.id)).json()).items.every((o: { _excluded: boolean }) => !o._excluded)).toBe(true);
  });
  it('el botón recalcula sin fechas manuales y los criterios fiscales no desactivan el recorte', async () => {
    const profile = db.createProfile('Automático');
    db.withProfile(profile.id, () => {
      svc.commitImport('Extracto.csv', csv);
      db.saveSettings({ ...DEFAULT_SETTINGS, lastFiledYear: 2025, fifoStartDates: { '*': '2026-01-01' } });
    });
    const count = db.withProfile(profile.id, () => db.allOps().length);
    const response = await request('/api/fifo/recalculate', profile.id, 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ verified: true });
    expect(await (await request('/api/settings', profile.id)).json()).toMatchObject({ fifoAutoStart: true, fifoStartDates: {} });
    await request('/api/settings', profile.id, 'PUT', { treatyDefault: '12' });
    expect(await (await request('/api/settings', profile.id)).json()).toMatchObject({ fifoAutoStart: true, treatyDefault: '12' });
    expect((await (await request('/api/state', profile.id)).json()).counts.operations).toBe(count);
    expect(await (await request('/api/imports', profile.id)).json()).toHaveLength(1);
    expect((await (await request('/api/settings')).json()).fifoAutoStart).toBeUndefined();
  });
  it('distingue el saldo declarado en una cartera del saldo calculado sin inventar lotes', async () => {
    const profile = db.createProfile('Cartera externa');
    db.withProfile(profile.id, () => {
      svc.createOp({ kind: 'buy', datetime: '2026-01-02T12:00:00', assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', quantity: '2', unitPrice: '100', currency: 'EUR', fxRate: '1', grossLocal: '200', grossEur: '200', totalEur: '200', broker: 'kraken' });
      svc.createOp({ kind: 'transfer_out', datetime: '2026-01-03T12:00:00', assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', quantity: '2', broker: 'kraken' });
      svc.setDeclaredBalance('externo', 'ETH', '2.5');
    });
    const portfolio = await (await request('/api/portfolio', profile.id)).json();
    expect(portfolio.balanceDifferences).toMatchObject([{ assetId: 'ETH', computed: '2', declared: '2.5', ok: false }]);
    expect(portfolio.positions[0].quantity).toBe('2');
    expect(portfolio.lots).toHaveLength(1);
    expect((await (await request('/api/portfolio')).json()).balanceDifferences).toEqual([]);
  });
  it('recalcular conserva resultados, dividendos, gráficas y exportaciones de ciclos anteriores', async () => {
    const profile = db.createProfile('Historial completo');
    const history = [
      'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate',
      '2024-01-02T14:00:00.000Z,AAPL,BUY - MARKET,10,EUR 10.00,EUR 100.00,EUR,1',
      '2024-01-31T14:00:00.000Z,AAPL,DIVIDEND,,,EUR 1.00,EUR,1',
      '2024-02-02T14:00:00.000Z,AAPL,SELL - MARKET,10,EUR 12.00,EUR 120.00,EUR,1',
      '2025-04-07T14:00:00.000Z,AAPL,BUY - MARKET,5,EUR 20.00,EUR 100.00,EUR,1',
    ].join('\n');
    db.withProfile(profile.id, () => {
      svc.commitImport('Revolut.csv', history);
      db.saveSettings({ ...DEFAULT_SETTINGS, lastFiledYear: 2025 });
    });
    const before = await (await request('/api/report/2024', profile.id)).json();
    expect((await request('/api/fifo/recalculate', profile.id, 'POST')).status).toBe(200);
    const after = await (await request('/api/report/2024', profile.id)).json();
    expect(after.sections).toEqual(before.sections);
    expect(after.rcm).toEqual(before.rcm);
    expect(after.savings).toEqual(before.savings);
    expect((await (await request('/api/disposals?year=2024', profile.id)).json()).items).toHaveLength(1);
    const movements = (await (await request('/api/operations?year=2024', profile.id)).json()).items;
    expect(movements).toHaveLength(3);
    expect(movements.every((o: { _excluded: boolean; _previousCycle: boolean }) => !o._excluded && o._previousCycle)).toBe(true);
    expect((await (await request('/api/performance', profile.id)).json()).years.map((y: { year: number }) => y.year)).toContain(2024);
    const ExcelJS = (await import('exceljs')).default;
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await (await request('/api/export/2024', profile.id)).arrayBuffer());
    expect(workbook.getWorksheet('Transmisiones FIFO')!.rowCount).toBeGreaterThan(1);
  });
  it('tras recalcular no quedan pendientes ni saldos por cuadrar de un ciclo cerrado ya presentado', async () => {
    const profile = db.createProfile('Ciclo cerrado');
    const history = [
      'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate',
      '2023-09-11T14:00:00.000Z,MSFT,SELL - MARKET,10,EUR 30.00,EUR 300.00,EUR,1',
      '2025-04-07T14:00:00.000Z,AAPL,BUY - MARKET,5,EUR 20.00,EUR 100.00,EUR,1',
    ].join('\n');
    db.withProfile(profile.id, () => {
      svc.commitImport('Revolut.csv', history);
      db.saveSettings({ ...DEFAULT_SETTINGS, lastFiledYear: 2025 });
    });
    const errors2023 = async () => (await (await request('/api/state', profile.id)).json()).counts.byYear[2023].errors;
    expect(await errors2023()).toBeGreaterThan(0);
    expect((await request('/api/fifo/recalculate', profile.id, 'POST')).status).toBe(200);
    expect(await errors2023()).toBe(0);
    const review = await (await request('/api/checks?year=2023', profile.id)).json();
    expect(review.issues.some((i: { code: string; severity: string }) => i.code === 'missing_lots' && i.severity === 'info')).toBe(true);
    expect(review.positions.map((p: { assetId: string }) => p.assetId)).not.toContain('MSFT');
    expect((await (await request('/api/disposals?year=2023', profile.id)).json()).items).toHaveLength(1);
    expect((await (await request('/api/fifo/history', profile.id)).json()).from).toBe('2025-04-07');
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

describe('CoinTracking junto al ledger de Kraken', () => {
  const ct = [
    '"Type","Buy","Cur.","Sell","Cur.","Fee","Cur.","Exchange","Group","Comment","Date","LPN","Tx-ID"',
    '"Trade","0.10000000","BTC","2000.00000000","EUR","0.00000000","","Kraken","Kraken Ledger","","2023-05-01 10:00:00","",""',
    '"Trade","0.20000000","BTC","4000.00000000","EUR","0.00000000","","Kraken","Kraken Ledger","","2024-06-01 10:00:00","",""',
    '"Trade","0.30000000","BTC","6000.00000000","EUR","0.00000000","","Binance","","","2024-06-02 10:00:00","",""',
  ].join('\n');
  const ledger = fixture('kraken_ledgers.csv');
  it('omite solo lo que ya cubre el ledger importado', () => {
    db.withProfile(db.createProfile('Kraken antes').id, () => {
      svc.commitImport('ledgers.csv', ledger);
      const { preview } = svc.previewImport(ct);
      expect(preview).toMatchObject({ newOps: 2, ignored: { 'Kraken: ya está en su propio extracto': 1 } });
    });
  });
  it('avisa si el ledger llega después y se solapa con CoinTracking', () => {
    db.withProfile(db.createProfile('CoinTracking antes').id, () => {
      svc.commitImport('ct.csv', ct);
      expect(svc.previewImport(ledger).preview.warnings.some((w) => w.includes('CoinTracking ya trae 1 movimiento de Kraken'))).toBe(true);
    });
  });
});

describe('Precio de mercado de Kraken', () => {
  it('descarta la primera operación de un par que aún no cotizaba y valora por la contrapartida', async () => {
    const at = (iso: string) => Date.parse(`${iso}Z`) / 1000;
    // Kraken devuelve la primera operación posterior: CHZ empezó a cotizar mucho después.
    const trade = (pair: string): [string, string, number] => pair.startsWith('CHZ') ? ['0.2073', '1', at('2021-03-01T10:00:00')] : ['9000', '1', at('2020-02-13T12:00:30')];
    vi.stubGlobal('fetch', async (url: string) => {
      const pair = new URL(url).searchParams.get('pair')!;
      return { json: async () => ({ error: [], result: { [pair]: [trade(pair)], last: '0' } }) };
    });
    try {
      await db.withProfile(db.createProfile('Precios').id, async () => {
        expect(await svc.priceEur('CHZ', '2020-02-13T13:49:58')).toBeNull();
        expect((await svc.priceEur('BTC', '2020-02-13T13:49:58'))?.toFixed()).toBe('9000');
      });
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('Dividendos', () => {
  it('devuelve los dividendos de todos los años y nada más', async () => {
    const profile = db.createProfile('Dividendos');
    db.withProfile(profile.id, () => {
      svc.commitImport('Revolut.csv', [
        'Date,Ticker,Type,Quantity,Price per share,Total Amount,Currency,FX Rate',
        '2024-01-02T14:00:00.000Z,AAPL,BUY - MARKET,10,EUR 10.00,EUR 100.00,EUR,1',
        '2024-03-31T14:00:00.000Z,AAPL,DIVIDEND,,,EUR 1.00,EUR,1',
        '2025-03-31T14:00:00.000Z,AAPL,DIVIDEND,,,EUR 2.00,EUR,1',
      ].join('\n'));
    });
    const items = (await (await request('/api/dividends', profile.id)).json()).items as { year: number; type: string }[];
    expect(items.map((i) => [i.year, i.type]).sort()).toEqual([[2024, 'dividend'], [2025, 'dividend']]);
  });
});

describe('Modelos 720 y 721', () => {
  it('mide el valor a 31 de diciembre, la subida desde el último presentado y lo que se cierra', async () => {
    const profile = db.createProfile('Extranjero');
    const trade = (kind: 'buy' | 'sell', date: string, assetId: string, quantity: string, price: string) => {
      const total = (Number(quantity) * Number(price)).toFixed(2);
      svc.createOp({ kind, datetime: `${date}T12:00:00`, assetId, assetName: assetId, assetClass: 'crypto', quantity, unitPrice: price, currency: 'EUR', fxRate: '1', grossLocal: total, grossEur: total, totalEur: total, broker: 'kraken' });
    };
    db.withProfile(profile.id, () => {
      trade('buy', '2023-03-01', 'BTC', '2', '30000');
      trade('buy', '2023-03-01', 'ETH', '10', '2000');
      trade('buy', '2023-03-01', 'SOL', '100', '10');
      svc.createOp({ kind: 'transfer_out', datetime: '2023-04-01T12:00:00', assetId: 'SOL', assetName: 'SOL', assetClass: 'crypto', quantity: '100', broker: 'kraken' });
      trade('sell', '2024-02-01', 'BTC', '1', '40000');
      trade('sell', '2024-03-01', 'ETH', '10', '3000');
      const price = db.db.prepare('INSERT INTO price_history (asset_id, month, price_eur) VALUES (?, ?, ?)');
      price.run('BTC', '2023-12', '40000');
      price.run('ETH', '2023-12', '2100');
      price.run('BTC', '2024-12', '75000');
    });
    const crypto = async (year: number) => ((await (await request(`/api/foreign/${year}`, profile.id)).json()).forms as { form: string }[]).find((f) => f.form === '721') as Record<string, unknown>;

    const first = await crypto(2023);
    expect(first).toMatchObject({ valueEur: '101000.00', costEur: '80000.00', required: true, reasons: ['over50k'], lastFiled: null, closures: [] });
    // Lo retirado a una cartera queda aparte y, sin cierre de diciembre, vale lo que costó.
    expect(first.outside).toMatchObject({ valueEur: '1000.00', holdings: [{ assetId: 'SOL', broker: 'externo', priced: 'cost' }] });

    expect((await request('/api/settings', profile.id, 'PUT', { foreignFilings: [{ form: '722', year: 2023, valueEur: '1' }] })).ok).toBe(false);
    await request('/api/settings', profile.id, 'PUT', { foreignFilings: [{ form: '721', year: 2023, valueEur: '101000' }] });
    expect(await crypto(2023)).toMatchObject({ filed: { year: 2023, valueEur: '101000' } });
    expect(await crypto(2024)).toMatchObject({
      valueEur: '75000.00', increaseEur: '-26000.00', required: true, reasons: ['closures'],
      closures: [{ broker: 'kraken', assetId: 'ETH', quantity: '10' }],
    });

    await request('/api/settings', profile.id, 'PUT', { foreignFilings: [{ form: '721', year: 2023, valueEur: '50000' }] });
    expect(await crypto(2024)).toMatchObject({ increaseEur: '25000.00', reasons: ['increase', 'closures'] });
  });
});

describe('Dossier para el gestor', () => {
  it('agrupa cada venta con las compras que consume y marca lo que no tiene compra', async () => {
    const profile = db.createProfile('Dossier');
    const trade = (kind: 'buy' | 'sell', date: string, quantity: string, price: string) => {
      const total = (Number(quantity) * Number(price)).toFixed(2);
      svc.createOp({ kind, datetime: `${date}T12:00:00`, assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', quantity, unitPrice: price, currency: 'EUR', fxRate: '1', grossLocal: total, grossEur: total, totalEur: total, broker: 'kraken' });
    };
    db.withProfile(profile.id, () => {
      trade('buy', '2024-01-10', '1', '1000');
      trade('buy', '2024-02-10', '1', '2000');
      trade('sell', '2025-03-01', '1.5', '3000');
      trade('sell', '2025-04-01', '1', '3000');
    });
    const d = await (await request('/api/dossier/2025', profile.id)).json();
    expect(d.assets).toHaveLength(1);
    expect(d.assets[0]).toMatchObject({ assetId: 'ETH', section: 'F2. Monedas virtuales', proceedsEur: '7500.00' });
    expect(d.assets[0].sales[0]).toMatchObject({ date: '2025-03-01', proceedsEur: '4500.00', costEur: '2000.00', gainEur: '2500.00' });
    expect(d.assets[0].sales[0].lots.map((l: { date: string; quantity: string; flag: string | null }) => [l.date, l.quantity, l.flag])).toEqual([['2024-01-10', '1', null], ['2024-02-10', '0.5', null]]);
    expect(d.assets[0].sales[1].lots.map((l: { flag: string | null }) => l.flag)).toEqual([null, 'falta']);
    expect(d.notes.map((n: { text: string }) => n.text)).toContain('Una venta tiene una parte sin compra que la respalde: esa parte va con coste 0.');
    expect(d.foreign.forms).toHaveLength(2);
  });
});

describe('Inicio: extractos y fin de año', () => {
  const shift = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  const trade = (kind: 'buy' | 'sell', date: string, assetId: string, quantity: string, price: string, broker: 'degiro' | 'kraken' = 'degiro') => {
    const total = (Number(quantity) * Number(price)).toFixed(2);
    svc.createOp({ kind, datetime: `${date}T12:00:00`, assetId, assetName: assetId, assetClass: broker === 'kraken' ? 'crypto' : 'stock', quantity, unitPrice: price, currency: 'EUR', fxRate: '1', grossLocal: total, grossEur: total, totalEur: total, broker });
  };

  it('avisa de los brókers con datos de hace más de un mes en los que aún tienes algo', async () => {
    const profile = db.createProfile('Extractos');
    db.withProfile(profile.id, () => {
      trade('buy', shift(-90), 'ETH', '1', '100', 'kraken');
      trade('buy', shift(-3), 'AAA', '1', '100');
    });
    const items = (await (await request('/api/freshness', profile.id)).json()).items;
    expect(items.map((i: { broker: string; stale: boolean; lastImportAt: string | null }) => [i.broker, i.stale, i.lastImportAt])).toEqual([['kraken', true, null], ['degiro', false, null]]);
  });

  it('cuenta las pérdidas sin vender que compensan lo ganado este año, salvo las que se aplazarían', async () => {
    const profile = db.createProfile('Fin de año');
    const today = shift(0);
    db.withProfile(profile.id, () => {
      trade('buy', shift(-200), 'GAIN', '10', '100');
      trade('sell', today, 'GAIN', '10', '150');
      trade('buy', shift(-200), 'OLD', '10', '100');
      trade('buy', shift(-10), 'NEW', '10', '100');
      const quote = db.db.prepare('INSERT INTO quotes (asset_id, symbol, currency, price, price_eur, at, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      quote.run('OLD', 'OLD', 'EUR', '60', '60', today, `${today}T08:00:00Z`);
      quote.run('NEW', 'NEW', 'EUR', '90', '90', today, `${today}T08:00:00Z`);
    });
    const review = await (await request('/api/year-end', profile.id)).json();
    expect(review).toMatchObject({ gppBalanceEur: '500.00', latentLossEur: '-500.00', offsetEur: '400.00', marginalRate: '19', savingEur: '76.00' });
    expect(review.losses.map((l: { assetId: string; latentEur: string; recentBuy: boolean }) => [l.assetId, l.latentEur, l.recentBuy])).toEqual([['OLD', '-400.00', false], ['NEW', '-100.00', true]]);
  });
});
