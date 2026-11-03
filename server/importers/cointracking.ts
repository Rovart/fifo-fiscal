import { D, Decimal, ZERO, toStr } from '../../shared/decimal.ts';
import type { Broker, OpKind, Operation } from '../../shared/types.ts';
import { KeyCounter, addCount, baseOp, finishTrade, flexibleDate, isFiat, num, review, valueInEur, type ParsedImport, type RateFn } from './common.ts';
import { findCol, norm } from './csv.ts';
import { cryptoName } from './kraken.ts';

/** Periodo que ya cubre la importación propia de cada exchange. */
export type Coverage = Partial<Record<Broker, { from: string; to: string }>>;

const CUR = ['cur.', 'cur', 'mon.', 'moneda'];
/** La columna de moneda sigue a la de cantidad: «Buy, Cur., Sell, Cur., Fee, Cur.». */
const columns = (h: string[]) => {
  const at = (names: string[]) => findCol(h, names);
  const pair = (names: string[]) => { const i = at(names); return i >= 0 && CUR.includes(norm(h[i + 1] ?? '')) ? i : -1; };
  return {
    type: at(['type', 'tipo']), buy: pair(['buy', 'compra']), sell: pair(['sell', 'venta']), fee: pair(['fee', 'comision']),
    exchange: at(['exchange']), comment: at(['comment', 'comentario']), date: at(['date', 'fecha']), txid: at(['tx-id', 'txid', 'trade id']),
  };
};

export const looksLikeCoinTracking = (h: string[]) => {
  const c = columns(h);
  return c.type >= 0 && c.buy >= 0 && c.sell >= 0 && c.exchange >= 0 && c.date >= 0;
};
export const looksLikeCoinTrackingReport = (h: string[]) =>
  ['cantidad', 'divisa', 'fecha de adquisicion', 'base de coste en eur'].every((n) => h.some((x) => norm(x) === n));

/** Exchanges con importador propio: su extracto trae depósitos, staking y comisiones que CoinTracking no siempre tiene. */
const NATIVE: { broker: Broker; match: RegExp }[] = [{ broker: 'kraken', match: /^kraken\b/i }, { broker: 'coinbase', match: /^coinbase$/i }];
const STABLE = new Set(['USDT', 'USDC', 'BUSD', 'TUSD', 'USDP', 'PAX', 'DAI', 'GUSD']);
const STAKING = new Set(['staking', 'interest income', 'lending income', 'masternode', 'minting', 'dividends income']);
// Regalos, airdrops y entradas sin contrapartida: el historial de CoinTracking los lleva con coste 0.
const FREE = new Set(['income', 'other income', 'airdrop', 'reward / bonus', 'gift / tip', 'gift/tip', 'mining', 'mining (commercial)']);
const SPENT = new Set(['spend', 'donation', 'gift']);
const GONE = new Set(['lost', 'stolen']);

// Siempre con 8 decimales y punto: «1.000» nunca es un millar.
const amount = (s: string) => (/^-?\d+(\.\d+)?$/.test(s) ? D(s) : num(s))?.abs() ?? ZERO;

export function parseCoinTracking(headers: string[], rows: string[][], rate: RateFn, coverage: Coverage = {}): ParsedImport {
  const i = columns(headers);
  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const unsupported: Record<string, number> = {};

  for (const r of rows) {
    const f = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const label = f(i.type), type = norm(label);
    const datetime = flexibleDate(f(i.date));
    if (!datetime) { warnings.push(`Fecha no reconocida: «${f(i.date)}». Fila no importada.`); continue; }
    const exchange = f(i.exchange), comment = f(i.comment);
    const native = NATIVE.find((n) => n.match.test(exchange));
    const covered = native && coverage[native.broker];
    if (covered && datetime >= covered.from && datetime <= covered.to) { addCount(ignored, `${exchange}: ya está en su propio extracto`); continue; }

    const buy = { qty: amount(f(i.buy)), cur: f(i.buy + 1).toUpperCase() };
    const sell = { qty: amount(f(i.sell)), cur: f(i.sell + 1).toUpperCase() };
    const fee = { qty: i.fee >= 0 ? amount(f(i.fee)) : ZERO, cur: i.fee >= 0 ? f(i.fee + 1).toUpperCase() : '' };
    const date = datetime.slice(0, 10);
    const key = keys.key('ct', label, f(i.buy), buy.cur, f(i.sell), sell.cur, f(i.fee), fee.cur, exchange, f(i.date), f(i.txid));
    const note = ['CoinTracking', exchange || 'sin exchange', comment].filter(Boolean).join(' · ');
    const op = (kind: OpKind, asset: string, currency = 'EUR') => {
      const o = baseOp({ broker: 'cointracking', kind, datetime, assetId: asset, assetName: cryptoName(asset), assetClass: 'crypto', currency, sourceKey: key, note });
      o.sourceExchange = exchange || undefined;
      return o;
    };
    const fiatFee = (cur: string) => (fee.cur === cur && !fee.qty.isZero() ? fee.qty : ZERO);
    const toEur = (value: Decimal, cur: string) => { const k = cur === 'EUR' ? D(1) : rate(cur, date); return k ? value.div(k) : ZERO; };
    // Datos antiguos: se respeta el coste 0 del historial y se avisa para revisarlo.
    const free = (asset: string, qty: Decimal, why: string) => {
      const o = op('buy', asset);
      finishTrade(o, { qty, price: null, grossLocal: ZERO, grossEur: null, fee: ZERO, rate });
      ops.push(review(o, `${why}${comment ? ` («${comment}»)` : ''}: se toma con coste 0, como en tu historial.`));
    };
    const gone = (asset: string, qty: Decimal, why: string) => {
      const o = op('sell', asset);
      finishTrade(o, { qty, price: null, grossLocal: ZERO, grossEur: null, fee: ZERO, rate });
      ops.push(review(o, `${why}${comment ? ` («${comment}»)` : ''}: cuenta como pérdida. Compruébalo.`));
    };

    if (type === 'trade') {
      if (buy.qty.isZero() && sell.qty.isZero()) { addCount(ignored, 'Operaciones vacías'); continue; }
      if (isFiat(buy.cur) && isFiat(sell.cur)) { addCount(ignored, 'Cambios entre monedas fiat'); continue; }
      if ((buy.qty.isZero() && isFiat(sell.cur)) || (sell.qty.isZero() && isFiat(buy.cur))) { addCount(ignored, 'Ajustes de dinero sin contrapartida'); continue; }
      if (buy.qty.isZero()) { gone(sell.cur, sell.qty, 'Baja sin contraprestación en CoinTracking'); continue; }
      if (sell.qty.isZero()) { free(buy.cur, buy.qty, 'Entrada sin contrapartida en CoinTracking'); continue; }
      // El importe en moneda fiat ya incluye la comisión, igual que el ledger de Kraken.
      if (isFiat(sell.cur)) {
        const o = op('buy', buy.cur, sell.cur);
        const paid = fiatFee(sell.cur);
        finishTrade(o, { qty: buy.qty, price: null, grossLocal: sell.qty.minus(paid), grossEur: null, fee: toEur(paid, sell.cur), rate });
        if (sell.cur !== 'EUR') o.settleCurrency = sell.cur;
        ops.push(o);
      } else if (isFiat(buy.cur)) {
        const o = op('sell', sell.cur, buy.cur);
        const paid = fiatFee(buy.cur);
        finishTrade(o, { qty: sell.qty, price: null, grossLocal: buy.qty.plus(paid), grossEur: null, fee: toEur(paid, buy.cur), rate });
        if (buy.cur !== 'EUR') o.settleCurrency = buy.cur;
        ops.push(o);
      } else {
        // Permuta: una stablecoin en dólares da el valor; si no, se valora después con precios de Kraken.
        const o = op('swap', sell.cur);
        const stable = STABLE.has(sell.cur) ? sell.qty : STABLE.has(buy.cur) ? buy.qty : null;
        o.quantity = toStr(sell.qty);
        if (stable && valueInEur(o, sell.qty, stable, 'USD', rate)) o.note = `${note} · Valorada a 1 USD por ${STABLE.has(sell.cur) ? sell.cur : buy.cur}`;
        o.counterAsset = buy.cur;
        o.counterName = cryptoName(buy.cur);
        o.counterQuantity = toStr(buy.qty);
        ops.push(o);
      }
    } else if (type === 'deposit' || type === 'withdrawal') {
      const leg = type === 'deposit' ? buy : sell;
      if (isFiat(leg.cur)) { addCount(ignored, 'Ingresos y retiradas de dinero'); continue; }
      const paid = fee.cur === leg.cur ? fee.qty : ZERO;
      const o = op(type === 'deposit' ? 'transfer_in' : 'transfer_out', leg.cur);
      o.quantity = toStr(type === 'withdrawal' ? leg.qty.minus(paid) : leg.qty);
      ops.push(o);
      if (type === 'withdrawal' && paid.gt(0)) {
        const cost = op('fee', leg.cur);
        cost.feeClass = 'non_deductible';
        cost.quantity = toStr(paid);
        cost.sourceKey = `${key}:fee`;
        cost.note = `${note} · Comisión de retirada pagada en cripto`;
        ops.push(cost);
      }
    } else if (type === 'other fee') {
      const o = isFiat(sell.cur)
        ? baseOp({ broker: 'cointracking', kind: 'fee', datetime, assetId: 'COINTRACKING', assetName: exchange || 'CoinTracking', assetClass: 'other', currency: sell.cur, sourceKey: key, note })
        : op('fee', sell.cur);
      o.feeClass = 'non_deductible';
      o.quantity = toStr(sell.qty);
      if (isFiat(sell.cur)) {
        const eur = toEur(sell.qty, sell.cur);
        o.grossLocal = toStr(sell.qty);
        o.grossEur = eur.toDecimalPlaces(2).toFixed(2);
        o.totalEur = o.grossEur;
      }
      ops.push(o);
    } else if (FREE.has(type)) {
      free(buy.cur, buy.qty, `«${label}» en CoinTracking`);
    } else if (STAKING.has(type)) {
      const o = op('staking', buy.cur);
      o.quantity = toStr(buy.qty);
      ops.push(o);
    } else if (SPENT.has(type)) {
      const o = op('sell', sell.cur);
      o.quantity = toStr(sell.qty);
      if (STABLE.has(sell.cur)) valueInEur(o, sell.qty, sell.qty, 'USD', rate);
      ops.push(review(o, `«${label}» paga con cripto${comment ? ` («${comment}»)` : ''}: cuenta como una venta a precio de mercado.`));
    } else if (GONE.has(type)) {
      gone(sell.cur, sell.qty, `«${label}»`);
    } else {
      addCount(unsupported, label || 'sin tipo');
    }
  }
  for (const [label, n] of Object.entries(unsupported)) {
    warnings.push(`${n === 1 ? '1 movimiento' : `${n} movimientos`} de tipo «${label}» sin importar. Añádelos a mano si tienen efecto fiscal.`);
  }
  return { broker: 'cointracking', format: 'Lista de operaciones', ops, pendingCosts: [], balances: [], markets: {}, warnings, ignored, rows: rows.length };
}
