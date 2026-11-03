import { D, Decimal, ZERO, toStr } from '../../shared/decimal.ts';
import type { Operation } from '../../shared/types.ts';
import { KeyCounter, addCount, baseOp, finishCash, finishTrade, flexibleDate, isFiat, moneyOf, num, review, valueInEur, type ParsedImport, type RateFn } from './common.ts';
import { findCol, findColStarts, norm } from './csv.ts';
import { cryptoName } from './kraken.ts';

export const looksLikeCoinbase = (h: string[]) => ['timestamp', 'transaction type', 'asset', 'quantity transacted'].every((n) => h.some((x) => norm(x) === n));

/** Coinbase pone unas líneas de texto antes de la cabecera. */
export function skipCoinbasePreamble(text: string): string {
  const m = /^"?(?:ID"?,"?)?Timestamp"?,"?Transaction Type/im.exec(text);
  return m ? text.slice(m.index) : text;
}

const BUY = new Set(['buy', 'advanced trade buy', 'advance trade buy', 'credit']);
const SELL = new Set(['sell', 'advanced trade sell', 'advance trade sell', 'retail simple dust']);
const SPENT = new Set(['card spend', 'donation', 'admin debit', 'subscription']);
const INCOME = new Set(['rewards income', 'reward income', 'inflation reward', 'staking income', 'interest payout']);
const REWARD = new Set(['coinbase earn', 'learning reward', 'subscription rebate', 'subscription rebates (24 hours)', 'card buy back']);
const INTERNAL = new Set(['exchange deposit', 'exchange withdrawal', 'pro deposit', 'pro withdrawal', 'prime deposit', 'retail staking transfer', 'retail unstaking transfer', 'staking transfer', 'unstaking transfer', 'asset migration', 'retail eth2 deprecation']);

const amount = (s: string | undefined) => (s ? num(s.replace(/,/g, '')) : null);

export function parseCoinbase(headers: string[], rows: string[][], rate: RateFn): ParsedImport {
  const i = {
    id: findCol(headers, ['ID']), time: findCol(headers, ['Timestamp']), type: findCol(headers, ['Transaction Type']), asset: findCol(headers, ['Asset']), qty: findCol(headers, ['Quantity Transacted']),
    cur: findCol(headers, ['Price Currency', 'Spot Price Currency']), sub: findColStarts(headers, ['subtotal']), total: findColStarts(headers, ['total (inclusive']), fees: headers.findIndex((h) => /^(\w{3} )?fees/i.test(h)), notes: findCol(headers, ['Notes']),
  };
  // Los informes antiguos llevan la moneda en el nombre de la columna: «EUR Subtotal».
  const headerCurrency = /^([A-Z]{3}) /.exec(headers[i.sub] ?? '')?.[1];
  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};

  for (const r of rows) {
    const f = (k: number) => (k >= 0 ? (r[k] ?? '').trim() : '');
    const label = f(i.type);
    const type = norm(label);
    const asset = f(i.asset).toUpperCase();
    const datetime = flexibleDate(f(i.time));
    if (!datetime) { warnings.push(`Fecha no reconocida: «${f(i.time)}». Fila no importada.`); continue; }
    const date = datetime.slice(0, 10);
    const qty = num(f(i.qty))?.abs() ?? ZERO;
    const subtotal = moneyOf(f(i.sub));
    const total = moneyOf(f(i.total));
    const fee = moneyOf(f(i.fees));
    const currency = (f(i.cur) || headerCurrency || subtotal?.currency || total?.currency || 'EUR').toUpperCase();
    const notes = f(i.notes);
    const key = f(i.id) ? `cb:${f(i.id)}` : keys.key('cb', f(i.time), asset, type, f(i.qty), f(i.total));
    const crypto = (kind: Operation['kind'], cur = 'EUR') => baseOp({ broker: 'coinbase', kind, datetime, assetId: asset, assetName: cryptoName(asset), assetClass: 'crypto', currency: cur, sourceKey: key, note: label });
    const swap = (out: string, given: Decimal, inn: string, got: Decimal, value: Decimal | null) => {
      const op = baseOp({ broker: 'coinbase', kind: 'swap', datetime, assetId: out, assetName: cryptoName(out), assetClass: 'crypto', sourceKey: key, note: label });
      valueInEur(op, given, value, currency, rate);
      op.counterAsset = inn;
      op.counterName = cryptoName(inn);
      op.counterQuantity = toStr(got);
      if (!op.grossEur) review(op, 'Permuta sin valor en euros: complétalo a mano.');
      ops.push(op);
    };

    if (BUY.has(type) || SELL.has(type)) {
      const trade = /^(?:Bought|Sold) ([\d,.]+) \w+ for [£€$]?([\d,.]+) (\w+)/.exec(notes);
      const quote = trade?.[3]?.toUpperCase();
      // Pagado con otra cripto, como BTC-USDC: fiscalmente es una permuta.
      if (quote && !isFiat(quote) && quote !== currency) {
        const quoteQty = amount(trade?.[2]) ?? ZERO;
        const value = subtotal?.value ?? total?.value ?? null;
        if (BUY.has(type)) swap(quote, quoteQty, asset, qty, value);
        else swap(asset, qty, quote, quoteQty, value);
        continue;
      }
      const op = crypto(BUY.has(type) ? 'buy' : 'sell', currency);
      const k = currency === 'EUR' ? D(1) : rate(currency, date);
      finishTrade(op, { qty, price: null, grossLocal: subtotal?.value.abs() ?? null, grossEur: null, fee: k && fee ? fee.value.abs().div(k) : ZERO, rate });
      if (currency !== 'EUR') op.settleCurrency = currency;
      ops.push(op);
    } else if (type === 'convert') {
      const m = /^Converted [\d,.]+ \w+ to ([\d,.]+) (\w+)/.exec(notes);
      if (!m) { warnings.push(`Conversión de ${asset} del ${date} sin destino en las notas. Añádela a mano.`); continue; }
      swap(asset, qty, (m[2] as string).toUpperCase(), amount(m[1]) ?? ZERO, total?.value ?? subtotal?.value ?? null);
    } else if (SPENT.has(type)) {
      const op = crypto('sell', currency);
      const k = currency === 'EUR' ? D(1) : rate(currency, date);
      finishTrade(op, { qty, price: null, grossLocal: subtotal?.value.abs() ?? total?.value.abs() ?? null, grossEur: null, fee: k && fee ? fee.value.abs().div(k) : ZERO, rate });
      review(op, `«${label}» paga con cripto: cuenta como una venta. Comprueba el importe.`);
      ops.push(op);
    } else if (INCOME.has(type)) {
      const op = crypto('staking');
      valueInEur(op, qty, subtotal?.value ?? total?.value ?? null, currency, rate);
      ops.push(op);
    } else if (REWARD.has(type)) {
      const op = crypto('reward');
      valueInEur(op, qty, subtotal?.value ?? total?.value ?? null, currency, rate);
      ops.push(op);
    } else if (type === 'receive' && /Coinbase (Earn|Rewards|Referral)/i.test(notes)) {
      const op = crypto('reward');
      valueInEur(op, qty, subtotal?.value ?? total?.value ?? null, currency, rate);
      ops.push(op);
    } else if (type === 'send' || type === 'receive' || ((type === 'deposit' || type === 'withdrawal') && !isFiat(asset))) {
      const op = crypto(type === 'send' || type === 'withdrawal' ? 'transfer_out' : 'transfer_in');
      op.quantity = toStr(qty);
      ops.push(op);
    } else if (type === 'deposit' || type === 'withdrawal') {
      if (asset === 'EUR') { addCount(ignored, 'Ingresos y retiradas en euros'); continue; }
      const op = baseOp({ broker: 'coinbase', kind: type, datetime, assetId: asset, assetName: asset, assetClass: 'other', currency: asset, sourceKey: key });
      finishCash(op, qty, rate);
      ops.push(op);
    } else if (INTERNAL.has(type)) {
      addCount(ignored, 'Movimientos internos de Coinbase');
    } else {
      warnings.push(`Tipo sin clasificar «${label}» de ${asset} del ${date}. Añádelo a mano si tiene efecto fiscal.`);
    }
  }
  return { broker: 'coinbase', format: 'Historial de transacciones', ops, pendingCosts: [], balances: [], markets: {}, warnings, ignored, rows: rows.length };
}
