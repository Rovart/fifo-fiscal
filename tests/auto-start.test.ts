import { describe, expect, it } from 'vitest';
import { buildYearReport, issuesForYear } from '../server/engine/report.ts';
import { runEngine } from '../server/engine/fifo.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { run, trade } from './helpers.ts';

const crypto = { assetClass: 'crypto' as const, broker: 'kraken' as const };
const btc = (kind: 'buy' | 'sell', date: string, qty: string, price: string) => trade(kind, date, qty, price, { ...crypto, assetId: 'BTC', assetName: 'Bitcoin' });
const settings = { lastFiledYear: 2025 };
const calculate = (ops: Operation[], automatic: boolean) => run(ops, { ...settings, fifoAutoStart: automatic }, () => '1', '2026-11-03');

describe('Recálculo automático del FIFO', () => {
  it('empieza en abril tras vender todo en enero, incluso si después se retira a una cartera propia', () => {
    const ops: Operation[] = [
      btc('buy', '2020-01-01', '1', '100'),
      { ...btc('buy', '2021-01-01', '1', '0'), kind: 'transfer_out' },
      { ...btc('buy', '2025-01-01', '1', '0'), kind: 'transfer_in' },
      btc('sell', '2025-01-02', '1', '200'),
      trade('sell', '2022-01-01', '10', '1', { ...crypto, assetId: 'USDC' }),
      btc('buy', '2025-04-07', '0.5', '200'),
      { ...btc('buy', '2025-05-01', '0.5', '0'), kind: 'transfer_out' },
    ];
    const original = JSON.stringify(ops), full = calculate(ops, false), cut = calculate(ops, true);
    expect(full.issues.some((i) => i.assetId === 'USDC' && i.code === 'missing_lots')).toBe(true);
    expect(cut.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2025-04-07', USDC: '2026-01-01' }, previousOperations: 5 });
    expect(cut.positions.filter((p) => p.assetId === 'BTC')).toEqual(full.positions.filter((p) => p.assetId === 'BTC'));
    expect(cut.openLots).toMatchObject([{ acqDate: '2025-04-07T10:00:00', costEur: '100' }]);
    expect(cut.issues.some((i) => i.assetId === 'USDC' && i.settled)).toBe(true);
    expect(issuesForYear(cut, 2026).some((i) => i.assetId === 'USDC')).toBe(false);
    expect(cut.disposals.some((d) => d.year === 2025)).toBe(true);
    expect(JSON.stringify(ops)).toBe(original);
  });

  it('no confunde un saldo cero en el exchange con vender el BTC que sigue fuera', () => {
    const ops: Operation[] = [btc('buy', '2020-01-01', '1', '100'), { ...btc('buy', '2025-01-01', '1', '0'), kind: 'transfer_out' }, btc('buy', '2025-04-07', '0.5', '200')];
    const cut = calculate(ops, true), full = calculate(ops, false);
    expect(cut.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2020-01-01' } });
    expect(cut.positions).toEqual(full.positions);
    expect(cut.positions[0]).toMatchObject({ quantity: '1.5', costEur: '200', byBroker: { externo: '1' } });
  });

  it('conserva compras antiguas necesarias para una venta del año sin presentar', () => {
    const ops = [btc('buy', '2024-01-01', '1', '100'), btc('sell', '2026-02-01', '1', '200')];
    const cut = calculate(ops, true), full = calculate(ops, false);
    expect(cut.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2024-01-01' } });
    expect(cut.disposals).toEqual(full.disposals);
  });

  it.each(['2026-12-01', '2026-02-01'])('conserva el coste de una pérdida bloqueada o liberada al vender el %s', (date) => {
    const ops = [trade('buy', '2024-01-01', '10', '10'), trade('sell', '2025-12-01', '10', '5'), trade('buy', '2025-12-15', '10', '6'), trade('sell', date, '10', '7')];
    const cut = calculate(ops, true), full = calculate(ops, false);
    expect(cut.fifoAuto?.verified).toBe(true);
    const before = buildYearReport(full, { ...DEFAULT_SETTINGS, ...settings }, 2026);
    const after = buildYearReport(cut, { ...DEFAULT_SETTINGS, ...settings }, 2026);
    expect(after.savings).toEqual(before.savings);
    expect(after.deferred.released).toBe(before.deferred.released);
    expect(after.deferred.pendingEnd).toBe(before.deferred.pendingEnd);
    expect(after.sections).toEqual(before.sections);
  });

  it('mantiene el FIFO de divisas de un ciclo cerrado sin arrastrar sus errores cripto', () => {
    const old = trade('sell', '2022-01-01', '10', '1', { ...crypto, assetId: 'USDC', settleCurrency: 'AUD' });
    const spend: Operation = { ...trade('sell', '2026-01-01', '5', '1', { assetId: 'AUD', currency: 'AUD' }), kind: 'fx', counterAsset: 'EUR', counterQuantity: '5' };
    const ops = [old, spend], cut = calculate(ops, true), full = calculate(ops, false);
    expect(cut.fifoAuto).toMatchObject({ verified: true, previousOperations: 1 });
    expect(cut.positions).toEqual(full.positions);
    const financial = (result: ReturnType<typeof calculate>) => result.disposals.filter((d) => d.year === 2026).map((d) => [d.opId, d.assetId, d.quantity, d.costEur, d.proceedsEur, d.gainEur, d.matches.map((m) => [m.acqOpId, m.acqDate, m.quantity, m.costEur])]);
    expect(financial(cut)).toEqual(financial(full));
    expect(issuesForYear(cut, 2026).some((i) => i.assetId === 'USDC')).toBe(false);
  });

  it('sin última Renta presentada conserva los resultados de todos los ejercicios', () => {
    const ops = [btc('buy', '2020-01-01', '1', '100'), btc('sell', '2021-01-01', '1', '200'), btc('buy', '2025-04-07', '0.5', '200')];
    const cut = run(ops, { fifoAutoStart: true }), full = run(ops);
    expect(cut.fifoAuto).toMatchObject({ verified: true, previousOperations: 0 });
    expect(cut.disposals).toEqual(full.disposals);
  });

  it('usa un saldo cero confirmado para resolver un historial externo incompleto y deduce la recompra', () => {
    const ops: Operation[] = [btc('buy', '2020-01-01', '1', '100'), { ...btc('buy', '2021-01-01', '1', '0'), kind: 'transfer_out' }, btc('buy', '2025-04-07', '0.5', '200'), btc('sell', '2026-01-01', '0.1', '300')];
    const full = calculate(ops, true);
    expect(full.positions[0]?.quantity).toBe('1.4');
    const confirmed = { BTC: { month: '2025-01', note: 'El titular confirma que vendió todo, incluidas sus carteras externas.' } };
    const cut = run(ops, { ...settings, fifoAutoStart: true, fifoConfirmedClosures: confirmed }, () => '1', '2026-11-03');
    expect(cut.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2025-04-07' }, previousOperations: 2 });
    expect(cut.positions[0]).toMatchObject({ quantity: '0.4', costEur: '80' });
    expect(cut.disposals[0]).toMatchObject({ date: '2026-01-01', costEur: '20', proceedsEur: '30' });
    expect(cut.disposals).toHaveLength(1);
    expect(ops).toHaveLength(4);
    expect(confirmed.BTC.month).toBe('2025-01');
  });

  it('no utiliza una confirmación para borrar resultados de un ejercicio sin presentar', () => {
    const ops = [btc('buy', '2025-01-01', '1', '100'), btc('sell', '2026-01-01', '1', '200')];
    const result = run(ops, { ...settings, fifoAutoStart: true, fifoConfirmedClosures: { BTC: { month: '2026-01', note: 'Saldo cero.' } } });
    expect(result.disposals[0]).toMatchObject({ costEur: '100', gainEur: '100' });
  });

  it('un cierre confirmado tampoco inventa el coste de cripto que llega después', () => {
    const ops: Operation[] = [btc('buy', '2020-01-01', '1', '100'), { ...btc('buy', '2025-04-07', '0.5', '0'), kind: 'transfer_in' }, btc('sell', '2026-01-01', '0.1', '300')];
    const result = run(ops, { ...settings, fifoAutoStart: true, fifoConfirmedClosures: { BTC: { month: '2025-01', note: 'Saldo cero.' } } });
    expect(result.issues.some((i) => i.code === 'missing_lots' && i.year === 2026)).toBe(true);
    expect(result.disposals[0]?.shortfall).toBe('0.1');
  });
  it('no elimina una venta simulada de un año ya presentado', () => {
    const sim = { ...btc('sell', '2025-06-01', '1', '200'), simulated: true };
    const result = calculate([btc('buy', '2024-01-01', '1', '100'), sim, btc('buy', '2026-01-01', '1', '300')], true);
    expect(result.disposals.find((d) => d.opId === sim.id)).toMatchObject({ gainEur: '100' });
  });
  it('conserva el lote consumido por una comisión sin convertirla en venta ni retener ciclos anteriores', () => {
    const fee: Operation = { ...btc('buy', '2026-01-01', '0.1', '0'), kind: 'fee', feeClass: 'non_deductible' };
    const ops = [btc('buy', '2020-01-01', '1', '100'), btc('sell', '2021-01-01', '1', '200'), btc('buy', '2024-01-01', '0.1', '100'), btc('buy', '2025-01-01', '0.5', '200'), fee];
    const cut = calculate(ops, true);
    expect(cut.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2024-01-01' }, previousOperations: 2 });
    expect(cut.positions[0]).toMatchObject({ quantity: '0.5', costEur: '100' });
    expect(cut.disposals.some((d) => d.year === 2026)).toBe(false);
    expect(cut.disposals.some((d) => d.year === 2021)).toBe(true);
  });
  it('un saldo cero reinicia solo el inventario y conserva ventas, ingresos y cierres mensuales anteriores', () => {
    const income: Operation = { ...btc('buy', '2024-06-01', '0', '0'), kind: 'interest', grossLocal: '10', grossEur: '10', totalEur: '10' };
    const ops: Operation[] = [btc('buy', '2020-01-01', '1', '100'), income, btc('sell', '2025-01-15', '0.2', '200'), btc('buy', '2025-04-07', '0.5', '300'), btc('sell', '2026-02-01', '0.1', '400')];
    const configured = { ...DEFAULT_SETTINGS, ...settings, fifoConfirmedClosures: { BTC: { month: '2025-01', note: 'Saldo total cero confirmado por el titular.' } } };
    const input = { ops, assets: new Map(), settings: configured, rateAt: () => null, today: '2026-11-03', monthly: true };
    const full = runEngine(input), automatic = runEngine({ ...input, settings: { ...configured, fifoAutoStart: true } });
    expect(automatic.disposals.map((d) => d.year)).toEqual([2025, 2026]);
    expect(automatic.incomes[0]).toMatchObject({ year: 2024, grossEur: '10' });
    expect(automatic.snapshots[2024]?.find((p) => p.assetId === 'BTC')?.quantity).toBe('1');
    expect(automatic.monthly?.['2025-01']?.some((p) => p.assetId === 'BTC')).toBe(false);
    expect(automatic.positions[0]).toMatchObject({ quantity: '0.4', costEur: '120' });
    expect(automatic.inventoryResets).toMatchObject([{ date: '2025-01-31', quantityBefore: '0.8' }]);
    expect(buildYearReport(automatic, configured, 2025).sections).toEqual(buildYearReport(full, configured, 2025).sections);
    expect(automatic.years).toContain(2020);
  });
});
