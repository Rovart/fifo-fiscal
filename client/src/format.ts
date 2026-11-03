const eurFmt = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' } as Intl.NumberFormatOptions);
const n2 = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' } as Intl.NumberFormatOptions);
const qtyFmt = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 8, useGrouping: 'always' } as Intl.NumberFormatOptions);
const priceFmt = new Intl.NumberFormat('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 6, useGrouping: 'always' } as Intl.NumberFormatOptions);

// Intl acepta cadenas decimales sin pasar por float.
type NumLike = string | number | null | undefined;
const asArg = (v: NumLike) => v as unknown as number;
const empty = (v: NumLike) => v === null || v === undefined || v === '';

export const eur = (v: NumLike): string => (empty(v) ? '—' : eurFmt.format(asArg(v)));
export const money = (v: NumLike): string => (empty(v) ? '—' : n2.format(asArg(v)));
export const qty = (v: NumLike): string => (empty(v) ? '—' : qtyFmt.format(asArg(v)));
export const price = (v: NumLike): string => (empty(v) ? '—' : priceFmt.format(asArg(v)));

/** +1.234,56 € o −1.234,56 €, con signo siempre visible. */
export const signed = (v: NumLike): string => {
  if (empty(v)) return '—';
  const n = Number(v);
  const abs = String(v).replace(/^-/, '');
  if (n === 0) return eurFmt.format(0);
  return `${n > 0 ? '+' : '−'}${eurFmt.format(asArg(abs))}`;
};
export const signClass = (v: NumLike): string => {
  const n = Number(v);
  return n > 0 ? 'gain' : n < 0 ? 'loss' : '';
};

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const dateShort = (s: string | null | undefined): string => {
  if (!s) return '—';
  const [y, m, d] = s.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
};
export const dayMonth = (s: string): string => {
  const [, m, d] = s.slice(0, 10).split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]}`;
};
export const monthLabel = (s: string): string => `${MONTHS_LONG[Number(s.slice(5, 7)) - 1]} de ${s.slice(0, 4)}`;

const compactFmt = new Intl.NumberFormat('es-ES', { notation: 'compact', maximumFractionDigits: 1 });
/** «12,3 mil €»: para ejes y etiquetas de gráficas. */
export const compactEur = (v: number): string => `${compactFmt.format(v)} €`;
export const compactSigned = (v: number): string => `${v > 0 ? '+' : v < 0 ? '−' : ''}${compactFmt.format(Math.abs(v))} €`;
/** «+12,3 %» */
export const percent = (v: string | number): string => {
  const n = Number(v);
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('es-ES', { maximumFractionDigits: Math.abs(n) >= 100 ? 0 : 1 })} %`;
};
const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
/** «mar 2026» */
export const monthShort = (month: string): string => `${MONTHS_SHORT[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
export const plain = (v: string | null | undefined): string => (v ?? '').replace('.', ',');
/** Como `plain`, pero con al menos dos decimales. */
export const plainMoney = (v: string | null | undefined): string => {
  if (v === null || v === undefined || v === '') return '';
  const [int, dec = ''] = v.split('.');
  return `${int},${dec.padEnd(2, '0')}`;
};

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£', JPY: '¥', GBX: 'p' };
export const symbol = (c: string | null | undefined): string => SYMBOLS[c ?? ''] ?? (c ?? '');

const SPECIAL: Record<string, string> = { ISHARES: 'iShares', XTRACKERS: 'Xtrackers', VANECK: 'VanEck', WISDOMTREE: 'WisdomTree', HANETF: 'HANetf', 'JPMORGAN': 'JPMorgan', 'BLACKROCK': 'BlackRock' };
const KEEP_UPPER = new Set(['ASML', 'IBM', 'AMD', 'BMW', 'SAP', 'BBVA', 'ING', 'AXA', 'CAF', 'ACS', 'UBS', 'BNP', 'TSMC', 'LVMH', 'NXP', 'ETF', 'ETC', 'UCITS', 'MSCI', 'S&P', 'SA', 'AG', 'NV', 'SE', 'PLC', 'ACC', 'DIST', 'USD', 'EUR', 'GBP', 'ADR', 'SPDR', 'NASDAQ', 'FTSE', 'REIT', 'AB', 'ASA', 'BV', 'II', 'III', 'IV']);
const titleWord = (w: string): string => {
  const clean = w.replace(/[.,()]/g, '');
  if (SPECIAL[clean]) return SPECIAL[clean] as string;
  if (KEEP_UPPER.has(clean) || /\d/.test(w)) return w;
  return w.charAt(0) + w.slice(1).toLowerCase();
};
/** El identificador si es un ISIN; las criptomonedas y las monedas no lo tienen. */
export const isinOf = (assetId: string): string | null => (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(assetId) ? assetId : null);

/** «APPLE INC. - COMMON ST» → «Apple Inc.». Solo para mostrar. */
export function niceName(raw: string | null | undefined): string {
  let s = (raw ?? '').trim();
  s = s.replace(/\s*[-–]\s*(COMMON|CLASS [A-C]|ORDINARY|REGISTERED|CAPITAL STOCK|SHARES|CL [A-C]).*$/i, '');
  if (s.length > 3 && s === s.toUpperCase() && /[A-Z]{3}/.test(s)) s = s.split(/\s+/).map(titleWord).join(' ');
  return s;
}
/** «3 acciones», «14 participaciones» o «0,5 BTC». */
export function units(quantity: string | null | undefined, klass: string, assetId: string): string {
  const n = qty(quantity);
  if (klass === 'crypto' || klass === 'fx') return `${n} ${assetId.replace('FX:', '')}`;
  const one = Number(quantity) === 1;
  if (klass === 'stock') return `${n} ${one ? 'acción' : 'acciones'}`;
  if (klass === 'etf' || klass === 'fund') return `${n} ${one ? 'participación' : 'participaciones'}`;
  return n;
}
export const initial = (name: string): string => niceName(name).charAt(0).toUpperCase() || '?';
