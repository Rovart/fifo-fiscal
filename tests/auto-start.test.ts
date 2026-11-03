import { describe, expect, it } from 'vitest';
import { buildYearReport, issuesForYear } from '../server/engine/report.ts';
import { runEngine } from '../server/engine/fifo.ts';
import { fifoHistory } from '../server/engine/history.ts';
import { D } from '../shared/decimal.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { ASSETS, run, trade } from './helpers.ts';

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
  it('en un ejercicio presentado deja como información los avisos que ya no afectan al FIFO', () => {
    const usdc = { ...crypto, assetId: 'USDC', assetName: 'USD Coin' };
    const ops: Operation[] = [
      { ...trade('buy', '2025-01-01', '100', '0', usdc), kind: 'transfer_in' }, trade('sell', '2025-01-02', '100', '1', usdc),
      { ...trade('buy', '2026-02-01', '50', '0', usdc), kind: 'transfer_in' }, trade('sell', '2026-02-02', '50', '1', usdc),
    ];
    const res = calculate(ops, true);
    expect(issuesForYear(res, 2025).filter((i) => i.severity === 'error')).toHaveLength(1);
    const filed = issuesForYear(res, 2025, 2025);
    expect(filed.filter((i) => i.severity !== 'info')).toEqual([]);
    expect(filed.some((i) => i.code === 'missing_lots' && i.message.startsWith('Ejercicio presentado'))).toBe(true);
    expect(buildYearReport(res, { ...DEFAULT_SETTINGS, ...settings }, 2025).issues.every((i) => i.severity === 'info')).toBe(true);
    // Una venta sin coste de un ejercicio abierto sigue pendiente aunque ya no quede saldo.
    expect(issuesForYear(res, 2026, 2025).filter((i) => i.severity === 'error')).toHaveLength(1);
  });
  it('la fecha de inicio usa lo verificado en cada activo aunque queden restos de ciclos cerrados', () => {
    const ops: Operation[] = [trade('sell', '2023-09-11', '10', '5'), btc('buy', '2025-04-07', '0.5', '200')];
    const input = { ops, assets: ASSETS, settings: { ...DEFAULT_SETTINGS, ...settings, fifoAutoStart: true }, rateAt: () => D(1), today: '2026-11-03' };
    expect(fifoHistory(input)).toMatchObject({ from: '2025-04-07', cryptoFrom: '2025-04-07', complete: true });
    expect(fifoHistory({ ...input, settings: { ...input.settings, fifoAutoStart: false } })).toMatchObject({ from: '2023-09-11', cryptoFrom: null, complete: false });
  });
});

describe('Saldo cero confirmado de todas las criptomonedas', () => {
  it('reinicia cualquier cripto con historial anterior, incluidos restos de exchanges antiguos, y no toca las acciones', () => {
    const maid = { ...crypto, assetId: 'MAID', assetName: 'MaidSafeCoin' };
    const ops: Operation[] = [
      trade('buy', '2016-04-22', '4000', '0.5', maid), btc('buy', '2021-01-01', '1', '100'), trade('buy', '2021-01-01', '10', '10'),
      btc('sell', '2025-01-15', '0.5', '200'), btc('buy', '2025-04-07', '0.5', '300'),
    ];
    const res = run(ops, { ...settings, fifoAutoStart: true, fifoConfirmedClosures: { 'CRYPTO:*': { month: '2025-01', note: 'Vendí todas mis criptomonedas.' } } }, () => '1', '2026-11-03');
    expect(res.inventoryResets?.map((r) => [r.assetId, r.quantityBefore]).sort()).toEqual([['BTC', '0.5'], ['MAID', '4000']]);
    expect(res.positions.filter((p) => Number(p.quantity) > 0).map((p) => [p.assetId, p.quantity])).toEqual([['US0378331005', '10'], ['BTC', '0.5']]);
    expect(res.fifoAuto).toMatchObject({ verified: true, starts: { BTC: '2025-04-07', MAID: '2026-01-01' } });
  });
});

describe('Restos mínimos y CoinTracking', () => {
  it('un resto mínimo tras el último movimiento se cierra sin efecto fiscal; uno real se conserva', () => {
    const dust = run([trade('buy', '2025-06-02', '1', '10'), trade('sell', '2025-06-13', '0.99999999', '12')], settings, () => '1', '2026-11-03');
    expect(dust.positions.filter((p) => Number(p.quantity) > 0)).toEqual([]);
    expect(dust.inventoryResets).toMatchObject([{ assetId: 'US0378331005', date: '2025-06-13', quantityBefore: '0.00000001', note: 'Resto mínimo tras su último movimiento' }]);
    expect(dust.disposals.map((d) => d.gainEur)).toEqual(['2']);
    const real = run([trade('buy', '2025-06-02', '1', '10'), trade('sell', '2025-06-13', '0.5', '12')], settings, () => '1', '2026-11-03');
    expect(real.positions[0]).toMatchObject({ quantity: '0.5' });
    expect(real.inventoryResets).toEqual([]);
  });
  it('lo que trae CoinTracking es una cartera externa: un depósito en Kraken vuelve de ella antes de contarse como llegado de fuera', () => {
    const xlm = { assetClass: 'crypto' as const, assetId: 'XLM', assetName: 'Stellar' };
    const ops: Operation[] = [
      trade('buy', '2021-05-03', '0.05', '0.4', { ...xlm, broker: 'cointracking' }),
      { ...trade('buy', '2022-02-01', '29.8311', '0', { ...xlm, broker: 'kraken' }), kind: 'transfer_in' },
      trade('sell', '2022-02-02', '29.8311', '0.18', { ...xlm, broker: 'kraken' }),
    ];
    const res = run(ops, settings, () => '1', '2026-11-03');
    expect(res.disposals[0]).toMatchObject({ shortfall: '29.7811' });
    expect(res.unmatchedTransfers).toEqual([]);
    expect(res.issues.find((i) => i.code === 'missing_lots')).toMatchObject({ settled: true });
  });
});

describe('Ventas sin compra previa con el criterio antiguo de CoinTracking', () => {
  const coin = (assetId: string) => ({ assetClass: 'crypto' as const, broker: 'cointracking' as const, assetId, assetName: assetId });
  it('toman el coste de las compras siguientes hasta la fecha indicada, también si la compra es del año siguiente', () => {
    const ops: Operation[] = [
      trade('sell', '2017-02-28', '2', '60', coin('DASH')), trade('buy', '2017-03-02', '3', '50', coin('DASH')),
      trade('sell', '2017-12-21', '1', '2', coin('XRP')), trade('buy', '2018-01-16', '0.4', '1', coin('XRP')), trade('buy', '2018-02-01', '1', '1.5', coin('XRP')),
      trade('sell', '2020-11-23', '1', '400', coin('ETH')), trade('buy', '2020-11-26', '1', '450', coin('ETH')),
    ];
    const res = run(ops, { lastFiledYear: 2025, shortfallCover: { from: '2017-01-01', to: '2017-12-31' } }, () => '1', '2026-11-03');
    const sale = (id: string) => res.disposals.find((d) => d.assetId === id)!;
    expect(sale('DASH')).toMatchObject({ year: 2017, costEur: '100', gainEur: '20', shortfall: '0' });
    expect(sale('XRP')).toMatchObject({ year: 2017, costEur: '1.3', gainEur: '0.7', shortfall: '0' });
    expect(sale('XRP').matches.map((m) => [m.acqDate.slice(0, 10), m.quantity])).toEqual([['2018-01-16', '0.4'], ['2018-02-01', '0.6']]);
    // Después de la fecha se mantiene el coste 0 con aviso, como en los informes recientes.
    expect(sale('ETH')).toMatchObject({ costEur: '0', shortfall: '1' });
    expect(res.issues.filter((i) => i.code === 'missing_lots').map((i) => i.assetId)).toEqual(['ETH']);
    expect(res.positions.filter((p) => Number(p.quantity) > 0).map((p) => [p.assetId, p.quantity]).sort()).toEqual([['DASH', '1'], ['ETH', '1'], ['XRP', '0.4']]);
  });
  it('sin compra posterior la venta conserva el coste 0 y el aviso', () => {
    const res = run([trade('sell', '2017-02-28', '2', '60', coin('DASH'))], { shortfallCover: { from: '2017-01-01', to: '2017-12-31' } }, () => '1', '2026-11-03');
    expect(res.disposals[0]).toMatchObject({ costEur: '0', shortfall: '2' });
    expect(res.issues.filter((i) => i.code === 'missing_lots')).toHaveLength(1);
  });
});

describe('Redondeos de exchange', () => {
  it('vender una fracción ínfima de más no se marca como compra que falta', () => {
    const eth = { assetClass: 'crypto' as const, broker: 'kraken' as const, assetId: 'ETH', assetName: 'Ethereum' };
    const res = run([trade('buy', '2025-04-07', '1', '1000', eth), trade('sell', '2025-05-09', '1.0000000006', '1200', eth)], settings, () => '1', '2026-11-03');
    expect(res.disposals[0]).toMatchObject({ shortfall: '0', costEur: '1000' });
    expect(res.issues.filter((i) => i.code === 'missing_lots')).toEqual([]);
    const real = run([trade('buy', '2025-04-07', '1', '1000', eth), trade('sell', '2025-05-09', '1.00001', '1200', eth)], settings, () => '1', '2026-11-03');
    expect(real.issues.filter((i) => i.code === 'missing_lots')).toHaveLength(1);
  });
});
