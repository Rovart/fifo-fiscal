import { D, Decimal, ZERO, toStr } from '../shared/decimal.ts';
import { BROKER_LABEL, fullName, type Broker, type Custodian, type CustodianIdType, type DisposalClass, type ForeignForm, type ForeignFormReport, type Settings } from '../shared/types.ts';

/**
 * Ficheros para presentar los modelos 720 y 721 en la sede de la AEAT.
 * 720: diseño de registro de 500 posiciones (Orden HAP/72/2013), «Presentación mediante fichero».
 * 721: mensaje XML del servicio web (Orden HFP/886/2023 y HAC/1504/2024, esquema IDVersionModelo 1.0).
 */

/** Valores de partida de cada entidad. Se revisan y cambian desde la interfaz. */
const DEFAULTS: Record<string, Custodian> = {
  '720|degiro': { name: 'flatexDEGIRO Bank AG', country: 'NL', idType: '02', id: '', web: 'www.degiro.es' },
  '720|trade_republic': { name: 'Trade Republic Bank GmbH', country: 'DE', idType: '02', id: '', web: 'www.traderepublic.com' },
  '720|revolut': { name: 'Revolut Securities Europe UAB', country: 'LT', idType: '02', id: '', web: 'www.revolut.com' },
  '721|kraken': { name: 'Payward Europe Solutions Limited', country: 'IE', idType: '04', id: '', web: 'www.kraken.com' },
  '721|coinbase': { name: 'Coinbase Luxembourg S.A.', country: 'LU', idType: '04', id: 'B292147', web: 'www.coinbase.com' },
  '721|trade_republic': { name: 'Trade Republic Bank GmbH', country: 'DE', idType: '02', id: '', web: 'www.traderepublic.com' },
  '721|revolut': { name: 'Revolut Digital Assets Europe Ltd', country: 'CY', idType: '02', id: '', web: 'www.revolut.com' },
};

export const ID_TYPES: CustodianIdType[] = ['nif', '02', '03', '04', '05', '06'];

export function custodianFor(form: ForeignForm, broker: string, settings: Settings): Custodian {
  const key = `${form}|${broker}`;
  const base = DEFAULTS[key] ?? { name: BROKER_LABEL[broker as Broker] ?? broker, country: '', idType: '02' as const, id: '', web: '' };
  return { ...base, ...(settings.custodians?.[key] ?? {}) };
}

const NIF_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';
export const normalNif = (raw: string) => raw.toUpperCase().replace(/[\s.-]/g, '');
/** DNI y NIE con su letra de control; K, L y M sin control. */
export function validNif(raw: string): boolean {
  const n = normalNif(raw);
  let m = /^(\d{8})([A-Z])$/.exec(n);
  if (m) return NIF_LETTERS[Number(m[1]) % 23] === m[2];
  m = /^([XYZ])(\d{7})([A-Z])$/.exec(n);
  if (m) return NIF_LETTERS[Number(`${'XYZ'.indexOf(m[1]!)}${m[2]}`) % 23] === m[3];
  return /^[KLM]\d{7}[A-Z]$/.test(n);
}

/** Lo que entra en el fichero: si solo obliga un cierre, lo demás no se vuelve a declarar. */
export function fileItems(f: ForeignFormReport) {
  const onlyClosures = f.reasons.length > 0 && f.reasons.every((r) => r === 'closures');
  return { holdings: onlyClosures ? [] : f.holdings, closures: f.closures, onlyClosures };
}

/** Lo que falta para generar el fichero, en palabras de la interfaz. */
export function missingFor(f: ForeignFormReport, settings: Settings, estimated: boolean): string[] {
  if (estimated) return ['que termine el año'];
  const out: string[] = [];
  const { holdings, closures } = fileItems(f);
  if (holdings.length === 0 && closures.length === 0) return ['algo que declarar'];
  const d = settings.declarant;
  if (!d || !validNif(d.nif)) out.push('tu NIF');
  if (!d?.surnames?.trim() || !d.firstName?.trim()) out.push('tus apellidos y nombre');
  if (!d || !/^\d{9}$/.test(d.phone)) out.push('un teléfono de 9 cifras');
  for (const broker of new Set([...holdings, ...closures].map((h) => h.broker))) {
    const c = custodianFor(f.form, broker, settings);
    const label = BROKER_LABEL[broker as Broker] ?? broker;
    if (!/^[A-Z]{2}$/.test(c.country)) out.push(`el país de ${label}`);
    if (f.form === '721') {
      if (!c.name.trim()) out.push(`el nombre de la entidad de ${label}`);
      if (!c.id.trim()) out.push(`el número de identificación de ${label}`);
      else if (c.idType === 'nif' && !validNif(c.id)) out.push(`un NIF válido para ${label}`);
      if (c.web && !c.web.toLowerCase().includes('www')) out.push(`una web de ${label} que empiece por www`);
    }
  }
  return out;
}

// ---- Modelo 720 ----

/** Mayúsculas, sin acentos ni símbolos; la Ñ y la Ç se conservan (ISO-8859-1). */
export function aeatText(s: string): string {
  return [...s.toUpperCase()].map((ch) => {
    if (ch === 'Ñ' || ch === 'Ç') return ch;
    const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return /^[A-Z0-9 .,-]$/.test(base) ? base : ' ';
  }).join('').replace(/\s+/g, ' ').trim();
}
const txt = (s: string, len: number) => aeatText(s).slice(0, len).padEnd(len, ' ');
const num = (v: string | number, len: number) => {
  const s = String(v).replace(/\D/g, '');
  if (s.length > len) throw new Error(`El número ${s} no cabe en ${len} posiciones.`);
  return s.padStart(len, '0');
};
const blank = (len: number) => ' '.repeat(len);
/** Signo («N» o espacio), parte entera y dos decimales, sin coma. */
const amount = (v: Decimal, intLen: number) => {
  const [int, dec] = v.abs().toDecimalPlaces(2).toFixed(2).split('.');
  return (v.lt(0) ? 'N' : ' ') + num(int!, intLen) + dec;
};
const ymd = (date: string | null | undefined) => (date ? date.slice(0, 10).replace(/-/g, '') : '00000000');
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
/** País del emisor según el ISIN; XS, EU y similares no son países. */
const isinCountry = (id: string) => (ISIN.test(id) && !/^(X|EU)/.test(id) ? id.slice(0, 2) : null);

/** V acciones (1) y renta fija (2); I fondos y ETF, sin subclave. */
const keyOf = (klass: DisposalClass | undefined): [string, string] => (klass === 'etf' || klass === 'fund' ? ['I', '0'] : klass === 'bond' ? ['V', '2'] : ['V', '1']);

interface Row720 { broker: string; assetId: string; assetName: string; klass?: DisposalClass; quantity: string; value: Decimal; since?: string | null; origin: 'A' | 'M' | 'C'; ended?: string | null }

export function build720(f: ForeignFormReport, year: number, settings: Settings, now = new Date()): { content: Buffer; records: number } {
  const d = settings.declarant!;
  const nif = normalNif(d.nif);
  const { holdings, closures } = fileItems(f);
  const rows: Row720[] = [
    ...holdings.map((h) => ({ broker: h.broker, assetId: h.assetId, assetName: h.assetName, klass: h.class, quantity: h.quantity, value: D(h.valueEur), since: h.since, origin: h.origin ?? 'A' as const })),
    ...closures.map((c) => ({ broker: c.broker, assetId: c.assetId, assetName: c.assetName, klass: c.class, quantity: c.endQuantity ?? c.quantity, value: D(c.valueEur), since: c.since, origin: 'C' as const, ended: c.date })),
  ];
  const head = `${year}`;
  const details = rows.map((r) => {
    const deposit = custodianFor('720', r.broker, settings).country;
    const [clave, sub] = keyOf(r.klass);
    const isin = ISIN.test(r.assetId) ? r.assetId : null;
    const issuer = isinCountry(r.assetId) ?? deposit;
    const qty = D(r.quantity).toDecimalPlaces(2);
    const [qInt, qDec] = qty.toFixed(2).split('.');
    const fields = [
      '2', '720', head, nif.padStart(9, '0'), nif.padStart(9, '0'), blank(9), txt(fullName(d), 40),
      '1', blank(25), clave, sub, blank(25),
      // V: país donde están depositados. I: país de la institución de inversión colectiva.
      clave === 'I' ? issuer : deposit,
      isin ? '1' : '2', (isin ?? `Z${issuer}`).padEnd(12, ' '),
      blank(1), blank(11), blank(34),
      txt(r.assetName, 41), blank(20),
      blank(52), blank(40), blank(30), blank(30), blank(10), issuer,
      ymd(r.since ?? `${year}-01-01`), r.origin, r.origin === 'C' ? ymd(r.ended) : '00000000',
      amount(r.value, 12), amount(ZERO, 12),
      'A', num(qInt!, 10), qDec, blank(1), '100', '00', blank(20),
    ];
    return fields.join('');
  });
  const total = rows.reduce((s, r) => s.plus(r.value.toDecimalPlaces(2)), ZERO);
  // Número identificativo: «720» y un secuencial propio de 10 cifras.
  const id = `720${String(Math.floor(now.getTime() / 1000)).slice(-10).padStart(10, '0')}`;
  const header = [
    '1', '720', head, nif.padStart(9, '0'), txt(fullName(d), 40), 'T', num(d.phone, 9), txt(fullName(d), 40),
    id, blank(1), blank(1), '0'.repeat(13), num(rows.length, 9), amount(total, 15), amount(ZERO, 15), blank(320),
  ].join('');
  const lines = [header, ...details];
  for (const l of lines) if (l.length !== 500) throw new Error(`Registro de ${l.length} posiciones en vez de 500.`);
  return { content: Buffer.from(lines.map((l) => `${l}\r\n`).join(''), 'latin1'), records: rows.length };
}

// ---- Modelo 721 ----

const NS_D = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/ddii/enol/ws/Declaracion.xsd';
const NS_DI = 'https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/ddii/enol/ws/DeclaracionInformativa.xsd';
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const el = (name: string, value: string, max?: number) => `<dec1:${name}>${xml(max ? value.trim().slice(0, max) : value)}</dec1:${name}>`;
/** Sin ceros a la izquierda ni a la derecha: 0.5, 12, 1234.56. */
const plain = (v: Decimal, dp: number) => toStr(v.toDecimalPlaces(dp));
const ddmmyyyy = (date: string) => `${date.slice(8, 10)}-${date.slice(5, 7)}-${date.slice(0, 4)}`;
const BROKER_CODE: Record<string, string> = { kraken: 'KRAKEN', coinbase: 'COINBASE', trade_republic: 'TR', revolut: 'REVOLUT' };

export function build721(f: ForeignFormReport, year: number, settings: Settings): { content: string; records: number; skipped: string[] } {
  const d = settings.declarant!;
  const { holdings, closures } = fileItems(f);
  const used = new Set<string>();
  const skipped: string[] = [];
  const rows = [
    ...holdings.map((h) => ({ broker: h.broker, assetId: h.assetId, assetName: h.assetName, quantity: h.quantity, value: D(h.valueEur), source: h.priceSource, origin: h.origin ?? 'A' as const, ended: null as string | null })),
    ...closures.map((c) => ({ broker: c.broker, assetId: c.assetId, assetName: c.assetName, quantity: c.endQuantity ?? c.quantity, value: D(c.valueEur), source: c.priceSource, origin: 'C' as const, ended: c.date ?? null })),
  ];
  const details: string[] = [];
  for (const r of rows) {
    const coins = D(r.quantity).toDecimalPlaces(6);
    if (coins.lte(0)) { skipped.push(r.assetId); continue; }
    const unit = r.value.div(D(r.quantity));
    const balance = coins.times(unit.toDecimalPlaces(14)).toDecimalPlaces(2);
    const symbol = r.assetId.slice(0, 15);
    // Único en el ejercicio: la AEAT no deja reutilizarlo aunque se anule.
    const base = `${BROKER_CODE[r.broker] ?? r.broker.toUpperCase()}-${symbol}`.slice(0, 20);
    let id = base;
    for (let i = 2; used.has(id); i++) id = `${base.slice(0, 20 - String(i).length - 1)}-${i}`;
    used.add(id);
    const c = custodianFor('721', r.broker, settings);
    const ident = c.idType === 'nif'
      ? el('NIF', normalNif(c.id))
      : `<dec1:IDOtro>${c.idType === '02' ? '' : el('CodigoPais', c.country)}${el('IDType', c.idType)}${el('ID', c.id, 20)}</dec1:IDOtro>`;
    details.push([
      '<dec1:RegistroDeDetalle>',
      el('IDRegistroDetalle', id),
      '<dec1:RegistroDetalle>',
      el('Clave', 'T'),
      '<dec1:IDPersonaEntidadSalvaguarda>',
      el('NombreRazon', c.name, 120),
      ident,
      `<dec1:DomicilioEntidadSalvaguarda>${el('CodigoPais', c.country)}</dec1:DomicilioEntidadSalvaguarda>`,
      c.web.trim() ? el('DireccionSitioWebEntidadSalvaguarda', c.web, 50) : '',
      '</dec1:IDPersonaEntidadSalvaguarda>',
      `<dec1:TipoMonedaVirtual>${el('DenominacionMonedaVirtual', r.assetName || r.assetId, 50)}${el('SiglasMonedaVirtual', symbol)}</dec1:TipoMonedaVirtual>`,
      el('NumMonedas', plain(coins, 6)),
      el('ValorMonedas', plain(unit, 14)),
      el('OrigenValorMonedas', r.source || 'COSTE DE ADQUISICION', 50),
      r.origin === 'C' && r.ended ? el('FechaFinCondicion', ddmmyyyy(r.ended)) : '',
      el('SaldoMonedasVirtuales', plain(balance, 2)),
      el('OrigenMonedaVirtual', r.origin),
      '</dec1:RegistroDetalle>',
      '</dec1:RegistroDeDetalle>',
    ].filter(Boolean).join(''));
  }
  const content = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:dec="${NS_D}" xmlns:dec1="${NS_DI}">`,
    '<soapenv:Header/>',
    '<soapenv:Body>',
    '<dec:Declaracion>',
    '<dec1:Cabecera>',
    el('TipoComunicacion', 'A0'), el('Modelo', '721'), el('Ejercicio', String(year)), el('IDVersionModelo', '1.0'),
    '<dec1:IDDeclarante>',
    el('NIF', normalNif(d.nif)), el('NombreRazon', fullName(d), 120),
    `<dec1:PersonaContacto>${el('Telefono', d.phone)}${el('ApellidosNombre', fullName(d), 120)}</dec1:PersonaContacto>`,
    '</dec1:IDDeclarante>',
    '</dec1:Cabecera>',
    ...details,
    '</dec:Declaracion>',
    '</soapenv:Body>',
    '</soapenv:Envelope>',
    '',
  ].join('\n');
  return { content, records: details.length, skipped };
}
