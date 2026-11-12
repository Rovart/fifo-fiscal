import { D, Decimal, ZERO, cents, toStr } from '../../shared/decimal.ts';
import { expectedTotal } from '../../shared/reconcile.ts';
import type { Operation } from '../../shared/types.ts';
import { utcToMadrid } from '../engine/dates.ts';
import { addCount, baseOp, isFiat, review, valueInEur, type RateFn } from './common.ts';
import { cryptoName } from './kraken.ts';

/** Movimientos del wallet, con lo imprescindible de cada fila de Blockscout. Fechas en segundos Unix e importes en la unidad mínima. */
export interface TokenTransfer {
  hash: string; timeStamp: string; from: string; to: string; value: string; contractAddress: string;
  tokenSymbol?: string | null; tokenName?: string | null; tokenDecimal?: string | null; tokenID?: string | null;
}
export interface NormalTx { hash: string; timeStamp: string; from: string; to: string; value: string; fee: string; isError?: string }
export interface InternalTx { transactionHash: string; timeStamp: string; from: string; to: string; value: string; isError?: string }
export interface ChainData { transfers: TokenTransfer[]; txs: NormalTx[]; internals: InternalTx[] }
export interface DetectedSwap { op: Operation; gasEth: Decimal }

export const isAddress = (s: string): boolean => /^0x[0-9a-fA-F]{40}$/.test(s);
export const shortAddress = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

// WETH es ETH envuelto 1:1: envolver o desenvolver no es una permuta.
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
/** Stablecoins en dólares con contrato conocido: dan el valor de la permuta sin depender de un símbolo que cualquiera puede copiar. */
const DOLLAR: Record<string, string> = {
  USDC: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  USDT: '0xdac17f958d2ee523a2206206994597c13d831ec7',
  DAI: '0x6b175474e89094c44da98b954eedeac495271d0f',
};
const WEI = D(10).pow(18);

interface Token { id: string; name: string; dollar: boolean; copy: boolean }
const ETH: Token = { id: 'ETH', name: cryptoName('ETH'), dollar: false, copy: false };

/** El FIFO va por símbolo, como en los exchanges. Un token que copia el de otro lleva su contrato para no mezclarse. */
export function tokenOf(t: Pick<TokenTransfer, 'contractAddress' | 'tokenSymbol' | 'tokenName' | 'tokenDecimal' | 'tokenID'>): Token | null {
  const contract = t.contractAddress.toLowerCase();
  if (contract === WETH) return ETH;
  if (t.tokenID || !/^\d{1,2}$/.test(t.tokenDecimal ?? '')) return null;
  const symbol = (t.tokenSymbol ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const official = DOLLAR[symbol];
  const copy = !symbol || ['ETH', 'WETH', 'BTC'].includes(symbol) || isFiat(symbol) || (!!official && official !== contract);
  const id = copy ? `${symbol || 'TOKEN'}-${contract.slice(2, 8).toUpperCase()}` : symbol;
  const known = cryptoName(id);
  return { id, name: known !== id ? known : (t.tokenName ?? '').trim().slice(0, 40) || id, dollar: official === contract, copy: copy && !!symbol };
}

/**
 * Permutas del wallet: transacciones en las que sale un único activo y entra otro distinto, sea cual sea
 * el DEX (Uniswap, agregadores, Curve o staking líquido como ETH → stETH). Envíos, recepciones y el gas
 * suelto no se importan: el wallet solo aporta lo que tiene efecto fiscal.
 */
export function detectSwaps(address: string, data: ChainData, rate: RateFn): { swaps: DetectedSwap[]; ignored: Record<string, number> } {
  const me = address.toLowerCase(), tag = me.slice(2, 10), label = shortAddress(address);
  interface Leg { token: Token; net: Decimal }
  interface Tx { hash: string; time: number; legs: Map<string, Leg>; gas: Decimal; failed: boolean; nft: boolean }
  const byHash = new Map<string, Tx>();
  const tx = (hash: string, time: string): Tx => {
    let t = byHash.get(hash);
    if (!t) { t = { hash, time: Number(time), legs: new Map(), gas: ZERO, failed: false, nft: false }; byHash.set(hash, t); }
    return t;
  };
  const flow = (t: Tx, token: Token, from: string, to: string, amount: Decimal) => {
    if (amount.lte(0) || from === to) return;
    const leg = t.legs.get(token.id) ?? { token, net: ZERO };
    if (from === me) leg.net = leg.net.minus(amount);
    if (to === me) leg.net = leg.net.plus(amount);
    t.legs.set(token.id, leg);
  };

  for (const r of data.txs) {
    const t = tx(r.hash, r.timeStamp);
    // Una transacción fallida no mueve nada, pero su gas se paga igual.
    if (r.from.toLowerCase() === me) t.gas = D(r.fee).div(WEI);
    if (r.isError === '1') { t.failed = true; continue; }
    flow(t, ETH, r.from.toLowerCase(), (r.to ?? '').toLowerCase(), D(r.value).div(WEI));
  }
  for (const r of data.internals) {
    if (r.isError === '1') continue;
    flow(tx(r.transactionHash, r.timeStamp), ETH, r.from.toLowerCase(), (r.to ?? '').toLowerCase(), D(r.value).div(WEI));
  }
  for (const r of data.transfers) {
    const from = r.from.toLowerCase(), to = (r.to ?? '').toLowerCase();
    if (from !== me && to !== me) continue;
    const t = tx(r.hash, r.timeStamp);
    const token = tokenOf(r);
    if (!token) { t.nft = true; continue; }
    flow(t, token, from, to, D(r.value).div(D(10).pow(Number(r.tokenDecimal))));
  }

  const all = [...byHash.values()].sort((a, b) => a.time - b.time || a.hash.localeCompare(b.hash));
  const moved = (t: Tx) => t.failed ? [] : [...t.legs.values()].filter((l) => !l.net.isZero());
  const isSwap = (t: Tx) => { const legs = moved(t); return !t.nft && legs.length === 2 && legs.filter((l) => l.net.lt(0)).length === 1; };

  const swaps: DetectedSwap[] = [];
  const ignored: Record<string, number> = {};
  for (const t of all) {
    const legs = moved(t);
    if (!isSwap(t)) {
      if (t.nft && legs.length) addCount(ignored, 'con NFT');
      else if (legs.some((l) => l.net.lt(0)) && legs.some((l) => l.net.gt(0))) addCount(ignored, 'con varias monedas');
      continue;
    }
    const given = legs.find((l) => l.net.lt(0))!, received = legs.find((l) => l.net.gt(0))!;
    const op = baseOp({
      broker: 'ethereum', kind: 'swap', datetime: utcToMadrid(new Date(t.time * 1000).toISOString()), assetId: given.token.id, assetName: given.token.name,
      assetClass: 'crypto', sourceKey: `eth:${t.hash}:${tag}`, note: `Permuta en el wallet ${label}`,
    });
    op.orderRef = t.hash;
    op.quantity = toStr(given.net.abs());
    op.counterAsset = received.token.id;
    op.counterName = received.token.name;
    op.counterQuantity = toStr(received.net);
    const dollars = given.token.dollar ? given : received.token.dollar ? received : null;
    if (dollars && valueInEur(op, given.net.abs(), dollars.net.abs(), 'USD', rate)) op.note = `${op.note} · Valorada a 1 USD por ${dollars.token.id}`;
    for (const leg of [given, received]) {
      if (leg.token.copy) review(op, `«${leg.token.name}» usa el símbolo de otro token: puede ser una imitación. Desmarca la permuta si no la hiciste tú.`);
    }
    swaps.push({ op, gasEth: t.gas });
  }
  return { swaps, ignored };
}

/** El gas es un gasto inherente a la permuta: reduce su valor de transmisión, al precio del ETH de ese día. */
export function applyGas(swaps: DetectedSwap[], ethEur: (date: string) => Decimal | null) {
  for (const { op, gasEth } of swaps) {
    const price = gasEth.gt(0) ? ethEur(op.datetime.slice(0, 10)) : null;
    if (!price) continue;
    op.feeEur = cents(gasEth.times(price));
    if (op.grossEur) op.totalEur = cents(expectedTotal(op));
    op.note = `${op.note} · Gas: ${toStr(gasEth, 8)} ETH`;
  }
}
