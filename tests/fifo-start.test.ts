import { describe, expect, it } from 'vitest';
import { fifoOperations } from '../shared/fifo-start.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { run, trade } from './helpers.ts';

const crypto = { assetClass: 'crypto' as const, broker: 'kraken' as const };
const btc = (kind: 'buy' | 'sell', date: string, qty: string, price: string) => trade(kind, date, qty, price, { ...crypto, assetId: 'BTC', assetName: 'Bitcoin' });
const swap = (): Operation => ({ ...trade('sell', '2024-02-01', '100', '1', { ...crypto, assetId: 'USDC', assetName: 'USD Coin' }), kind: 'swap', counterAsset: 'BTC', counterName: 'Bitcoin', counterQuantity: '0.01' });

describe('Inicio avanzado del FIFO', () => {
  it('recorta errores antiguos de USDC conservando las compras de otro activo y permite volver atrás', () => {
    const ops = [btc('buy', '2020-01-01', '1', '100'), trade('sell', '2021-01-01', '10', '1', { ...crypto, assetId: 'USDC' })];
    const original = JSON.stringify(ops);
    expect(run(ops).issues.some((i) => i.code === 'missing_lots')).toBe(true);
    const cut = run(ops, { fifoStartDates: { USDC: '2026-01-01' } });
    expect(cut.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(cut.positions.find((p) => p.assetId === 'BTC')).toMatchObject({ quantity: '1', costEur: '100' });
    expect(JSON.stringify(ops)).toBe(original);
    expect(run(ops, { fifoStartDates: {} }).issues.some((i) => i.code === 'missing_lots')).toBe(true);
  });
  it('no inventa costes iniciales si el usuario recorta una compra que aún necesita', () => {
    const result = run([btc('buy', '2020-01-01', '1', '100'), btc('sell', '2026-01-01', '1', '200')], { fifoStartDates: { BTC: '2026-01-01' } });
    expect(result.issues.some((i) => i.code === 'missing_lots')).toBe(true);
  });
  it('mantiene el BTC comprado con USDC aunque se recorte la parte antigua de USDC', () => {
    const exchange = swap(), ops = [exchange, btc('sell', '2026-01-01', '0.01', '15000')];
    const result = run(ops, { fifoStartDates: { USDC: '2025-01-01' } });
    expect(result.disposals).toHaveLength(1);
    expect(result.disposals[0]).toMatchObject({ assetId: 'BTC', costEur: '100', shortfall: '0' });
    expect(fifoOperations(ops, { ...DEFAULT_SETTINGS, fifoStartDates: { USDC: '2025-01-01' } })[0]).toMatchObject({ kind: 'buy', assetId: 'BTC', fifoLeg: 'swap_in' });
    expect(exchange.kind).toBe('swap');
  });
  it('conserva la transmisión y su clave de permuta cuando solo se recorta lo recibido', () => {
    const exchange: Operation = { ...btc('sell', '2024-02-01', '0.01', '10000'), kind: 'swap', counterAsset: 'USDC', counterQuantity: '100' };
    const result = run([btc('buy', '2020-01-01', '0.01', '5000'), exchange], { fifoStartDates: { USDC: '2025-01-01' } });
    expect(result.disposals[0]).toMatchObject({ clave: 'N', costEur: '50', proceedsEur: '100' });
    expect(result.positions.some((p) => p.assetId === 'USDC')).toBe(false);
  });
  it('incluye la propia fecha y aplica el inicio general también a las dos partes de una permuta', () => {
    const ops = [swap(), btc('buy', '2025-01-01', '1', '100')];
    const settings = { ...DEFAULT_SETTINGS, fifoStartDates: { '*': '2025-01-01', BTC: '2020-01-01' } };
    expect(fifoOperations(ops, settings).map((o) => o.id)).toEqual([ops[1]!.id]);
  });
  it('los dos ISIN de un canje comparten el recorte para no separar el origen del coste', () => {
    const action: Operation = { ...trade('buy', '2024-01-01', '10', '0'), kind: 'isin_change', counterAsset: 'NEW', counterQuantity: '5' };
    const ops = [trade('buy', '2020-01-01', '10', '10'), action, trade('buy', '2026-01-01', '1', '100', { assetId: 'NEW' })];
    expect(fifoOperations(ops, { ...DEFAULT_SETTINGS, fifoStartDates: { NEW: '2025-01-01' } }).map((o) => o.id)).toEqual([ops[2]!.id]);
  });
  it('un cierre cripto confirmado reinicia BTC y USDC desde la recompra aunque constase saldo externo antiguo', () => {
    const ops: Operation[] = [btc('buy', '2020-01-01', '1', '100'), { ...btc('buy', '2021-01-01', '1', '0'), kind: 'transfer_out' }, trade('sell', '2022-01-01', '10', '1', { ...crypto, assetId: 'USDC' }), trade('buy', '2024-01-01', '2', '50'), btc('buy', '2025-04-07', '0.5', '200')];
    const result = run(ops, { fifoStartDates: { 'CRYPTO:*': '2025-04-07' } });
    expect(result.openLots.find((l) => l.assetId === 'BTC')).toMatchObject({ acqDate: '2025-04-07T10:00:00', quantity: '0.5', costEur: '100' });
    expect(result.positions.find((p) => p.assetId === 'BTC')?.byBroker.externo).toBeUndefined();
    expect(result.positions.find((p) => p.assetId === 'US0378331005')).toMatchObject({ quantity: '2', costEur: '100' });
    expect(result.issues.some((i) => i.assetId === 'USDC')).toBe(false);
  });
});
