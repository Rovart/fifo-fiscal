import Decimal from 'decimal.js';

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export { Decimal };
export const D = (v: Decimal.Value | null | undefined): Decimal => {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(v);
};
export const ZERO = new Decimal(0);

export const isNum = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  try {
    return new Decimal(v as Decimal.Value).isFinite();
  } catch {
    return false;
  }
};

/** Cadena sin ceros finales ni notación científica, apta para guardar. */
export const toStr = (d: Decimal, decimals?: number): string => {
  const v = decimals === undefined ? d : d.toDecimalPlaces(decimals);
  return v.toFixed();
};
export const cents = (d: Decimal): string => d.toDecimalPlaces(2).toFixed(2);

/** "1.234,56" o "1234.56" o "1,234.56" → cadena decimal normalizada. */
export const parseLocaleNumber = (raw: string): string | null => {
  let s = raw.trim().replace(/\s| /g, '');
  if (!s) return null;
  const comma = s.lastIndexOf(',');
  const dot = s.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    if (comma > dot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (comma >= 0) {
    s = s.replace(',', '.');
  }
  return isNum(s) ? new Decimal(s).toFixed() : null;
};
