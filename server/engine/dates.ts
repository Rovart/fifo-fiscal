export const dateOf = (dt: string): string => dt.slice(0, 10);
export const yearOf = (dt: string): number => Number(dt.slice(0, 4));

/** Suma meses de calendario recortando a fin de mes (15/03 − 2 = 15/01; 31/12 + 2 = 28/02). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = dateOf(date).split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  const nd = Math.min(d, last);
  return `${ny}-${String(nm + 1).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}

export const nextMonth = (month: string): string => addMonths(`${month}-01`, 1).slice(0, 7);
export const prevMonth = (month: string): string => addMonths(`${month}-01`, -1).slice(0, 7);

const madrid = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Instante UTC → fecha y hora en España, que es la que manda para imputar el ejercicio. */
export function utcToMadrid(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha no válida: ${iso}`);
  return madrid.format(d).replace(' ', 'T');
}
