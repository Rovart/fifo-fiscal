import { D, Decimal, ZERO, cents, toStr } from '../../shared/decimal.ts';
import type { Operation } from '../../shared/types.ts';
import { utcToMadrid } from '../engine/dates.ts';
import { KeyCounter, addCount, baseOp, finishCash, finishTrade, isFiat, num, review } from './common.ts';
import type { DeclaredBalance, ParsedImport, RateFn } from './common.ts';
import { findCol } from './csv.ts';

export const looksLikeKrakenLedger = (h: string[]): boolean =>
  findCol(h, ['refid']) >= 0 && findCol(h, ['asset']) >= 0 && findCol(h, ['amount']) >= 0 && findCol(h, ['balance']) >= 0;
export const looksLikeKrakenTrades = (h: string[]): boolean =>
  findCol(h, ['pair']) >= 0 && findCol(h, ['ordertxid']) >= 0;

const ALIASES: Record<string, string> = {
  XXBT: 'BTC', XBT: 'BTC', XETH: 'ETH', ETH2: 'ETH', XXRP: 'XRP', XLTC: 'LTC', XXLM: 'XLM', XXMR: 'XMR', XZEC: 'ZEC', XETC: 'ETC', XREP: 'REP', XMLN: 'MLN',
  XXDG: 'DOGE', XDG: 'DOGE', ZEUR: 'EUR', ZUSD: 'USD', ZGBP: 'GBP', ZJPY: 'JPY', ZCAD: 'CAD', ZAUD: 'AUD', ZCHF: 'CHF',
};
const NAMES: Record<string, string> = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'XRP', ADA: 'Cardano', DOT: 'Polkadot', LTC: 'Litecoin', DOGE: 'Dogecoin', USDT: 'Tether', USDC: 'USD Coin',
  LINK: 'Chainlink', ATOM: 'Cosmos', MATIC: 'Polygon', POL: 'Polygon', AVAX: 'Avalanche', XLM: 'Stellar', XMR: 'Monero', TRX: 'Tron', UNI: 'Uniswap', KSM: 'Kusama',
};

/** XXBT → BTC, ETH2.S → ETH, DOT.28S → DOT, USDC.F → USDC */
export function krakenAsset(raw: string): string {
  const base = raw.trim().toUpperCase().split('.')[0] as string;
  return ALIASES[base] ?? base;
}
export const cryptoName = (s: string): string => NAMES[s] ?? s;

export function parseKrakenLedger(headers: string[], rows: string[][], rate: RateFn): ParsedImport {
  const col = (n: string) => findCol(headers, [n]);
  const i = {
    txid: col('txid'), refid: col('refid'), time: col('time'), type: col('type'), subtype: col('subtype'), asset: col('asset'),
    wallet: col('wallet'), amount: col('amount'), fee: col('fee'), balance: col('balance'), usd: col('amountusd'), feeUsd: col('feeusd'),
  };
  if (i.refid < 0 || i.time < 0 || i.type < 0 || i.asset < 0 || i.amount < 0) throw new Error('Kraken: faltan columnas del ledger.');

  interface Row { txid: string; refid: string; dt: string; rawTime: string; type: string; subtype: string; rawAsset: string; asset: string; wallet: string; amount: Decimal; fee: Decimal; balance: Decimal | null; usd: Decimal | null; feeUsd: Decimal | null }
  const parsed: Row[] = [];
  const ignored: Record<string, number> = {};
  const warnings: string[] = [];
  for (const r of rows) {
    const f = (x: number) => (x >= 0 ? (r[x] ?? '').trim() : '');
    if (!f(i.txid)) { addCount(ignored, 'Filas pendientes sin txid'); continue; }
    const rawTime = f(i.time);
    parsed.push({
      txid: f(i.txid), refid: f(i.refid), rawTime, dt: utcToMadrid(`${rawTime.replace(' ', 'T')}Z`), type: f(i.type).toLowerCase(), subtype: f(i.subtype).toLowerCase(),
      rawAsset: f(i.asset), asset: krakenAsset(f(i.asset)), wallet: f(i.wallet), amount: num(f(i.amount)) ?? ZERO, fee: num(f(i.fee)) ?? ZERO, balance: num(f(i.balance)), usd: num(f(i.usd)), feeUsd: num(f(i.feeUsd)),
    });
  }

  const groups = new Map<string, Row[]>();
  for (const r of parsed) {
    const g = groups.get(r.refid) ?? [];
    g.push(r);
    groups.set(r.refid, g);
  }

  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const add = (op: Operation) => ops.push(op);
  // Kraken da el valor en dólares de cada línea: basta pasarlo a euros al cambio del BCE.
  const usdToEur = (usd: Decimal | null, date: string): Decimal | null => {
    if (!usd) return null;
    const r = rate('USD', date);
    return r ? usd.abs().div(r) : null;
  };
  const setValue = (op: Operation, qty: Decimal, value: Decimal | null) => {
    op.quantity = toStr(qty);
    if (!value) return false;
    op.currency = 'EUR';
    op.fxRate = '1';
    op.grossLocal = cents(value);
    op.grossEur = op.grossLocal;
    op.totalEur = op.grossLocal;
    if (qty.gt(0)) op.unitPrice = toStr(value.div(qty), 10);
    return true;
  };
  const marginFees = new Map<string, { asset: string; qty: Decimal; usd: Decimal; dt: string; n: number }>();
  const marginEur = new Map<string, { amount: Decimal; fee: Decimal; n: number }>();

  for (const [refid, group] of groups) {
    const t = group[0] as Row;
    const types = new Set(group.map((g) => g.type));
    // «settled» liquida una posición con margen entregando el activo: es una compra o venta más.
    const isExchange = [...types].every((x) => x === 'trade' || x === 'spend' || x === 'receive' || x === 'settled');

    if (isExchange && group.length >= 2) {
      const legs = new Map<string, Leg>();
      for (const g of group) {
        const l = legs.get(g.asset) ?? { asset: g.asset, amount: ZERO, fee: ZERO, usd: ZERO };
        l.amount = l.amount.plus(g.amount);
        l.fee = l.fee.plus(g.fee);
        l.usd = (l.usd ?? ZERO).plus(g.usd?.abs() ?? ZERO);
        legs.set(g.asset, l);
      }
      const all = [...legs.values()];
      const out = all.filter((l) => l.amount.lt(0));
      const inn = all.filter((l) => l.amount.gt(0));
      if (out.length !== 1 || inn.length !== 1) {
        warnings.push(`Operación ${refid} con ${all.length} activos: revísala a mano.`);
        addCount(ignored, 'Operaciones no emparejadas');
        continue;
      }
      add(buildExchange(out[0]!, inn[0]!, t.dt, keys.key('kr-tr', refid), rate));
      continue;
    }

    if (isExchange) {
      warnings.push(`Operación ${refid} (${t.type} ${toStr(t.amount)} ${t.asset}) sin contrapartida en el fichero. Exporta el ledger completo.`);
      addCount(ignored, 'Operaciones no emparejadas');
      continue;
    }

    for (const g of group) {
      const key = keys.key('kr-led', g.txid);
      if (g.type === 'deposit' || g.type === 'withdrawal') {
        if (g.wallet && /earn|staking/i.test(g.wallet)) { addCount(ignored, 'Movimientos internos de staking'); continue; }
        if (g.rawAsset.includes('.')) { addCount(ignored, 'Movimientos internos de staking'); continue; }
        const qty = g.amount.abs();
        if (isFiat(g.asset)) {
          if (g.asset === 'EUR' && g.fee.isZero()) { addCount(ignored, 'Ingresos y retiradas en euros'); continue; }
          const op = baseOp({ broker: 'kraken', kind: g.type, datetime: g.dt, assetId: g.asset, assetName: g.asset, assetClass: 'other', currency: g.asset, sourceKey: key });
          finishCash(op, qty, rate);
          add(op);
          if (!g.fee.isZero()) add(feeOp(g, keys.key('kr-fee', g.txid), rate));
        } else {
          const kind = g.type === 'deposit' ? 'transfer_in' : 'transfer_out';
          const op = baseOp({ broker: 'kraken', kind, datetime: g.dt, assetId: g.asset, assetName: cryptoName(g.asset), assetClass: 'crypto', sourceKey: key });
          op.quantity = toStr(qty);
          add(op);
          if (!g.fee.isZero()) {
            // La comisión de red en cripto transmite esas unidades a valor de mercado.
            const fee = baseOp({ broker: 'kraken', kind: 'sell', datetime: g.dt, assetId: g.asset, assetName: cryptoName(g.asset), assetClass: 'crypto', sourceKey: keys.key('kr-netfee', g.txid), note: 'Comisión de retirada pagada en cripto' });
            fee.feeEur = '0';
            if (!setValue(fee, g.fee, usdToEur(g.feeUsd, g.dt.slice(0, 10)))) review(fee, 'Comisión de retirada pagada en cripto: cuenta como una pequeña venta.');
            add(fee);
          }
        }
        continue;
      }
      if (g.type === 'staking' || g.type === 'earn' || g.type === 'dividend') {
        if (['allocation', 'deallocation', 'autoallocate', 'autoallocation', 'migration', 'spottostaking', 'stakingfromspot', 'stakingtospot', 'spotfromstaking'].includes(g.subtype)) {
          addCount(ignored, 'Movimientos internos de staking');
          continue;
        }
        if (g.amount.lte(0)) { addCount(ignored, 'Movimientos internos de staking'); continue; }
        const qty = g.amount.minus(g.fee);
        if (isFiat(g.asset)) {
          const op = baseOp({ broker: 'kraken', kind: 'interest', datetime: g.dt, assetId: `KRAKEN-${g.asset}`, assetName: `Rendimientos ${g.asset} Kraken`, assetClass: 'other', currency: g.asset, sourceKey: key });
          finishCash(op, qty, rate);
          add(op);
          continue;
        }
        const op = baseOp({ broker: 'kraken', kind: 'staking', datetime: g.dt, assetId: g.asset, assetName: cryptoName(g.asset), assetClass: 'crypto', sourceKey: key, note: `Kraken ${g.type}` });
        const netUsd = g.usd ? g.usd.abs().minus(g.feeUsd ?? ZERO) : null;
        setValue(op, qty, usdToEur(netUsd, g.dt.slice(0, 10)));
        add(op);
        continue;
      }
      if (g.type === 'transfer' || g.type === 'reward') {
        if (g.subtype && g.type === 'transfer') { addCount(ignored, 'Movimientos internos entre monederos'); continue; }
        if (g.amount.lte(0)) { addCount(ignored, 'Movimientos internos entre monederos'); continue; }
        if (g.usd && g.usd.abs().lt('0.01')) { addCount(ignored, 'Importes inferiores a un céntimo'); continue; }
        const op = baseOp({ broker: 'kraken', kind: 'reward', datetime: g.dt, assetId: g.asset, assetName: cryptoName(g.asset), assetClass: 'crypto', sourceKey: key, note: g.subtype === 'invitebonus' ? 'Bono por invitación de Kraken' : 'Kraken transfer' });
        setValue(op, g.amount, usdToEur(g.usd, g.dt.slice(0, 10)));
        if (g.type === 'transfer') review(op, 'Cripto recibida gratis en Kraken: la contamos como airdrop. Cámbiala si fue otra cosa.');
        add(op);
        continue;
      }
      if (g.type === 'margin' || g.type === 'rollover') {
        // Costes periódicos y resultados de posiciones con margen: se resumen en vez de avisar uno a uno.
        addCount(ignored, 'Costes y resultados de margen');
        if (isFiat(g.asset)) {
          const y = g.dt.slice(0, 4);
          const e = marginEur.get(y) ?? { amount: ZERO, fee: ZERO, n: 0 };
          e.amount = e.amount.plus(g.amount); e.fee = e.fee.plus(g.fee); e.n++;
          marginEur.set(y, e);
        } else if (!g.fee.isZero()) {
          const k = `${g.asset}|${g.dt.slice(0, 7)}`;
          const e = marginFees.get(k) ?? { asset: g.asset, qty: ZERO, usd: ZERO, dt: g.dt, n: 0 };
          e.qty = e.qty.plus(g.fee); e.usd = e.usd.plus(g.feeUsd ?? ZERO); e.dt = g.dt; e.n++;
          marginFees.set(k, e);
        }
        continue;
      }
      if (g.type === 'adjustment') {
        warnings.push(`Ajuste de Kraken del ${g.dt.slice(0, 10)} (${toStr(g.amount)} ${g.asset}): revísalo y añádelo a mano si varía tu saldo.`);
        addCount(ignored, 'Ajustes');
        continue;
      }
      warnings.push(`Tipo «${g.type}» de Kraken sin clasificar (${toStr(g.amount)} ${g.asset}, ${g.dt.slice(0, 10)}).`);
      addCount(ignored, 'Tipos no reconocidos');
    }
  }

  for (const [k, e] of marginFees) {
    const op = baseOp({ broker: 'kraken', kind: 'fee', datetime: e.dt, assetId: e.asset, assetName: cryptoName(e.asset), assetClass: 'crypto', sourceKey: `kr-margin:${k}`, note: `Costes de margen de Kraken (${e.n} ${e.n === 1 ? 'apunte' : 'apuntes'})` });
    op.feeClass = 'non_deductible';
    op.quantity = toStr(e.qty);
    const value = cents(usdToEur(e.usd, e.dt.slice(0, 10)) ?? ZERO);
    op.grossLocal = value;
    op.grossEur = value;
    op.totalEur = value;
    add(op);
  }
  for (const [y, e] of [...marginEur.entries()].sort()) {
    if (e.amount.isZero() && e.fee.lt('1')) continue;
    warnings.push(`Margen en Kraken en ${y}: resultado de ${cents(e.amount).replace('.', ',')} € y costes de ${cents(e.fee).replace('.', ',')} € (${e.n} ${e.n === 1 ? 'apunte' : 'apuntes'}). No se incluye en el cálculo; solo afecta a ese año.`);
  }

  // Saldo final que informa Kraken, por activo, para el cuadre de posiciones.
  const lastByWallet = new Map<string, Row>();
  for (const r of parsed) {
    const prev = lastByWallet.get(`${r.rawAsset}|${r.wallet}`);
    if (!prev || r.rawTime >= prev.rawTime) lastByWallet.set(`${r.rawAsset}|${r.wallet}`, r);
  }
  const totals = new Map<string, { qty: Decimal; asOf: string }>();
  for (const r of lastByWallet.values()) {
    if (r.balance === null) continue;
    const e = totals.get(r.asset) ?? { qty: ZERO, asOf: r.dt };
    e.qty = e.qty.plus(r.balance);
    if (r.dt > e.asOf) e.asOf = r.dt;
    totals.set(r.asset, e);
  }
  const balances: DeclaredBalance[] = [...totals.entries()]
    .filter(([a]) => a !== 'EUR')
    .map(([a, e]) => ({ broker: 'kraken' as const, assetId: isFiat(a) ? `FX:${a}` : a, quantity: toStr(e.qty), asOf: e.asOf }));

  return { broker: 'kraken', format: 'Ledgers', ops, pendingCosts: [], balances, markets: {}, warnings, ignored, rows: rows.length };
}

function feeOp(g: { dt: string; asset: string; fee: Decimal; txid: string }, key: string, rate: RateFn): Operation {
  const op = baseOp({ broker: 'kraken', kind: 'fee', datetime: g.dt, assetId: 'KRAKEN', assetName: 'Kraken', assetClass: 'other', currency: g.asset, sourceKey: key, note: 'Comisión de ingreso o retirada' });
  op.feeClass = 'non_deductible';
  return finishCash(op, g.fee, rate);
}

type Leg = { asset: string; amount: Decimal; fee: Decimal; usd?: Decimal | null };

function buildExchange(out: Leg, inn: Leg, dt: string, key: string, rate: RateFn): Operation {
  const fiatOut = isFiat(out.asset), fiatIn = isFiat(inn.asset);
  const date = dt.slice(0, 10);

  if (fiatOut && fiatIn) {
    const op = baseOp({ broker: 'kraken', kind: 'fx', datetime: dt, assetId: out.asset === 'EUR' ? inn.asset : out.asset, assetName: out.asset === 'EUR' ? inn.asset : out.asset, assetClass: 'other', currency: out.asset, sourceKey: key });
    const given = out.amount.abs().plus(out.fee);
    const recv = inn.amount.minus(inn.fee);
    op.quantity = toStr(given);
    op.counterAsset = inn.asset;
    op.counterName = inn.asset;
    op.counterQuantity = toStr(recv);
    const eur = out.asset === 'EUR' ? given : inn.asset === 'EUR' ? recv : (() => { const r = rate(out.asset, date); return r ? given.div(r) : null; })();
    if (!eur) return review(op, 'Sin contravalor en euros.');
    op.grossEur = cents(eur);
    op.totalEur = op.grossEur;
    op.fxRate = toStr((out.asset === 'EUR' ? recv : given).div(eur), 10);
    op.fxSource = 'broker';
    return op;
  }

  if (fiatOut && !fiatIn) {
    // Compra: el coste es lo pagado y la cantidad lo que entra neto. Una comisión en especie se valora al precio de la operación.
    const op = baseOp({ broker: 'kraken', kind: 'buy', datetime: dt, assetId: inn.asset, assetName: cryptoName(inn.asset), assetClass: 'crypto', currency: out.asset, sourceKey: key });
    const paid = out.amount.abs();
    const price = paid.div(inn.amount);
    const netQty = inn.amount.minus(inn.fee);
    const inKind = inn.fee.times(price);
    finishPriced(op, netQty, price, paid.minus(inKind), out.fee.plus(inKind), rate);
    if (out.asset !== 'EUR') op.settleCurrency = out.asset;
    return op;
  }

  if (!fiatOut && fiatIn) {
    const op = baseOp({ broker: 'kraken', kind: 'sell', datetime: dt, assetId: out.asset, assetName: cryptoName(out.asset), assetClass: 'crypto', currency: inn.asset, sourceKey: key });
    const got = inn.amount;
    const price = got.div(out.amount.abs());
    const netQty = out.amount.abs().plus(out.fee);
    const inKind = out.fee.times(price);
    finishPriced(op, netQty, price, got.plus(inKind), inn.fee.plus(inKind), rate);
    if (inn.asset !== 'EUR') op.settleCurrency = inn.asset;
    return op;
  }

  const op = baseOp({ broker: 'kraken', kind: 'swap', datetime: dt, assetId: out.asset, assetName: cryptoName(out.asset), assetClass: 'crypto', sourceKey: key });
  const given = out.amount.abs().plus(out.fee);
  op.quantity = toStr(given);
  op.counterAsset = inn.asset;
  op.counterName = cryptoName(inn.asset);
  op.counterQuantity = toStr(inn.amount.minus(inn.fee));
  // Sin euros de por medio, el valor de mercado sale del dato en dólares de la línea que se entrega.
  const r = rate('USD', date);
  if (out.usd && out.usd.gt(0) && r) {
    const value = out.usd.div(r);
    op.grossLocal = cents(value);
    op.grossEur = op.grossLocal;
    op.totalEur = op.grossLocal;
    op.unitPrice = toStr(value.div(given), 10);
    op.note = 'Valor de mercado según Kraken';
  }
  return op;
}

function finishPriced(op: Operation, qty: Decimal, price: Decimal, grossLocal: Decimal, feeLocal: Decimal, rate: RateFn) {
  const date = op.datetime.slice(0, 10);
  const r = op.currency === 'EUR' ? D(1) : rate(op.currency, date);
  if (!r) {
    op.quantity = toStr(qty);
    review(op, `Sin tipo de cambio ${op.currency}/EUR para ${date}.`);
    return;
  }
  finishTrade(op, {
    qty, price: price.toDecimalPlaces(10), grossLocal, grossEur: op.currency === 'EUR' ? null : grossLocal.div(r), fee: feeLocal.div(r), rate,
  });
  if (op.currency !== 'EUR') op.fxSource = 'ecb';
}
