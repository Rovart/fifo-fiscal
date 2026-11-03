import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { applyEdit, reconcile } from '../shared/reconcile.ts';
import type { Operation } from '../shared/types.ts';

process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const { exportYear } = await import('../server/export.ts');

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const find = (p: (o: Operation) => boolean) => db.allOps().find(p) as Operation;

beforeAll(() => db.seedRatesIfEmpty());

describe('Flujo completo', () => {
  it('importa, no duplica al repetir y usa tipos reales del BCE', () => {
    const a = svc.commitImport('Transactions.csv', fx('degiro_transactions_es.csv'));
    expect(a.newOps).toBe(4);
    const again = svc.commitImport('Transactions.csv', fx('degiro_transactions_es.csv'));
    expect(again.newOps).toBe(0);
    expect(again.duplicates).toBe(4);
    svc.commitImport('Account.csv', fx('degiro_account_es.csv'));
    const div = find((o) => o.kind === 'dividend');
    expect(div.fxSource).toBe('ecb');
    expect(D(div.fxRate).gt(1)).toBe(true);
    expect(reconcile(div).ok).toBe(true);
    // Tributo cuya compra aún no existe: queda como comisión a revisar.
    const orphan = find((o) => o.sourceKey?.startsWith('dg-itf:') ?? false);
    expect(orphan.kind).toBe('fee');
    expect(orphan.reviewReasons?.[0]).toMatch(/sin compra o venta/);
  });

  it('el tributo pasa al coste en cuanto llega su operación', () => {
    const csv = `Fecha,Hora,Producto,ISIN,Bolsa de,Centro de ejecución,Número,Precio,,Valor local,,Valor,,Tipo de cambio,Costes de transacción,,Total,,ID Orden
05-02-2024,09:15,BANCO SANTANDER SA,ES0113900J37,MAD,XMAD,100,"4,0000",EUR,"-400,00",EUR,"-400,00",EUR,,"-2,00",EUR,"-402,00",EUR,eeee-5555
`;
    svc.commitImport('Santander.csv', csv);
    const buy = find((o) => o.assetId === 'ES0113900J37' && o.kind === 'buy');
    expect(buy).toMatchObject({ otherCostsEur: '3.00', feeEur: '2.00', totalEur: '405.00' });
    expect(reconcile(buy).ok).toBe(true);
    expect(db.allOps().some((o) => o.sourceKey?.startsWith('dg-itf:'))).toBe(false);
    svc.commitImport('Account.csv', fx('degiro_account_es.csv'));
    expect(find((o) => o.assetId === 'ES0113900J37' && o.kind === 'buy').totalEur).toBe('405.00');
  });

  it('rechaza una edición que no cuadra y acepta la que sí', () => {
    const sell = find((o) => o.kind === 'sell' && o.assetId === 'US0378331005');
    expect(() => svc.updateOp(sell.id, { totalEur: '999.99' })).toThrow(/no cuadra/);
    expect(find((o) => o.id === sell.id).totalEur).toBe('1012.25');
    const edited = svc.updateOp(sell.id, applyEdit(sell, 'feeEur', '5'));
    expect(edited).toMatchObject({ feeEur: '5', totalEur: '1008.25', edited: true });
    const disposal = svc.engine().disposals.find((d) => d.opId === sell.id)!;
    expect(D(disposal.proceedsEur).toNumber()).toBe(1008.25);
    expect(db.getHistory(sell.id)[0]!.action).toBe('editada');
  });

  it('restaura los valores importados', () => {
    const sell = find((o) => o.kind === 'sell' && o.assetId === 'US0378331005');
    const back = svc.restoreOriginal(sell.id);
    expect(back).toMatchObject({ feeEur: '1.00', totalEur: '1012.25', edited: false });
  });

  it('las ediciones sobreviven a reimportar', () => {
    const sell = find((o) => o.kind === 'sell' && o.assetId === 'US0378331005');
    svc.updateOp(sell.id, applyEdit(sell, 'feeEur', '4'));
    svc.commitImport('Transactions.csv', fx('degiro_transactions_es.csv'));
    expect(find((o) => o.id === sell.id).feeEur).toBe('4');
    svc.restoreOriginal(sell.id);
  });

  it('valora permutas y staking con un precio dado y cuadra', () => {
    svc.commitImport('ledgers.csv', fx('kraken_ledgers.csv'));
    const swap = find((o) => o.kind === 'swap');
    expect(swap.grossEur).toBeNull();
    const swapIssues = svc.engine().issues.filter((i) => i.opId === swap.id);
    expect(swapIssues.map((i) => i.code)).toEqual(['missing_valuation']);
    expect(() => svc.updateOp(swap.id, { note: 'x' })).toThrow(/no cuadra/);
    const priced = applyEdit({ ...swap, currency: 'EUR', fxRate: '1' }, 'unitPrice', '55000');
    const saved = svc.updateOp(swap.id, priced);
    expect(saved).toMatchObject({ grossEur: '550.00', totalEur: '550.00' });
    const eth = svc.engine().openLots.find((l) => l.assetId === 'ETH' && D(l.costEur).eq(550));
    expect(eth).toBeTruthy();
  });

  it('el saldo de Kraken se compara con lo calculado', () => {
    const c = svc.checks();
    const btc = c.positions.find((p) => p.broker === 'kraken' && p.assetId === 'BTC')!;
    expect(btc.declared).toBe('0.0199');
    expect(btc.computed).toBe('0.0199');
    expect(btc.ok).toBe(true);
  });

  it('simula una venta sin guardar nada', () => {
    const before = db.allOps().length;
    const sim = svc.simulateSales({ sales: [{ assetId: 'US0378331005', quantity: '5', priceEur: '100', feeEur: '1' }], date: '2026-11-02' });
    const sale = sim.sales[0]!;
    expect(sale.matches[0]?.acqDate.slice(0, 10)).toBe('2024-01-12');
    expect(D(sale.gainEur).lt(0)).toBe(true);
    expect(sale.safeRebuyFrom).toBe('2027-01-02');
    expect(db.allOps().length).toBe(before);
    expect(sale.releasedEur).toBe('0.00');
    expect(sim.gainEur).toBe(sale.gainEur);
  });

  it('calcula varias ventas juntas y, sin ventas, deja lo que se paga igual', () => {
    const none = svc.simulateSales({ sales: [], date: '2026-11-02' });
    expect(none.sales).toEqual([]);
    expect(none.payAfter).toBe(none.payBefore);
    expect(none.usedLossEur).toBe('0.00');
    const held = svc.engine().positions.filter((p) => p.class !== 'fx' && D(p.quantity).gt(0)).slice(0, 2);
    expect(held).toHaveLength(2);
    const sale = (p: (typeof held)[number]) => ({ assetId: p.assetId, quantity: D(p.quantity).div(2).toFixed(), priceEur: '1' });
    const both = svc.simulateSales({ sales: held.map(sale), date: '2026-11-02' });
    expect(both.sales.map((s) => s.assetId)).toEqual(held.map((p) => p.assetId));
    expect(D(both.proceedsEur).toFixed(2)).toBe(both.sales.reduce((s, x) => s.plus(D(x.proceedsEur)), D(0)).toFixed(2));
    const one = (p: (typeof held)[number]) => svc.simulateSales({ sales: [sale(p)], date: '2026-11-02' }).sales[0]!.gainEur;
    expect(both.sales.map((s) => s.gainEur)).toEqual(held.map(one));
  });

  it('marca la pérdida útil y lo que pasa a años siguientes', () => {
    const held = svc.engine().positions.filter((p) => p.class !== 'fx' && D(p.quantity).gt(0));
    const all = held.map((p) => ({ assetId: p.assetId, quantity: p.quantity, priceEur: '0.01' }));
    const sim = svc.simulateSales({ sales: all, date: '2026-11-02' });
    expect(D(sim.usedLossEur).lte(D(sim.usefulLossEur))).toBe(true);
    if (D(sim.usefulLossEur).gt(0)) expect(sim.usedLossEur).toBe(sim.usefulLossEur);
    expect(D(sim.extraLossEur).gt(0)).toBe(true);
    expect(D(sim.payAfter).lte(D(sim.payBefore))).toBe(true);
  });

  it('deshacer una importación retira sus operaciones', () => {
    const r = svc.commitImport('tr.csv', fx('trade_republic.csv'));
    expect(db.allOps().some((o) => o.broker === 'trade_republic')).toBe(true);
    expect(svc.undoImport(r.importId)).toBe(r.newOps);
    expect(db.allOps().some((o) => o.broker === 'trade_republic')).toBe(false);
    expect(svc.commitImport('tr.csv', fx('trade_republic.csv')).newOps).toBe(r.newOps);
    expect(db.allOps().some((o) => o.broker === 'trade_republic')).toBe(true);
    svc.undoImport(db.allOps().find((o) => o.broker === 'trade_republic')!.importId!);
  });

  it('exporta un Excel con todas las hojas', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const buf = await exportYear(2025);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf.buffer as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Resumen', 'Renta Web', 'Transmisiones FIFO', 'Pérdidas diferidas', 'Dividendos e intereses', 'Doble imposición', 'Posición 31-12-2025', 'Operaciones']);
    const web = wb.getWorksheet('Renta Web')!;
    expect(web.rowCount).toBeGreaterThan(1);
  });
});

describe('Cuadre', () => {
  const buy: Operation = {
    id: 'x', broker: 'manual', kind: 'buy', datetime: '2025-01-01T10:00:00', assetId: 'A', assetName: 'A', assetClass: 'stock', quantity: '10', unitPrice: '150.25', currency: 'USD', fxRate: '1.25',
    grossLocal: '1502.50', grossEur: '1202.00', feeEur: '2.00', otherCostsEur: '1.00', withholdingEur: '0', totalEur: '1205.00', settleCurrency: 'EUR',
  };
  it('propaga cantidad, precio y tipo hasta el total', () => {
    expect(reconcile(buy).ok).toBe(true);
    const q = applyEdit(buy, 'quantity', '20');
    expect(q).toMatchObject({ grossLocal: '3005.00', grossEur: '2404.00', totalEur: '2407.00' });
    const r = applyEdit(buy, 'fxRate', '1.5');
    expect(r).toMatchObject({ grossEur: '1001.67', totalEur: '1004.67' });
    for (const o of [q, r]) expect(reconcile(o).ok).toBe(true);
  });
  it('un cambio de importe en euros ajusta el tipo; uno de importe en divisa, el precio', () => {
    const e = applyEdit(buy, 'grossEur', '1300');
    expect(e.totalEur).toBe('1303.00');
    expect(reconcile(e).ok).toBe(true);
    const l = applyEdit(buy, 'grossLocal', '1600');
    expect(l.unitPrice).toBe('160');
    expect(reconcile(l).ok).toBe(true);
  });
  it('un cambio de total lo absorbe el importe o la comisión, a elección', () => {
    const g = applyEdit(buy, 'totalEur', '1300', 'gross');
    expect(g).toMatchObject({ grossEur: '1297.00', totalEur: '1300.00' });
    expect(reconcile(g).ok).toBe(true);
    const f = applyEdit(buy, 'totalEur', '1210', 'fee');
    expect(f).toMatchObject({ feeEur: '7.00', grossEur: '1202.00' });
    expect(reconcile(f).ok).toBe(true);
  });
  it('sin recálculo detecta el descuadre y propone cómo arreglarlo', () => {
    const bad = { ...buy, totalEur: '1210.00' };
    const r = reconcile(bad);
    expect(r.ok).toBe(false);
    const line = r.checks.find((c) => !c.ok)!;
    expect(line.diff).toBe('5');
    expect(line.fix?.map((x) => x.field)).toEqual(['totalEur', 'feeEur']);
    expect(line.fix?.[1]?.value).toBe('7.00');
  });
  it('respeta el margen de redondeo', () => {
    expect(reconcile({ ...buy, totalEur: '1205.02' }).ok).toBe(true);
    expect(reconcile({ ...buy, totalEur: '1205.03' }).ok).toBe(false);
  });
  it('dividendo: bruto, retención y neto', () => {
    const d: Operation = { ...buy, kind: 'dividend', quantity: null, unitPrice: null, grossLocal: '100', fxRate: '1.25', grossEur: '80', withholdingEur: '12', feeEur: '0', otherCostsEur: '0', totalEur: '68' };
    expect(reconcile(d).ok).toBe(true);
    expect(applyEdit(d, 'withholdingEur', '20').totalEur).toBe('60.00');
    expect(applyEdit(d, 'totalEur', '70').withholdingEur).toBe('10.00');
  });
});

describe('Quitar un fichero', () => {
  const trades = `Fecha,Hora,Producto,ISIN,Bolsa de referencia,Centro de ejecución,Número,Precio,,Valor local,,Valor EUR,Tipo de cambio,Comisión AutoFX,Costes de transacción y/o externos EUR,Total EUR,ID Orden
01-03-2026,10:00,EJEMPLO HK,HK0000000001,HKS,X,100,"10,0000",EUR,"-1000,00",EUR,"-1000,00","0,0000","0,00","-2,00","-1002,00",hk-1
`;
  const account = `Fecha,Hora,Fecha valor,Producto,ISIN,Descripción,Tipo,Variación,,Saldo,,ID Orden
01-03-2026,10:00,01-03-2026,EJEMPLO HK,HK0000000001,Hong Kong Stamp Duty,,EUR,"-1,50",EUR,"10,00",hk-1
`;
  const buy = () => find((o) => o.assetId === 'HK0000000001' && o.kind === 'buy');

  it('retira el tributo que aportó, y volver a subirlo no lo duplica', () => {
    svc.commitImport('T.csv', trades);
    const a1 = svc.commitImport('A.csv', account);
    expect(buy()).toMatchObject({ otherCostsEur: '1.50', totalEur: '1003.50' });
    svc.commitImport('A.csv', account);
    expect(buy().otherCostsEur).toBe('1.50');
    svc.undoImport(a1.importId);
    expect(buy()).toMatchObject({ otherCostsEur: '0.00', totalEur: '1002.00' });
    svc.commitImport('A.csv', account);
    expect(buy()).toMatchObject({ otherCostsEur: '1.50', totalEur: '1003.50' });
  });

  it('quitar y volver a subir los dos ficheros deja lo mismo', () => {
    const ids = db.db.prepare("SELECT id FROM imports WHERE file IN ('T.csv', 'A.csv')").all() as { id: string }[];
    for (const r of ids) svc.undoImport(r.id);
    expect(db.allOps().some((o) => o.assetId === 'HK0000000001')).toBe(false);
    svc.commitImport('T.csv', trades);
    svc.commitImport('A.csv', account);
    expect(buy()).toMatchObject({ otherCostsEur: '1.50', totalEur: '1003.50' });
    expect(db.allOps().filter((o) => o.assetId === 'HK0000000001')).toHaveLength(1);
  });
});

describe('Revisión y edición guiada', () => {
  it('confirmar un motivo no marca la operación como editada', () => {
    const r = svc.commitImport('tr.csv', fx('trade_republic_formato.csv'));
    const div = find((o) => o.broker === 'trade_republic' && o.kind === 'sell' && !!o.reviewReasons?.length);
    const reason = div.reviewReasons![0]!;
    expect(svc.engine().issues.some((i) => i.code === 'needs_review' && i.opId === div.id && i.reason === reason)).toBe(true);
    expect(svc.confirmReview([div.id], reason)).toBe(1);
    const after = find((o) => o.id === div.id);
    expect(after.reviewReasons).toEqual([]);
    expect(after.edited).toBeFalsy();
    expect(svc.engine().issues.some((i) => i.code === 'needs_review' && i.opId === div.id)).toBe(false);
    svc.undoImport(r.importId);
  });

  it('un total distinto lo absorbe la comisión; si no puede, el importe', () => {
    const buy = find((o) => o.kind === 'buy' && o.assetId === 'US5949181045' || o.kind === 'buy');
    const sell: Operation = { ...buy, kind: 'sell', currency: 'EUR', fxRate: '1', quantity: '10', unitPrice: '100', grossLocal: '1000.00', grossEur: '1000.00', feeEur: '1.00', otherCostsEur: '0', totalEur: '999.00' };
    const smaller = applyEdit(sell, 'totalEur', '990', 'auto');
    expect(smaller).toMatchObject({ feeEur: '10.00', grossEur: '1000.00' });
    const larger = applyEdit(sell, 'totalEur', '1100', 'auto');
    expect(larger).toMatchObject({ grossEur: '1101.00', unitPrice: '110.1' });
    for (const o of [smaller, larger]) expect(reconcile(o).ok).toBe(true);
  });

  it('cada línea de cuadre dice a qué campo pertenece', () => {
    const bad: Operation = { ...find((o) => o.kind === 'sell' && !!o.grossEur), totalEur: '1.00' };
    const failing = reconcile(bad).checks.filter((c) => !c.ok);
    expect(failing[0]!.field).toBe('totalEur');
    const noValue = reconcile({ ...bad, grossEur: null });
    expect(noValue.missingFields).toContain('grossEur');
  });
});

describe('Un nombre por ISIN', () => {
  const ISIN = 'IE0000000077';
  const op = (o: Partial<Operation>): Partial<Operation> => ({
    assetId: ISIN, assetClass: 'etf', currency: 'EUR', fxRate: '1', settleCurrency: 'EUR', feeEur: '0', otherCostsEur: '0', withholdingEur: '0', ...o,
  });

  it('usa el primer nombre en todo y guarda el del bróker aparte', () => {
    const buy = svc.createOp(op({ broker: 'degiro', kind: 'buy', datetime: '2024-01-10T10:00:00', assetName: 'GLOBAL BOND UCITS ETF', quantity: '10', unitPrice: '10', grossLocal: '100.00', grossEur: '100.00', totalEur: '100.00' }));
    const sell = svc.createOp(op({ broker: 'trade_republic', kind: 'sell', datetime: '2024-02-10T10:00:00', assetName: 'Global Bond (Acc)', quantity: '4', unitPrice: '12', grossLocal: '48.00', grossEur: '48.00', totalEur: '48.00' }));
    const similar = svc.createOp(op({ broker: 'trade_republic', kind: 'buy', datetime: '2024-03-10T10:00:00', assetName: 'Global Bond', quantity: '1', unitPrice: '10', grossLocal: '10.00', grossEur: '10.00', totalEur: '10.00' }));

    const res = svc.engine();
    expect(res.disposals.find((d) => d.opId === sell.id)?.assetName).toBe('GLOBAL BOND UCITS ETF');
    expect(res.positions.find((p) => p.assetId === ISIN)?.assetName).toBe('GLOBAL BOND UCITS ETF');
    expect(db.getOp(sell.id)?.assetName).toBe('Global Bond (Acc)');
    expect(svc.brokerNames()[ISIN]).toEqual([{ broker: 'trade_republic', name: 'Global Bond (Acc)' }]);

    // Guardar sin tocar el nombre no renombra; cambiarlo sí, en todos los movimientos.
    svc.updateOp(sell.id, { assetName: 'Global Bond (Acc)', note: 'revisada' });
    expect(svc.assetsMap().get(ISIN)?.name).toBe('GLOBAL BOND UCITS ETF');
    svc.updateOp(sell.id, { assetName: 'GLOBAL BOND UCITS ETF' });
    expect(svc.assetsMap().get(ISIN)?.name).toBe('GLOBAL BOND UCITS ETF');
    svc.updateOp(sell.id, { assetName: 'Mi ETF' });
    expect(svc.assetsMap().get(ISIN)?.name).toBe('Mi ETF');
    expect(svc.engine().positions.find((p) => p.assetId === ISIN)?.assetName).toBe('Mi ETF');

    for (const o of [buy, sell, similar]) svc.deleteOp(o.id);
  });
});

describe('Mercado de un activo', () => {
  const csv = (isin: string, order: string) => `Fecha,Hora,Producto,ISIN,Bolsa de referencia,Centro de ejecución,Número,Precio,,Valor local,,Valor EUR,Tipo de cambio,Comisión AutoFX,Costes de transacción y/o externos EUR,Total EUR,ID Orden
10-01-2024,10:00,ETF DE PRUEBA,${isin},LSE,XLON,10,"10,00",EUR,"-100,00",EUR,"-100,00",,,,"-100,00",${order}
`;
  const importing = (isin: string, order: string) => svc.undoImport(svc.commitImport(`${order}.csv`, csv(isin, order)).importId);

  it('una importación corrige el mercado por defecto', () => {
    db.saveAsset({ id: 'IE00BX000001', name: 'ETF', class: 'etf', market: 'eu' });
    importing('IE00BX000001', 'mercado-a');
    expect(svc.assetsMap().get('IE00BX000001')?.market).toBe('other');
  });

  it('pero no el que eligió el usuario', () => {
    db.saveAsset({ id: 'IE00BX000002', name: 'ETF', class: 'etf', market: 'eu', marketByUser: true });
    importing('IE00BX000002', 'mercado-b');
    expect(svc.assetsMap().get('IE00BX000002')?.market).toBe('eu');
  });
});

describe('Símbolos de Revolut', () => {
  it('une al ISIN conocido o pide que se indique', () => {
    db.saveAsset({ id: 'US00000000A1', name: 'Conocida', class: 'stock', market: 'us', ticker: 'AAPL' });
    const r = svc.commitImport('rev.csv', fx('revolut_stocks.csv'));
    expect(db.allOps().filter((o) => o.broker === 'revolut' && o.assetId === 'AAPL')).toEqual([]);
    expect(db.allOps().filter((o) => o.broker === 'revolut' && o.assetId === 'US00000000A1').length).toBeGreaterThan(2);
    const orcl = db.allOps().filter((o) => o.assetId === 'ORCL');
    expect(orcl[0]!.reviewReasons?.[0]).toMatch(/no da el ISIN/);

    expect(() => svc.setAssetIsin('ORCL', 'no vale')).toThrow(/ISIN/);
    svc.setAssetIsin('ORCL', 'us0000000077');
    const moved = db.allOps().filter((o) => o.assetId === 'US0000000077');
    expect(moved).toHaveLength(orcl.length);
    expect(moved[0]!.reviewReasons).toEqual([]);
    expect(svc.assetsMap().has('ORCL')).toBe(false);
    expect(svc.assetsMap().get('US0000000077')).toMatchObject({ ticker: 'ORCL', class: 'stock' });
    svc.undoImport(r.importId);
  });
});
