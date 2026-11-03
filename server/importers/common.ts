import { createHash, randomUUID } from 'node:crypto';
import { D, Decimal, cents, isNum, parseLocaleNumber, toStr } from '../../shared/decimal.ts';
import type { AssetClass, Broker, Market, OpKind, Operation } from '../../shared/types.ts';
import { utcToMadrid } from '../engine/dates.ts';

export type RateFn = (currency: string, date: string) => Decimal | null;

export interface PendingCost {
  orderRef: string | null;
  assetId: string;
  assetName: string;
  datetime: string;
  amountEur: string;
  label: string;
  sourceKey: string;
}

export interface DeclaredBalance { broker: Broker; assetId: string; quantity: string; asOf: string }

export interface ParsedImport {
  broker: Broker;
  format: string;
  ops: Operation[];
  pendingCosts: PendingCost[];
  balances: DeclaredBalance[];
  markets: Record<string, Market>;
  warnings: string[];
  ignored: Record<string, number>;
  rows: number;
}

export const hashKey = (...parts: unknown[]): string =>
  createHash('sha256').update(parts.map((p) => String(p ?? '')).join('|')).digest('hex').slice(0, 24);

/** Evita colisiones entre filas idénticas de un mismo fichero. */
export class KeyCounter {
  private seen = new Map<string, number>();
  key(prefix: string, ...parts: unknown[]): string {
    const base = hashKey(prefix, ...parts);
    const n = this.seen.get(base) ?? 0;
    this.seen.set(base, n + 1);
    return n === 0 ? `${prefix}:${base}` : `${prefix}:${base}:${n}`;
  }
}

export const num = (raw: string | undefined | null): Decimal | null => {
  if (raw === undefined || raw === null) return null;
  const s = parseLocaleNumber(raw);
  return s === null ? null : D(s);
};

export const baseOp = (p: {
  broker: Broker; kind: OpKind; datetime: string; assetId: string; assetName: string; assetClass: AssetClass;
  currency?: string; sourceKey: string; note?: string;
}): Operation => ({
  id: randomUUID(), broker: p.broker, kind: p.kind, datetime: p.datetime, assetId: p.assetId, assetName: p.assetName,
  assetClass: p.assetClass, quantity: null, unitPrice: null, currency: p.currency ?? 'EUR', fxRate: p.currency && p.currency !== 'EUR' ? null : '1',
  grossLocal: null, grossEur: null, feeEur: '0', otherCostsEur: '0', withholdingEur: '0', totalEur: null, settleCurrency: 'EUR',
  sourceKey: p.sourceKey, note: p.note, reviewReasons: [],
});

export const review = (op: Operation, reason: string): Operation => {
  (op.reviewReasons ??= []).push(reason);
  return op;
};

/**
 * Deja una compra o venta coherente a partir de lo que declara el bróker.
 * El dinero manda: si el precio publicado está redondeado se recalcula, y el tipo
 * de cambio pasa a ser el efectivo entre importe local y euros.
 */
export function finishTrade(op: Operation, p: {
  qty: Decimal; price: Decimal | null; grossLocal: Decimal | null; grossEur: Decimal | null;
  fee: Decimal; other?: Decimal; total?: Decimal | null; reportedRate?: Decimal | null; rate?: RateFn;
}): Operation {
  const date = op.datetime.slice(0, 10);
  op.quantity = toStr(p.qty);
  const gL = p.grossLocal ?? (p.price ? p.qty.times(p.price) : null);
  if (gL === null) {
    review(op, 'Sin precio ni importe: complétalo a mano.');
    return op;
  }
  op.grossLocal = cents(gL);
  const printed = p.price ?? gL.div(p.qty);
  op.unitPrice = D(p.qty).times(printed).minus(gL).abs().lte('0.01') ? toStr(printed) : toStr(gL.div(p.qty), 10);

  if (op.currency === 'EUR') {
    op.fxRate = '1';
    op.grossEur = cents(gL);
  } else if (p.grossEur && !p.grossEur.isZero()) {
    op.grossEur = cents(p.grossEur);
    op.fxRate = toStr(gL.div(p.grossEur), 10);
    op.fxSource = 'broker';
  } else if (p.reportedRate && p.reportedRate.gt(0)) {
    op.fxRate = toStr(p.reportedRate, 10);
    op.grossEur = cents(gL.div(p.reportedRate));
    op.fxSource = 'broker';
  } else {
    const r = p.rate?.(op.currency, date);
    if (r) {
      op.fxRate = toStr(r);
      op.grossEur = cents(gL.div(r));
      op.fxSource = 'ecb';
    } else {
      review(op, `Sin tipo de cambio ${op.currency}/EUR para ${date}.`);
      return op;
    }
  }
  op.feeEur = cents(p.fee);
  op.otherCostsEur = cents(p.other ?? D(0));
  const fees = p.fee.plus(p.other ?? 0);
  const computed = op.kind === 'buy' ? D(op.grossEur).plus(fees) : D(op.grossEur).minus(fees);
  // Si la comisión supera lo cobrado, el total de una venta es negativo: no se fuerza el signo.
  op.totalEur = cents(p.total ?? computed);
  if (p.total && p.total.minus(computed).abs().gt('0.02')) {
    review(op, `El total del bróker (${cents(p.total)} €) difiere del calculado (${cents(computed)} €).`);
  }
  return op;
}

export function finishIncome(op: Operation, p: { grossLocal: Decimal; withheldLocal: Decimal; rate?: RateFn; rateValue?: Decimal | null; feeEur?: Decimal }): Operation {
  const date = op.datetime.slice(0, 10);
  op.grossLocal = toStr(p.grossLocal, 8);
  let r: Decimal | null = D(1);
  if (op.currency !== 'EUR') {
    r = p.rateValue ?? p.rate?.(op.currency, date) ?? null;
    if (!r) {
      review(op, `Sin tipo de cambio ${op.currency}/EUR para ${date}.`);
      return op;
    }
    op.fxRate = toStr(r);
    op.fxSource = p.rateValue ? 'broker' : 'ecb';
  }
  op.grossEur = cents(p.grossLocal.div(r));
  op.withholdingEur = cents(p.withheldLocal.div(r));
  op.feeEur = cents(p.feeEur ?? D(0));
  op.totalEur = cents(D(op.grossEur).minus(D(op.withholdingEur)).minus(D(op.feeEur)));
  return op;
}

export function finishCash(op: Operation, amount: Decimal, rate: RateFn): Operation {
  const date = op.datetime.slice(0, 10);
  op.grossLocal = toStr(amount, 8);
  if (op.currency === 'EUR') {
    op.grossEur = cents(amount);
  } else {
    const r = rate(op.currency, date);
    if (!r) return review(op, `Sin tipo de cambio ${op.currency}/EUR para ${date}.`);
    op.fxRate = toStr(r);
    op.fxSource = 'ecb';
    op.grossEur = cents(amount.div(r));
  }
  op.totalEur = op.grossEur;
  return op;
}

const ETF_RE = /\b(etf|ucits|ishares|vanguard|amundi|xtrackers|x-trackers|spdr|lyxor|invesco|wisdomtree|vaneck|hanetf|fidelity\s+\w+\s+etf|msci world|s&p 500 (ucits|etf))\b/i;
const ETC_RE = /\b(etc|physical (gold|silver)|xetra[- ]gold|etn)\b/i;

export function classifyProduct(name: string): { assetClass: AssetClass; etc: boolean } {
  if (ETC_RE.test(name)) return { assetClass: 'other', etc: true };
  if (ETF_RE.test(name)) return { assetClass: 'etf', etc: false };
  return { assetClass: 'stock', etc: false };
}

const US_MARKETS = new Set(['NDQ', 'NSY', 'NYSE', 'NASDAQ', 'ASE', 'NMS', 'ARC', 'BATS', 'AMEX', 'OTC']);
const EU_MARKETS = new Set([
  'XET', 'FRA', 'TDG', 'MUN', 'STU', 'GER', 'EPA', 'EAM', 'EBR', 'ELI', 'MIL', 'MAD', 'WSE', 'OMX', 'OMXS', 'OMXH', 'OMXC', 'CSE', 'HEL', 'STO', 'LIS',
  'ISE', 'DUB', 'VIE', 'ATH', 'BUD', 'PRA', 'OSE', 'OSL', 'EPA.', 'EUX', 'XAMS', 'XPAR', 'XETR', 'XMAD', 'TOM', 'EURONEXT', 'CEUX', 'TRQ',
]);

export function marketOf(code: string): Market {
  const c = code.trim().toUpperCase();
  if (US_MARKETS.has(c)) return 'us';
  if (EU_MARKETS.has(c)) return 'eu';
  return c ? 'other' : 'eu';
}

export const isFiat = (s: string): boolean => ['EUR', 'USD', 'GBP', 'CHF', 'CAD', 'AUD', 'JPY', 'SEK', 'NOK', 'DKK', 'GBX', 'HKD'].includes(s);

export const addCount = (m: Record<string, number>, k: string) => { m[k] = (m[k] ?? 0) + 1; };

export { isNum };

const MONEY_SYMBOL: Record<string, string> = { '€': 'EUR', '$': 'USD', '£': 'GBP' };

/** «€1,234.56», «USD 12.00», «US$12» o «1.234,56 €» → importe y moneda, si la indica. */
export function moneyOf(raw: string | undefined | null): { value: Decimal; currency: string | null } | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  const value = num(s.replace(/[^\d.,-]/g, ''));
  if (!value) return null;
  const code = /\b([A-Z]{3})\b/.exec(s)?.[1];
  const sign = /[€$£]/.exec(s)?.[0];
  return { value, currency: code ?? (sign ? MONEY_SYMBOL[sign] as string : null) };
}

const MONTHS: Record<string, number> = {
  jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, set: 9, oct: 10, nov: 11, dec: 12, dic: 12,
};

const pad = (n: number | string) => String(n).padStart(2, '0');

/**
 * Fecha en los formatos de Revolut y Coinbase. Con zona horaria se pasa a hora de España;
 * sin ella se toma tal cual, porque esos extractos ya vienen en la hora de la cuenta.
 */
export function flexibleDate(raw: string | undefined | null): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) {
    const clock = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
    if (!m[7]) return clock;
    return utcToMadrid(/^[+-]/.test(m[7]) ? `${clock}${m[7]}` : `${clock}Z`);
  }
  const time = (h: string, min: string, sec: string | undefined, ampm: string | undefined) => {
    let hour = Number(h);
    if (ampm && /pm/i.test(ampm) && hour < 12) hour += 12;
    if (ampm && /am/i.test(ampm) && hour === 12) hour = 0;
    return `${pad(hour)}:${min}:${sec ?? '00'}`;
  };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(s);
  if (m) return `${m[3]}-${pad(m[2] as string)}-${pad(m[1] as string)}T${time(m[4] ?? '00', m[5] ?? '00', m[6], m[7])}`;
  // «Jan 5, 2024, 10:00:00 AM»
  m = /^([A-Za-zÀ-ÿ]{3})[a-zÀ-ÿ]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(s);
  if (m && MONTHS[(m[1] as string).toLowerCase()]) return `${m[3]}-${pad(MONTHS[(m[1] as string).toLowerCase()] as number)}-${pad(m[2] as string)}T${time(m[4] ?? '00', m[5] ?? '00', m[6], m[7])}`;
  // «5 ene 2024, 10:00:00»
  m = /^(\d{1,2})\s+(?:de\s+)?([A-Za-zÀ-ÿ]{3})[a-zÀ-ÿ]*\.?\s+(?:de\s+)?(\d{4})(?:,?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(s);
  if (m && MONTHS[(m[2] as string).toLowerCase()]) return `${m[3]}-${pad(MONTHS[(m[2] as string).toLowerCase()] as number)}-${pad(m[1] as string)}T${time(m[4] ?? '00', m[5] ?? '00', m[6], m[7])}`;
  return null;
}

/** Deja un ingreso en especie o una permuta valorados en euros, desde su importe en cualquier moneda. */
export function valueInEur(op: Operation, qty: Decimal, value: Decimal | null, currency: string, rate: RateFn): boolean {
  op.quantity = toStr(qty);
  if (!value) return false;
  const r = currency === 'EUR' ? D(1) : rate(currency, op.datetime.slice(0, 10));
  if (!r) return false;
  const eur = value.abs().div(r);
  op.currency = 'EUR';
  op.fxRate = '1';
  op.grossLocal = cents(eur);
  op.grossEur = op.grossLocal;
  op.totalEur = op.grossLocal;
  if (qty.gt(0)) op.unitPrice = toStr(eur.div(qty), 10);
  return true;
}
