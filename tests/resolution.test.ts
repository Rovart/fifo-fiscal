import { beforeEach, describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { CONNECTIVITY_FEE, CORPORATE_ACTION, REVOLUT_DIVIDEND, REVOLUT_ISIN, validIsin } from '../shared/review.ts';
import type { Operation } from '../shared/types.ts';
import { trade } from './helpers.ts';

process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const { heldBefore, matchDividend, resolveWarnings } = await import('../server/resolution.ts');
const { parseIsharesDividends, parseSecurityReferences } = await import('../server/reference.ts');
const { run } = await import('./helpers.ts');
const { issuesForYear } = await import('../server/engine/report.ts');
const source = 'https://example.test/public-dividend';
const event = { exDate: '2026-03-02', payDate: '2026-03-12', amount: '0.5', currency: 'USD', source };
const buy = (date = '2026-01-02', quantity = '20') => trade('buy', date, quantity, '10', { broker: 'revolut', assetId: 'EXAMPLE' });
const dividend = (extra: Partial<Operation> = {}): Operation => ({
  ...buy('2026-03-13'), kind: 'dividend', quantity: null, unitPrice: null, currency: 'USD', fxRate: '1.25',
  grossLocal: '8.50', grossEur: '6.80', totalEur: '6.80', feeEur: '0', otherCostsEur: '0', withholdingEur: '0',
  reviewReasons: [REVOLUT_DIVIDEND], ...extra,
});

describe('Conciliación de dividendos', () => {
  it('usa las acciones anteriores a la fecha exdividendo del mismo bróker, aunque ya se hayan vendido al cobrar', () => {
    const ops = [buy(), buy('2026-03-02', '10'), { ...buy('2026-01-02', '500'), broker: 'degiro' as const }, trade('sell', '2026-03-05', '20', '10', { broker: 'revolut', assetId: 'EXAMPLE' })];
    expect(heldBefore(ops, 'EXAMPLE', 'revolut', event.exDate).toFixed()).toBe('20');
    expect(matchDividend(dividend(), ops, [event])).toMatchObject({ grossLocal: '10.00', withholdingLocal: '1.50' });
  });
  it('reconoce una retención del 30 % y también un dividendo sin retención, sin imponer el 15 %', () => {
    expect(matchDividend(dividend({ grossLocal: '7.00' }), [buy()], [event])?.withholdingLocal).toBe('3.00');
    expect(matchDividend(dividend({ grossLocal: '10.00' }), [buy()], [event])?.withholdingLocal).toBe('0.00');
  });
  it('conserva el aviso cuando no hay compras, faltan datos, la divisa difiere o los importes no coinciden', () => {
    expect(matchDividend(dividend(), [], [event])).toBeNull();
    expect(matchDividend(dividend({ grossLocal: '7.53' }), [buy()], [event])).toBeNull();
    expect(matchDividend(dividend(), [buy()], [{ ...event, currency: 'EUR' }])).toBeNull();
    expect(matchDividend(dividend({ fxRate: null }), [buy()], [event])).toBeNull();
    expect(matchDividend(dividend(), [buy()], [{ ...event, payDate: '2026-03-14' }])).toBeNull();
  });
  it('no elige entre dos repartos posibles ni admite diferencias superiores a un céntimo', () => {
    expect(matchDividend(dividend(), [buy()], [event, { ...event, exDate: '2026-02-20' }])).toBeNull();
    expect(matchDividend(dividend({ grossLocal: '8.48' }), [buy()], [event])).toBeNull();
  });
  it('acota a cinco céntimos el efecto de distinta precisión por acción, y conserva la evidencia', () => {
    const precise = { ...event, amount: '0.123456' };
    const ops = [buy('2026-01-02', '1000')];
    expect(matchDividend(dividend({ grossLocal: '104.95' }), ops, [precise])?.grossLocal).toBe('123.46');
    expect(matchDividend(dividend({ grossLocal: '104.80' }), ops, [precise])).toBeNull();
    expect(matchDividend(dividend({ grossLocal: '85.04' }), [buy('2026-01-02', '1000')], [{ ...event, amount: '0.1' }])).toBeNull();
  });
});

describe('Fuentes públicas', () => {
  it('valida el dígito de control y no confunde acciones ordinarias con un ADR', () => {
    expect(validIsin('US0378331005')).toBe(true);
    expect(validIsin('US0378331006')).toBe(false);
    const text = 'mmSuggestDeliver(0,new Array(new Array("Ejemplo ADR","Stocks","EXAMPLE|US0378331005|EXAMPLE||","75"),new Array("Otra clase","Stocks","OTHER|US5949181045|OTHER||","75")))';
    expect(parseSecurityReferences(text, 'EXAMPLE').map((s) => s.isin)).toEqual(['US0378331005']);
    expect(parseSecurityReferences(text.replace('US0378331005', 'US0378331006'), 'EXAMPLE')).toEqual([]);
  });
  it('lee la precisión del emisor, conserva la fecha civil y excluye devoluciones de capital', () => {
    const props = { distributionTableData: [
      { name: 'exDate', formattedValue: ['May 01, 2026', 'Jun 01, 2026'] },
      { name: 'payableDate', formattedValue: ['May 06, 2026', 'Jun 04, 2026'] },
      { name: 'totalDistribution', formattedValue: ['0.123456', '0.500000'] },
      { name: 'incomeAmount', formattedValue: ['0.123456', '0.300000'] },
    ] };
    const html = `<div componentprops="${JSON.stringify(props).replaceAll('"', '&quot;')}"></div>`;
    expect(parseIsharesDividends(html, source)).toEqual([{ exDate: '2026-05-01', payDate: '2026-05-06', amount: '0.123456', currency: 'USD', source }]);
  });
});

describe('Revisión automática', () => {
  beforeEach(() => {
    db.db.exec('DELETE FROM operations; DELETE FROM op_history; DELETE FROM assets; DELETE FROM quotes; DELETE FROM settings');
  });
  const insert = (op: Operation) => { db.putOp({ ...op, original: { ...op } }); db.saveAsset({ id: op.assetId, name: op.assetId, class: 'stock', market: 'us' }); };

  it('completa ISIN, bruto y retención conservando el neto, las ediciones y el original restaurable', async () => {
    const acquisition = buy();
    acquisition.reviewReasons = [REVOLUT_ISIN];
    insert(acquisition);
    const payment = dividend();
    insert(payment);
    const reference = async () => ({ securities: [{ symbol: 'EXAMPLE', isin: 'US0378331005', name: 'Ejemplo', source }], dividends: [event], splits: [] });
    expect(await resolveWarnings(reference)).toMatchObject({ identities: 1, dividends: 1 });
    expect(db.getOp(payment.id)).toMatchObject({ assetId: 'US0378331005', grossLocal: '10.00', grossEur: '8.00', withholdingEur: '1.20', totalEur: '6.80', reviewReasons: [], resolutions: [{ code: 'isin' }, { code: 'dividend' }] });
    expect(svc.restoreOriginal(payment.id)).toMatchObject({ assetId: 'US0378331005', grossLocal: '10.00', totalEur: '6.80', reviewReasons: [] });
    expect(await resolveWarnings(reference)).toMatchObject({ identities: 0, dividends: 0 });
    expect(db.getHistory(payment.id).some((h) => h.action.includes('automáticamente'))).toBe(true);
  });

  it('no modifica una operación editada ni une un símbolo con dos ISIN posibles', async () => {
    const acquisition = buy(); acquisition.reviewReasons = [REVOLUT_ISIN]; insert(acquisition);
    const payment = dividend({ edited: true }); insert(payment);
    const ambiguous = async () => ({ securities: ['US0378331005', 'US5949181045'].map((isin) => ({ symbol: 'EXAMPLE', isin, name: 'Ejemplo', source })), dividends: [event], splits: [] });
    await resolveWarnings(ambiguous);
    expect(db.getOp(acquisition.id)?.assetId).toBe('EXAMPLE');
    expect(db.getOp(payment.id)).toMatchObject({ edited: true, grossLocal: '8.50', reviewReasons: [REVOLUT_DIVIDEND] });
  });

  it('un fallo de red deja el aviso pendiente y no interrumpe los cálculos', async () => {
    insert(buy()); insert(dividend());
    expect(await resolveWarnings(async () => { throw new Error('sin conexión'); })).toMatchObject({ dividends: 0 });
    expect(db.allOps().find((o) => o.kind === 'dividend')?.reviewReasons).toEqual([REVOLUT_DIVIDEND]);
  });

  it('reconoce las comisiones ya clasificadas sin pedir una confirmación repetida', async () => {
    const fee: Operation = { ...dividend(), broker: 'degiro', kind: 'fee', assetId: 'DEGIRO', feeClass: 'non_deductible', reviewReasons: [CONNECTIVITY_FEE] };
    insert(fee);
    expect(await resolveWarnings(async () => ({ securities: [], dividends: [], splits: [] }))).toMatchObject({ fees: 1 });
    expect(db.getOp(fee.id)?.reviewReasons).toEqual([]);
  });

  it('usa el ISIN de cada fecha y verifica el canje con la fecha y la proporción publicadas', async () => {
    const acquisition = buy('2025-01-02', '100'); acquisition.reviewReasons = [REVOLUT_ISIN]; insert(acquisition);
    const action: Operation = { ...buy('2025-06-02', '100'), broker: 'degiro', kind: 'isin_change', assetId: 'US0378331005', counterAsset: 'US5949181045', counterQuantity: '10', reviewReasons: [CORPORATE_ACTION] };
    insert(action);
    db.saveAsset({ id: 'US5949181045', name: 'Ejemplo nuevo', class: 'stock', market: 'us' });
    await resolveWarnings(async () => ({ securities: [{ symbol: 'EXAMPLE', isin: 'US5949181045', name: 'Ejemplo', source }], dividends: [], splits: [{ date: '2025-06-02', numerator: '1', denominator: '10', source }] }));
    expect(db.getOp(acquisition.id)?.assetId).toBe('US0378331005');
    expect(db.getOp(action.id)?.reviewReasons).toEqual([]);
    expect(svc.isinAtDate('US5949181045', '2025-01-02T12:00:00')).toBe('US0378331005');
  });
  it('reconoce un ticker europeo que empieza por número y conserva su historial de precios', async () => {
    const acquisition = { ...buy(), assetId: '6AQQ', reviewReasons: [REVOLUT_ISIN] }; insert(acquisition);
    db.saveSettings({ ...db.getSettings(), fifoStartDates: { '6AQQ': '2026-01-01' } });
    db.db.prepare('INSERT INTO price_history VALUES (?, ?, ?)').run('6AQQ', '2026-01', '10');
    await resolveWarnings(async () => ({ securities: [{ symbol: '6AQQ', isin: 'LU1681038243', name: 'ETF europeo', source }], class: 'etf', dividends: [], splits: [] }));
    expect(db.getOp(acquisition.id)?.assetId).toBe('LU1681038243');
    expect(db.listAssets().find((a) => a.id === 'LU1681038243')?.class).toBe('etf');
    expect(db.getSettings().fifoStartDates).toEqual({ LU1681038243: '2026-01-01' });
    expect(db.db.prepare('SELECT asset_id FROM price_history WHERE month = ?').get('2026-01')).toMatchObject({ asset_id: 'LU1681038243' });
    db.db.exec('DELETE FROM price_history');
  });
});

it('los avisos antiguos de ingresos y los informativos no reaparecen al vender ese activo años después', () => {
  const acquisition = buy('2024-01-02');
  const payment = dividend({ datetime: '2024-03-13T10:00:00', currency: 'EUR', fxRate: '1', grossEur: '8.50', totalEur: '8.50' });
  const sale = trade('sell', '2026-01-02', '10', '12', { broker: 'revolut', assetId: 'EXAMPLE' });
  const result = run([acquisition, payment, sale]);
  expect(issuesForYear(result, 2024).some((i) => i.opId === payment.id)).toBe(true);
  expect(issuesForYear(result, 2026).some((i) => i.opId === payment.id)).toBe(false);
  expect(D(result.disposals[0]!.quantity).eq(10)).toBe(true);
});
