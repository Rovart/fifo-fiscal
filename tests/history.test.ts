import { describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { fifoHistory } from '../server/engine/history.ts';
import { ASSETS, trade } from './helpers.ts';

const history = (ops: Operation[], today = '2026-11-03') => fifoHistory({ ops, assets: ASSETS, settings: DEFAULT_SETTINGS, rateAt: () => D(1), today });

describe('Historial necesario para continuar el FIFO', () => {
  it('excluye vueltas antiguas cerradas y empieza en la nueva compra', () => {
    const h = history([trade('buy', '2020-01-01', '10', '10'), trade('sell', '2021-01-01', '10', '20'), trade('buy', '2026-01-01', '5', '30')]);
    expect(h).toMatchObject({ from: '2026-01-01', complete: true });
  });
  it('incluye compras ya vendidas que se consumen después de la compra aún abierta', () => {
    const h = history([trade('buy', '2020-01-01', '10', '10'), trade('buy', '2026-01-01', '10', '20'), trade('sell', '2026-02-01', '15', '30')]);
    expect(h.from).toBe('2020-01-01');
  });
  it('conserva el origen al cambiar de bróker o enviar cripto a una cartera externa', () => {
    const crypto = { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' as const, broker: 'kraken' as const };
    const h = history([trade('buy', '2020-01-01', '1', '100', crypto), { ...trade('buy', '2026-01-01', '1', '0', crypto), kind: 'transfer_out' }]);
    expect(h).toMatchObject({ from: '2020-01-01', complete: true });
    const crossBroker = history([trade('buy', '2020-01-01', '10', '10'), trade('buy', '2026-01-01', '10', '20', { broker: 'revolut' }), trade('sell', '2026-02-01', '10', '30', { broker: 'revolut' })]);
    expect(crossBroker.from).toBe('2020-01-01');
  });
  it('conserva las compras del ISIN antiguo tras un canje', () => {
    const h = history([trade('buy', '2020-01-01', '10', '10'), { ...trade('buy', '2026-01-01', '10', '0'), kind: 'isin_change', counterAsset: 'NEW', counterQuantity: '5' }]);
    expect(h.from).toBe('2020-01-01');
    expect(h.assets.find((a) => a.assetId === 'NEW')?.from).toBe('2020-01-01');
  });
  it('retiene el coste de una pérdida aplazada aunque la posición llegase a cero', () => {
    const h = history([trade('buy', '2020-01-01', '10', '10'), trade('sell', '2026-09-01', '10', '5'), trade('buy', '2026-10-01', '10', '6')]);
    expect(h.from).toBe('2020-01-01');
    expect(h.assets[0]?.deferred).toBe(true);
  });
  it('no dice cerrado si sigue abierta una ventana de recompra', () => {
    const ops = [trade('buy', '2020-01-01', '10', '10'), trade('sell', '2026-10-01', '10', '5')];
    expect(history(ops).from).toBe('2020-01-01');
    expect(history(ops, '2027-01-03')).toMatchObject({ from: null, closedAssets: 1 });
  });
  it('mantiene una deuda en divisa aunque todavía no haya lote', () => {
    const op: Operation = { ...trade('buy', '2020-01-01', '10', '10'), kind: 'fee', currency: 'USD', settleCurrency: 'USD' };
    expect(history([op]).from).toBe('2020-01-01');
  });
  it('no promete un recorte seguro si faltan compras o datos de coste', () => {
    const h = history([trade('sell', '2020-01-01', '10', '10'), trade('buy', '2026-01-01', '5', '30')]);
    expect(h).toMatchObject({ from: '2020-01-01', complete: false });
    expect(history([{ ...trade('buy', '2020-01-01', '1', '0'), kind: 'transfer_in' }])).toMatchObject({ from: '2020-01-01', complete: false });
  });
});
