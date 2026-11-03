export const REVOLUT_ISIN = 'Revolut no da el ISIN. Si tienes este valor en otro bróker, escríbelo en Ajustes, en Mis activos, para que cuente en el mismo FIFO.';
export const REVOLUT_DIVIDEND = 'Revolut da el dividendo ya neto. Si te retuvieron, corrige el bruto y la retención con su informe anual.';
export const CONNECTIVITY_FEE = 'Comisión de conectividad: la dejamos como no deducible por prudencia.';
export const CORPORATE_ACTION = 'Parece un split o canje sin impuestos. Comprueba que fue así.';
export const STOCK_SPLIT = 'Parece un split. Comprueba que el número de acciones es correcto.';

/** Incluye el dígito de control, para no unir activos por una cadena mal escrita. */
export function validIsin(value: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(value)) return false;
  const digits = [...value].map((c) => /\d/.test(c) ? c : String(c.charCodeAt(0) - 55)).join('');
  let sum = 0;
  for (let i = digits.length - 1, pos = 0; i >= 0; i--, pos++) {
    let n = Number(digits[i]);
    if (pos % 2) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
