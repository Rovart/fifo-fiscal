import { beforeAll, describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { reconcile } from '../shared/reconcile.ts';
import { applyGas, detectSwaps, type ChainData, type InternalTx, type NormalTx, type TokenTransfer } from '../server/importers/ethereum.ts';
import { run, trade } from './helpers.ts';

process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const wallet = await import('../server/wallet.ts');

const ME = '0x1111111111111111111111111111111111111111';
const ROUTER = '0x2222222222222222222222222222222222222222';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const STETH = '0xae7ab96520de3a18e5e111b5eaab095312d7fe84';
const eth = (n: string) => D(n).times('1e18').toFixed(0);
const at = (iso: string) => String(Date.parse(iso) / 1000);

const tx = (hash: string, time: string, p: Partial<NormalTx> = {}): NormalTx => ({ hash, timeStamp: at(time), from: ME, to: ROUTER, value: '0', fee: eth('0.002'), isError: '0', ...p });
const token = (hash: string, time: string, p: Partial<TokenTransfer>): TokenTransfer => ({ hash, timeStamp: at(time), from: ROUTER, to: ME, value: '0', contractAddress: USDC, tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimal: '6', ...p });
const internal = (hash: string, time: string, value: string): InternalTx => ({ transactionHash: hash, timeStamp: at(time), from: ROUTER, to: ME, value, isError: '0' });
const rate = (c: string) => (c === 'USD' ? D('1.25') : null);
const detect = (data: Partial<ChainData>) => detectSwaps(ME, { transfers: [], txs: [], internals: [], ...data }, rate);

describe('Permutas de un wallet de Ethereum', () => {
  it('detecta ETH → USDC, la valora a 1 USD y resta el gas y el ETH devuelto', () => {
    const { swaps } = detect({
      txs: [tx('0xa', '2024-03-05T10:00:00Z', { value: eth('1.1') })],
      internals: [internal('0xa', '2024-03-05T10:00:00Z', eth('0.1'))],
      transfers: [token('0xa', '2024-03-05T10:00:00Z', { value: '3000000000' })],
    });
    expect(swaps).toHaveLength(1);
    const { op, gasEth } = swaps[0]!;
    expect(op).toMatchObject({ broker: 'ethereum', kind: 'swap', assetId: 'ETH', quantity: '1', counterAsset: 'USDC', counterQuantity: '3000', grossEur: '2400.00', datetime: '2024-03-05T11:00:00', orderRef: '0xa' });
    expect(gasEth.toFixed()).toBe('0.002');
    applyGas(swaps, () => D(2500));
    expect(op).toMatchObject({ feeEur: '5.00', totalEur: '2395.00' });
    expect(reconcile(op).ok).toBe(true);
  });

  it('detecta el staking líquido ETH → stETH y lo deja para valorar con el precio del ETH', () => {
    const { swaps } = detect({
      txs: [tx('0xb', '2024-04-01T08:00:00Z', { to: STETH, value: eth('10') })],
      transfers: [token('0xb', '2024-04-01T08:00:00Z', { from: '0x0000000000000000000000000000000000000000', value: eth('9.999999999999999999'), contractAddress: STETH, tokenSymbol: 'stETH', tokenName: 'Liquid staked Ether 2.0', tokenDecimal: '18' })],
    });
    expect(swaps[0]!.op).toMatchObject({ assetId: 'ETH', quantity: '10', counterAsset: 'STETH', counterQuantity: '9.999999999999999999', grossEur: null });
  });

  it('detecta token → ETH aunque la transacción la envíe un tercero, sin gas', () => {
    const { swaps } = detect({
      transfers: [token('0xc', '2024-05-01T08:00:00Z', { from: ME, to: ROUTER, value: '500000000' })],
      internals: [internal('0xc', '2024-05-01T08:00:00Z', eth('0.2'))],
    });
    expect(swaps[0]!.op).toMatchObject({ assetId: 'USDC', quantity: '500', counterAsset: 'ETH', counterQuantity: '0.2', grossEur: '400.00' });
    expect(swaps[0]!.gasEth.isZero()).toBe(true);
  });

  it('WETH cuenta como ETH: envolver no es permuta y un cambio por WETH entrega ETH', () => {
    const weth = { contractAddress: WETH, tokenSymbol: 'WETH', tokenDecimal: '18' };
    const { swaps } = detect({
      txs: [tx('0xd', '2024-06-01T08:00:00Z', { to: WETH, value: eth('1') }), tx('0xe', '2024-06-02T08:00:00Z')],
      transfers: [
        token('0xd', '2024-06-01T08:00:00Z', { ...weth, value: eth('1') }),
        token('0xe', '2024-06-02T08:00:00Z', { ...weth, from: ME, to: ROUTER, value: eth('1') }),
        token('0xe', '2024-06-02T08:00:00Z', { value: '3100000000' }),
      ],
    });
    expect(swaps.map((s) => [s.op.assetId, s.op.counterAsset])).toEqual([['ETH', 'USDC']]);
  });

  it('no toma por permuta envíos, fallos, NFT ni operaciones con varias monedas', () => {
    const { swaps, ignored } = detect({
      txs: [
        tx('0xf', '2024-07-01T08:00:00Z', { value: eth('1') }),
        tx('0x10', '2024-07-02T08:00:00Z', { value: eth('1'), isError: '1' }),
        tx('0x11', '2024-07-03T08:00:00Z', { value: eth('1') }),
        tx('0x12', '2024-07-04T08:00:00Z', { value: eth('1') }),
      ],
      transfers: [
        token('0x10', '2024-07-02T08:00:00Z', { value: '1' }),
        token('0x11', '2024-07-03T08:00:00Z', { contractAddress: '0x3333333333333333333333333333333333333333', tokenSymbol: 'APE', tokenDecimal: '', tokenID: '42', value: '1' }),
        token('0x12', '2024-07-04T08:00:00Z', { from: ME, to: ROUTER, value: '1000000' }),
        token('0x12', '2024-07-04T08:00:00Z', { contractAddress: '0x4444444444444444444444444444444444444444', tokenSymbol: 'UNI-V2', tokenDecimal: '18', value: eth('1') }),
        // Envenenamiento de direcciones: un contrato falso simula una salida del wallet.
        token('0x13', '2024-07-05T08:00:00Z', { from: ME, to: ROUTER, contractAddress: '0x5555555555555555555555555555555555555555', tokenSymbol: 'ЕТН', tokenDecimal: '18', value: eth('1') }),
      ],
    });
    expect(swaps).toHaveLength(0);
    expect(ignored).toEqual({ 'con NFT': 1, 'con varias monedas': 1 });
  });

  it('un token que copia el símbolo de otro no se mezcla con el auténtico ni se valora a 1 USD', () => {
    const { swaps } = detect({
      txs: [tx('0x14', '2024-08-01T08:00:00Z', { value: eth('1') })],
      transfers: [token('0x14', '2024-08-01T08:00:00Z', { contractAddress: '0x6666666666666666666666666666666666666666', value: '3000000000' })],
    });
    expect(swaps[0]!.op).toMatchObject({ counterAsset: 'USDC-666666', grossEur: null });
    expect(swaps[0]!.op.reviewReasons?.[0]).toMatch(/imitación/);
  });
});

describe('Wallet en el FIFO', () => {
  it('la permuta sale de la cartera propia adonde llegó la retirada del exchange', () => {
    const base = { broker: 'kraken' as const, assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto' as const };
    const { swaps } = detect({ txs: [tx('0xa', '2024-03-05T10:00:00Z', { value: eth('1') })], transfers: [token('0xa', '2024-03-05T10:00:00Z', { value: '3000000000' })] });
    const res = run([
      trade('buy', '2024-01-10', '2', '1000', base),
      { ...trade('buy', '2024-02-01', '1', '0', base), kind: 'transfer_out' },
      swaps[0]!.op,
    ]);
    expect(res.disposals).toHaveLength(1);
    expect(res.disposals[0]).toMatchObject({ assetId: 'ETH', clave: 'N', proceedsEur: '2400', costEur: '1000', gainEur: '1400' });
    expect(res.positions.find((p) => p.assetId === 'ETH')?.byBroker).toEqual({ kraken: '1' });
    expect(res.positions.find((p) => p.assetId === 'USDC')).toMatchObject({ quantity: '3000', costEur: '2400', byBroker: { externo: '3000' } });
  });
});

describe('Wallet guardado', () => {
  beforeAll(() => db.seedRatesIfEmpty());
  const data: ChainData = {
    txs: [tx('0xa', '2024-03-05T10:00:00Z', { value: eth('1') }), tx('0xb', '2024-04-01T08:00:00Z', { to: STETH, value: eth('10') })],
    internals: [],
    transfers: [
      token('0xa', '2024-03-05T10:00:00Z', { value: '3000000000' }),
      token('0xb', '2024-04-01T08:00:00Z', { value: eth('10'), contractAddress: STETH, tokenSymbol: 'stETH', tokenName: 'Liquid staked Ether 2.0', tokenDecimal: '18' }),
    ],
  };

  it('añade las permutas una sola vez y las lista con su wallet', () => {
    expect(wallet.saveWallet(ME, data, () => D(2500))).toMatchObject({ added: 2, found: 2 });
    expect(wallet.saveWallet(ME.toUpperCase().replace('0X', '0x'), data)).toMatchObject({ added: 0, found: 2 });
    const list = wallet.listWallets();
    expect(list).toHaveLength(1);
    expect(list[0]!.swaps.map((s) => `${s.assetId}→${s.counterAsset}`)).toEqual(['ETH→STETH', 'ETH→USDC']);
    expect(svc.engine().disposals).toHaveLength(2);
  });

  it('una permuta desmarcada no cuenta, no reaparece al actualizar y se puede volver a marcar', () => {
    const staking = wallet.listWallets()[0]!.swaps[0]!;
    expect(wallet.includeSwaps([staking.id], false)).toBe(1);
    expect(svc.engine().disposals.map((d) => d.opId)).not.toContain(staking.id);
    expect(wallet.saveWallet(ME, data).added).toBe(0);
    expect(wallet.listWallets()[0]!.swaps.find((s) => s.id === staking.id)?.deleted).toBe(true);
    expect(wallet.includeSwaps([staking.id], true)).toBe(1);
    expect(svc.engine().disposals).toHaveLength(2);
  });

  it('quitar el wallet retira sus permutas y permite añadirlo de nuevo', () => {
    expect(svc.undoImport(wallet.listWallets()[0]!.id)).toBe(2);
    expect(wallet.listWallets()).toHaveLength(0);
    expect(db.allOps()).toHaveLength(0);
    expect(wallet.saveWallet(ME, data).added).toBe(2);
  });
});
