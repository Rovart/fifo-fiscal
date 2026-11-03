/** CSV con comillas, BOM y separador coma, punto y coma o tabulador. */
export function detectDelimiter(headerLine: string): string {
  const count = (c: string) => headerLine.split(c).length - 1;
  const best = [',', ';', '\t'].sort((a, b) => count(b) - count(a));
  return best[0] as string;
}

export function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/, 1)[0] ?? '';
  const delim = detectDelimiter(firstLine);
  const records: string[][] = [];
  let field = '', row: string[] = [], quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delim) {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) records.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) records.push(row);
  return { headers: (records[0] ?? []).map((h) => h.trim()), rows: records.slice(1) };
}

export const norm = (s: string): string => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

export function findCol(headers: string[], names: string[], from = 0): number {
  const wanted = names.map(norm);
  for (let i = from; i < headers.length; i++) {
    if (wanted.includes(norm(headers[i] as string))) return i;
  }
  return -1;
}
export function findColStarts(headers: string[], names: string[], from = 0): number {
  const wanted = names.map(norm);
  for (let i = from; i < headers.length; i++) {
    const h = norm(headers[i] as string);
    if (h && wanted.some((w) => h.startsWith(w) || h.includes(w))) return i;
  }
  return -1;
}
