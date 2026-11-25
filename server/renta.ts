import { D, Decimal, ZERO } from '../shared/decimal.ts';
import { REGIONS, type EngineResult, type Settings } from '../shared/types.ts';
import { validNif, normalNif } from './aeat.ts';
import type { FormEntry, YearReport } from './engine/report.ts';

/**
 * XML parcial del modelo 100 para «Presentación mediante fichero» → «Importar XML» (esquema Renta2025.xsd).
 * Solo lleva tus datos identificativos y las rentas de las inversiones. No se une al borrador:
 * lo demás se completa en la declaración importada. Los tres resultados obligatorios van a cero
 * para que los calcule Renta Web.
 */
export const RENTA_XML_YEAR = 2025;

/** Lo que falta para generar el XML. */
export function rentaMissing(rep: YearReport, settings: Settings): string[] {
  if (rep.year !== RENTA_XML_YEAR) return [`el diseño de la Renta ${rep.year}: por ahora solo está el de ${RENTA_XML_YEAR}`];
  const out: string[] = [];
  if (rep.issues.some((i) => i.severity === 'error')) out.push('resolver lo pendiente en Revisar');
  const d = settings.declarant;
  if (!d || !validNif(d.nif)) out.push('tu NIF');
  if (!d?.surnames?.trim() || !d.firstName?.trim()) out.push('tus apellidos y nombre');
  if (!d?.birthDate) out.push('tu fecha de nacimiento');
  if (!d?.sex) out.push('tu sexo');
  if (!d?.civilStatus) out.push('tu estado civil');
  if (!d?.region || !REGIONS[d.region]) out.push('tu comunidad autónoma');
  return out;
}

const UPPER_ACCENTS = 'ÁÉÍÓÚÀÈÌÒÙÄËÏÖÜÂÊÎÔÛÑÇ';
/** Mayúsculas y solo los caracteres que admite cada campo del esquema. */
function clean(s: string, max: number, extra = ''): string {
  const allowed = new RegExp(`^[0-9A-Z${UPPER_ACCENTS}·.&"\\-,'/:;_() ${extra}]$`);
  const out = [...s.toUpperCase()].map((ch) => (allowed.test(ch) ? ch : ' ')).join('').replace(/\s+/g, ' ').trim();
  return out.slice(0, max).trim();
}
const nameText = (s: string) => [...s.toUpperCase()].map((ch) => (new RegExp(`^[A-Z${UPPER_ACCENTS}ªÃÕ·.\\-_:,'() ]$`).test(ch) ? ch : ' ')).join('').replace(/\s+/g, ' ').trim();
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v: Decimal | string) => D(v).toDecimalPlaces(2).toFixed(2);
const tag = (name: string, value: string | Decimal) => `<${name}>${typeof value === 'string' ? xml(value) : money(value)}</${name}>`;
const nz = (v: string | Decimal) => !D(v).isZero();
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;
const label = (e: FormEntry, max: number, extra = '') => clean(e.name, max, extra) || clean(e.assetId, max, extra) || 'SIN NOMBRE';

function shares(entries: FormEntry[]): string {
  return `<GPAcciones>${entries.map((e) => [
    '<EntidadAccion>',
    tag('G2B_DE', label(e, 20)),
    `<G2B_A valor="${money(e.transmission)}">${tag('ENTIDAD', label(e, 20))}<TRANSACCION>${tag('IT', D(e.transmission))}${tag('IA', D(e.acquisition))}${e.deferred ? tag('VTX', '1') : ''}</TRANSACCION></G2B_A>`,
    tag('G2B_B', D(e.acquisition)),
    nz(e.gain) ? tag('G2B_C', D(e.gain)) + tag('G2B_D', D(e.gain)) : '',
    nz(e.lossObtained) ? tag('G2B_E', D(e.lossObtained)) + tag('G2B_F', D(e.lossComputable)) : '',
    '</EntidadAccion>',
  ].join('')).join('')}</GPAcciones>`;
}

function funds(entries: FormEntry[]): string {
  return `<GPFondosCoti>${entries.map((e) => [
    '<Fondo>',
    tag('FONDOCO', label(e, 40, 'ºªÃÕ@+')),
    ISIN.test(e.assetId) ? tag('ISINCO', e.assetId) : '',
    tag('VTFC1', D(e.transmission)), tag('VADFC1', D(e.acquisition)),
    e.deferred ? tag('VTFCX1', '1') : '',
    tag('G2AFCDE', label(e, 40, 'ºªÃÕ@+')),
    tag('G2FCVTTF', D(e.transmission)), tag('G2FCVATF', D(e.acquisition)),
    nz(e.gain) ? tag('G2FCGANF', D(e.gain)) + tag('G2AFCR0', D(e.gain)) : '',
    nz(e.lossObtained) ? tag('G2FCPERF', D(e.lossObtained)) + tag('G2AFCR1', D(e.lossComputable)) : '',
    '</Fondo>',
  ].join('')).join('')}</GPFondosCoti>`;
}

function crypto(entries: FormEntry[]): string {
  return `<GPOtrosCriptomonedas>${entries.map((e) => {
    const clave = e.clave === 'N' ? 'N' : 'F';
    return [
      '<ElementoCriptomoneda>',
      tag('G2CRIDEN', label(e, 25, 'ºª')), tag('G2DCRIB', clave),
      `<G2DCRIE valor="${money(e.transmission)}">${tag('MONEDA', label(e, 30, 'ºª'))}${tag('CLAVECRI', clave)}<VTCRI>${tag('IMP1VTCRI', D(e.transmission))}</VTCRI><VACRI>${tag('IMP1VACRI', D(e.acquisition))}</VACRI></G2DCRIE>`,
      tag('G2DCRIF', D(e.acquisition)),
      nz(e.lossObtained) ? tag('G2DCRIG', D(e.lossObtained)) + tag('G2DCRIH', D(e.lossComputable)) : '',
      nz(e.gain) ? tag('G2DCRII', D(e.gain)) + tag('G2CRINDEX', D(e.gain)) + tag('G2DCRIP', D(e.gain)) : '',
      '</ElementoCriptomoneda>',
    ].join('');
  }).join('')}</GPOtrosCriptomonedas>`;
}

/** Divisas y otros valores: «otros elementos patrimoniales», clave 4. */
function others(entries: FormEntry[]): string {
  return `<GPOtrosElementos>${entries.map((e) => [
    '<ElementoPatrimonial>',
    e.deferred ? tag('V01TX2NA', '1') : '',
    tag('G2DB', '4'), tag('F2ONEROSA', '1'),
    tag('G2DE', D(e.transmission)), tag('G2DF', D(e.acquisition)),
    nz(e.lossObtained) ? tag('G2DG', D(e.lossObtained)) + tag('G2DH', D(e.lossComputable)) : '',
    nz(e.gain) ? tag('G2DI', D(e.gain)) + tag('G2NDEX', D(e.gain)) + tag('G2DO', D(e.gain)) + tag('G2DP', D(e.gain)) : '',
    '</ElementoPatrimonial>',
  ].join('')).join('')}</GPOtrosElementos>`;
}

/** Capital mobiliario: cada bloque con su detalle de ingresos, retenciones españolas y gastos, como lo guarda Renta Web. */
function capital(rep: YearReport, res: EngineResult): string {
  const incomes = res.incomes.filter((i) => i.year === rep.year);
  const withheld = (types: string[]) => incomes.filter((i) => types.includes(i.type)).reduce((s, i) => s.plus(D(i.spanishTaxEur)), ZERO);
  const interest = D(rep.rcm.interest).plus(D(rep.rcm.staking));
  const dividends = D(rep.rcm.dividends).plus(D(rep.rcm.capitalExcess));
  const bonds = D(rep.rcm.bonds);
  const custody = D(rep.rcm.custody);
  if (interest.isZero() && dividends.isZero() && bonds.isZero() && custody.isZero()) return '';
  // Los gastos de administración y depósito van con los dividendos o, si no hay, con los intereses.
  const custodyIn = !dividends.isZero() || (interest.isZero() && bonds.isZero()) ? 'B13' : !interest.isZero() ? 'B11' : 'B15';
  const block = (name: 'B11' | 'B13' | 'B15', gross: Decimal, ret: Decimal) => {
    const fees = custodyIn === name ? custody : ZERO;
    if (gross.isZero() && fees.isZero()) return '';
    return `<${name} valor="${money(gross)}"><Registro${name}>${tag(`IMP1D${name}`, gross)}${nz(ret) ? tag(`IMP2D${name}`, ret) : ''}${nz(fees) ? tag(`IMP3D${name}`, fees) : ''}</Registro${name}></${name}>`;
  };
  const total = interest.plus(dividends).plus(bonds);
  return [
    '<RdtoCapitalMobiliario><RdtoCapitalMobiliarioAhorro>',
    block('B11', interest, withheld(['interest', 'staking'])),
    block('B13', dividends, withheld(['dividend', 'capital_excess'])),
    block('B15', bonds, withheld(['bond'])),
    tag('B1II', total), nz(custody) ? tag('B1GD', custody) : '', tag('B1RN', total.minus(custody)), tag('B1RNR', total.minus(custody)),
    '</RdtoCapitalMobiliarioAhorro></RdtoCapitalMobiliario>',
  ].join('');
}

const ddmmyyyy = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}/${date.slice(0, 4)}`;

/** Apartados de las inversiones, lo que incluyen y lo que habrá que completar a mano. */
export function rentaBody(rep: YearReport, res: EngineResult): { toma: string; parts: string[]; notes: { title: string; detail: string }[] } {
  const section = (id: string) => rep.sections.find((s) => s.id === id)?.entries ?? [];
  const parts: string[] = [];
  const notes: { title: string; detail: string }[] = [];
  const add = (label: string, body: string) => { if (body) parts.push(label); return body; };

  const stock = section('stock'), etf = section('etf'), coins = section('crypto');
  const rest = [...section('fx'), ...section('other')];
  if (stock.length > 200 || etf.length > 200 || coins.length > 300 || rest.length > 80) throw new Error('Hay más entradas de las que admite Renta Web en un apartado.');
  if (section('fx').length) notes.push({ title: 'Fechas de las divisas', detail: 'Renta Web pide la fecha de transmisión y la de adquisición de cada divisa (casillas 1631 y 1632). Están en el Excel, en «Transmisiones FIFO».' });
  const prior = rep.sections.find((s) => s.id === 'prior_losses');
  const foreign = rep.doubleTax.reduce((s, x) => ({ gross: s.gross.plus(D(x.gross)), tax: s.tax.plus(D(x.deductible)) }), { gross: ZERO, tax: ZERO });

  const toma = [
    add('Capital mobiliario', capital(rep, res)),
    add('Regalos y airdrops (0304)', D(rep.rewards).gt(0) ? `<GPPremios><Otras>${tag('G13', D(rep.rewards))}</Otras></GPPremios>` : ''),
    add('ETF', etf.length ? funds(etf) : ''),
    add('Acciones', stock.length ? shares(stock) : ''),
    add('Criptomonedas', coins.length ? crypto(coins) : ''),
    add('Divisas y otros elementos', rest.length ? others(rest) : ''),
    add('Pérdidas de otros años (0395)', prior && nz(prior.lossComputableTotal) ? `<GPOtrasGananciasEjerAnt><GPImpPerAnt>${tag('G2D_B1', D(prior.lossComputableTotal))}</GPImpPerAnt></GPOtrasGananciasEjerAnt>` : ''),
    add('Doble imposición internacional', foreign.tax.gt(0)
      ? `<CalculoImpuesto><CuotaAutoliquidacion><DOBIMPINT><VRBE1>${tag('RDTAHVRBE1', foreign.gross)}${tag('IEXAHVRBE1', foreign.tax)}</VRBE1></DOBIMPINT></CuotaAutoliquidacion></CalculoImpuesto>` : ''),
  ].join('');
  return { toma, parts, notes };
}

export function buildRentaXml(rep: YearReport, res: EngineResult, settings: Settings): Buffer {
  const d = settings.declarant!;
  const nif = normalNif(d.nif);
  const { toma } = rentaBody(rep, res);
  const content = [
    '<?xml version="1.0" encoding="ISO-8859-1"?>',
    `<Declaracion modelo="100" ejercicio="${rep.year}" periodo="0A" versionxsd="1.02">`,
    `<Aux>${tag('Idioma', 'E')}${tag('VERSION', '1.0')}</Aux>`,
    '<DatosIdentificativos><Declarante>',
    tag('DPNIF_D', nif), tag('DP_APENOM_D', `${nameText(d.surnames)}, ${nameText(d.firstName)}`.slice(0, 80)),
    tag('ECIVIL', d.civilStatus ?? ''), tag('DPFNAC_D', ddmmyyyy(d.birthDate ?? '')), tag('SEXO_D', d.sex ?? ''),
    '</Declarante></DatosIdentificativos>',
    `<DatosEconomicos codigoCADeclaracion="${d.region}" TIPOTRIBUTACION="1">`,
    `<TomaDatosAmpliada titular="2" nif="${nif}">${toma}</TomaDatosAmpliada>`,
    '<Resultados><BaseLiquidableRes><BLGGRAV>0.00</BLGGRAV></BaseLiquidableRes><CalculoImpuestoRes><CuotaDiferencialRes><CDIF>0.00</CDIF></CuotaDiferencialRes><RESULTADO>0.00</RESULTADO></CalculoImpuestoRes></Resultados>',
    '</DatosEconomicos>',
    '</Declaracion>',
    '',
  ].join('\n');
  return Buffer.from(content, 'latin1');
}
