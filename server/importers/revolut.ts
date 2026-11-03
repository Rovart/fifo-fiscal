import { D, Decimal, ZERO, toStr } from '../../shared/decimal.ts';
import type { Operation } from '../../shared/types.ts';
import { REVOLUT_DIVIDEND, validIsin } from '../../shared/review.ts';
import { securityFor } from '../securities.ts';
import { KeyCounter, addCount, baseOp, finishCash, finishIncome, finishTrade, flexibleDate, moneyOf, num, review, valueInEur, type ParsedImport, type RateFn } from './common.ts';
import { findCol, norm } from './csv.ts';
import { cryptoName } from './kraken.ts';

const has = (headers: string[], names: string[]) => names.every((n) => headers.some((h) => norm(h) === norm(n)));

export const looksLikeRevolutStocks = (h: string[]) => has(h, ['Ticker', 'Type', 'Quantity', 'Price per share', 'Total Amount']);
export const looksLikeRevolutCrypto = (h: string[]) => has(h, ['Symbol', 'Type', 'Quantity', 'Price', 'Value', 'Fees', 'Date']);
export const looksLikeRevolutBank = (h: string[]) => has(h, ['Type', 'Product', 'Started Date', 'Completed Date', 'Description', 'Amount']);

/** El tipo de la fila solo se usa si encaja con el BCE, directo o invertido: no consta en qué sentido lo da Revolut. */
function usableRate(fx: Decimal | null, currency: string, date: string, rate: RateFn): Decimal | null {
  if (!fx || fx.lte(0) || currency === 'EUR') return null;
  const ecb = rate(currency, date);
  if (!ecb) return fx;
  const near = (x: Decimal) => x.div(ecb).minus(1).abs().lt('0.05');
  return near(fx) ? fx : near(D(1).div(fx)) ? D(1).div(fx) : null;
}

export function parseRevolutStocks(headers: string[], rows: string[][], rate: RateFn): ParsedImport {
  const col = (n: string) => findCol(headers, [n]);
  const i = { date: col('Date'), ticker: col('Ticker'), isin: col('ISIN'), type: col('Type'), qty: col('Quantity'), price: col('Price per share'), total: col('Total Amount'), cur: col('Currency'), fx: col('FX Rate') };
  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const markets: ParsedImport['markets'] = {};

  for (const r of rows) {
    const f = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const type = f(i.type).toUpperCase();
    const datetime = flexibleDate(f(i.date));
    if (!datetime) { warnings.push(`Fecha no reconocida: «${f(i.date)}». Fila no importada.`); continue; }
    const date = datetime.slice(0, 10);
    const ticker = f(i.ticker).toUpperCase();
    const total = moneyOf(f(i.total));
    const currency = (f(i.cur) || total?.currency || 'USD').toUpperCase();
    const key = keys.key('rev-st', f(i.date), ticker, type, f(i.qty), f(i.total));
    const fx = usableRate(num(f(i.fx)), currency, date, rate);
    const suppliedIsin = f(i.isin).toUpperCase();
    const assetId = validIsin(suppliedIsin) ? suppliedIsin : ticker;
    const stock = (kind: Operation['kind']) => baseOp({ broker: 'revolut', kind, datetime, assetId, assetName: securityFor(assetId)?.name ?? ticker, assetClass: securityFor(assetId) ? 'etf' : 'stock', currency, sourceKey: key });
    const amount = total?.value.abs() ?? ZERO;

    if (/^(BUY|SELL)\b/.test(type) || /POSITION CLOSURE/.test(type)) {
      const qty = num(f(i.qty))?.abs() ?? null;
      if (!ticker || !qty || qty.isZero()) { warnings.push(`${type} sin valor o cantidad el ${date}. Fila no importada.`); continue; }
      const op = stock(/^BUY/.test(type) ? 'buy' : 'sell');
      const price = moneyOf(f(i.price))?.value.abs() ?? null;
      const gross = price && !price.isZero() ? qty.times(price) : amount;
      const r0 = currency === 'EUR' ? D(1) : fx ?? rate(currency, date);
      // Revolut no separa la comisión: es la diferencia entre el total y cantidad por precio.
      const diff = op.kind === 'buy' ? amount.minus(gross) : gross.minus(amount);
      const fee = amount.gt(0) && diff.gt('0.005') && r0 ? diff.div(r0) : ZERO;
      finishTrade(op, { qty, price, grossLocal: gross, grossEur: null, fee, reportedRate: fx, rate });
      if (currency !== 'EUR') op.settleCurrency = currency;
      if (/POSITION CLOSURE/.test(type)) review(op, 'Revolut cerró esta posición (exclusión o similar). Comprueba que es una venta.');
      if (currency === 'USD' && !securityFor(assetId)) markets[assetId] = 'us';
      ops.push(op);
    } else if (/CASH TOP-?UP/.test(type) || /CASH WITHDRAWAL/.test(type)) {
      if (currency === 'EUR') { addCount(ignored, 'Ingresos y retiradas en euros'); continue; }
      const op = baseOp({ broker: 'revolut', kind: /TOP/.test(type) ? 'deposit' : 'withdrawal', datetime, assetId: currency, assetName: currency, assetClass: 'other', currency, sourceKey: key });
      finishCash(op, amount, rate);
      ops.push(op);
    } else if (/^DIVIDEND/.test(type)) {
      if (!ticker) { warnings.push(`Dividendo sin valor el ${date}. Fila no importada.`); continue; }
      const op = stock('dividend');
      finishIncome(op, { grossLocal: amount, withheldLocal: ZERO, rate, rateValue: fx });
      if (currency !== 'EUR') op.settleCurrency = currency;
      review(op, REVOLUT_DIVIDEND);
      ops.push(op);
    } else if (/FEE/.test(type)) {
      const op = baseOp({ broker: 'revolut', kind: 'fee', datetime, assetId: ticker || 'REVOLUT', assetName: ticker || 'Revolut', assetClass: 'other', currency, sourceKey: key, note: f(i.type) });
      // La custodia es deducible (art. 26 LIRPF); la gestión de carteras, no.
      op.feeClass = /CUSTODY/.test(type) ? 'custody' : 'non_deductible';
      finishCash(op, amount, rate);
      op.totalEur = op.grossEur;
      if (currency !== 'EUR') op.settleCurrency = currency;
      ops.push(op);
    } else if (/STOCK SPLIT/.test(type)) {
      const delta = num(f(i.qty));
      if (!ticker || !delta) { warnings.push(`Split sin datos el ${date}. Añádelo a mano.`); continue; }
      const op = stock('split');
      op.quantity = toStr(delta);
      review(op, 'Parece un split o canje sin impuestos. Comprueba que fue así.');
      ops.push(op);
    } else if (/^TRANSFER FROM .* TO /.test(type)) {
      addCount(ignored, 'Traspasos entre sociedades de Revolut');
    } else {
      warnings.push(`Tipo sin clasificar «${f(i.type)}» del ${date}${ticker ? ` (${ticker})` : ''}. Añádelo a mano si tiene efecto fiscal.`);
    }
  }
  return { broker: 'revolut', format: 'Extracto de acciones', ops, pendingCosts: [], balances: [], markets, warnings, ignored, rows: rows.length };
}

export function parseRevolutCrypto(headers: string[], rows: string[][], rate: RateFn): ParsedImport {
  const col = (n: string) => findCol(headers, [n]);
  const i = { sym: col('Symbol'), type: col('Type'), qty: col('Quantity'), price: col('Price'), value: col('Value'), fees: col('Fees'), date: col('Date') };
  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};

  for (const r of rows) {
    const f = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const type = norm(f(i.type));
    const asset = f(i.sym).toUpperCase();
    const datetime = flexibleDate(f(i.date));
    if (!datetime) { warnings.push(`Fecha no reconocida: «${f(i.date)}». Fila no importada.`); continue; }
    const qty = num(f(i.qty))?.abs() ?? ZERO;
    const value = moneyOf(f(i.value));
    const price = moneyOf(f(i.price));
    const fee = moneyOf(f(i.fees));
    const currency = value?.currency ?? price?.currency ?? fee?.currency ?? 'EUR';
    const key = keys.key('rev-cr', f(i.date), asset, type, f(i.qty), f(i.value));
    const crypto = (kind: Operation['kind'], cur = 'EUR') => baseOp({ broker: 'revolut', kind, datetime, assetId: asset, assetName: cryptoName(asset), assetClass: 'crypto', currency: cur, sourceKey: key });

    if (type === 'buy' || type === 'sell') {
      const op = crypto(type, currency);
      const r0 = currency === 'EUR' ? D(1) : rate(currency, datetime.slice(0, 10));
      const gross = value?.value.abs() ?? (price ? qty.times(price.value.abs()) : null);
      finishTrade(op, { qty, price: null, grossLocal: gross, grossEur: null, fee: fee && r0 ? fee.value.abs().div(r0) : ZERO, rate });
      if (currency !== 'EUR') op.settleCurrency = currency;
      ops.push(op);
    } else if (type === 'send' || type === 'receive') {
      const op = crypto(type === 'send' ? 'transfer_out' : 'transfer_in');
      op.quantity = toStr(qty);
      ops.push(op);
    } else if (type === 'staking reward') {
      const op = crypto('staking');
      valueInEur(op, qty, value?.value ?? null, currency, rate);
      ops.push(op);
    } else if (type === 'learn reward' || type === 'reward') {
      const op = crypto('reward');
      valueInEur(op, qty, value?.value ?? null, currency, rate);
      ops.push(op);
    } else if (type === 'stake' || type === 'unstake') {
      addCount(ignored, 'Movimientos internos de staking');
    } else {
      warnings.push(`Tipo sin clasificar «${f(i.type)}» de ${asset} del ${datetime.slice(0, 10)}. Añádelo a mano si tiene efecto fiscal.`);
    }
  }
  return { broker: 'revolut', format: 'Extracto de cripto', ops, pendingCosts: [], balances: [], markets: {}, warnings, ignored, rows: rows.length };
}
