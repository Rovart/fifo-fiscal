import { writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Operation } from '../shared/types.ts';
import { aeatText, validNif } from '../server/aeat.ts';
import { buildRentaXml } from '../server/renta.ts';
import type { YearReport } from '../server/engine/report.ts';
import { DEFAULT_SETTINGS, type EngineResult } from '../shared/types.ts';

process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const { app } = await import('../server/app.ts');

beforeAll(() => db.seedRatesIfEmpty());

const request = (path: string, profile: string, method = 'GET', body?: unknown) => app.request(`http://127.0.0.1${path}`, {
  method, headers: { Host: '127.0.0.1', 'X-Fifo-Profile': profile, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
/** Posiciones 1-indexadas e inclusivas, como en el diseño de registro. */
const at = (line: string, from: number, to: number) => line.slice(from - 1, to);
const trade = (p: Partial<Operation> & { kind: 'buy' | 'sell'; date: string; quantity: string; price: string }) => {
  const total = (Number(p.quantity) * Number(p.price)).toFixed(2);
  const { date, price, ...rest } = p;
  svc.createOp({ datetime: `${date}T12:00:00`, unitPrice: price, currency: 'EUR', fxRate: '1', grossLocal: total, grossEur: total, totalEur: total, ...rest });
};
const DECLARANT = { nif: '12345678z', surnames: 'Pérez Núñez', firstName: 'María José', phone: '600111222' };

describe('Datos del declarante', () => {
  it('comprueba la letra del DNI y del NIE', () => {
    expect(validNif('12345678Z')).toBe(true);
    expect(validNif('12345678-z')).toBe(true);
    expect(validNif('12345678A')).toBe(false);
    expect(validNif('X1234567L')).toBe(true);
    expect(validNif('X1234567A')).toBe(false);
  });

  it('escribe en mayúsculas sin acentos ni símbolos y conserva la Ñ', () => {
    expect(aeatText('Pérez Núñez, María & Cía.')).toBe('PEREZ NUÑEZ, MARIA CIA.');
  });
});

describe('Fichero del modelo 720', () => {
  it('sigue el diseño de registro de 500 posiciones', async () => {
    const profile = db.createProfile('Fichero 720');
    db.withProfile(profile.id, () => {
      trade({ kind: 'buy', date: '2021-05-10', quantity: '100', price: '300', broker: 'degiro', assetId: 'US0378331005', assetName: 'Apple Inc.', assetClass: 'stock' });
      trade({ kind: 'buy', date: '2022-02-01', quantity: '50', price: '310', broker: 'degiro', assetId: 'US0378331005', assetName: 'Apple Inc.', assetClass: 'stock' });
      trade({ kind: 'buy', date: '2023-03-15', quantity: '200.5', price: '80', broker: 'trade_republic', assetId: 'IE00B4L5Y983', assetName: 'iShares Core MSCI World', assetClass: 'etf' });
      const price = db.db.prepare('INSERT INTO price_history (asset_id, month, price_eur) VALUES (?, ?, ?)');
      price.run('US0378331005', '2024-12', '240.5');
      price.run('IE00B4L5Y983', '2024-12', '100');
    });

    const missing = await request('/api/aeat/720/2024', profile.id);
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toContain('tu NIF');
    expect((await request('/api/settings', profile.id, 'PUT', { declarant: { ...DECLARANT, nif: '12345678A' } })).status).toBe(422);
    expect((await request('/api/settings', profile.id, 'PUT', { declarant: DECLARANT })).ok).toBe(true);

    const res = await request('/api/aeat/720/2024', profile.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('iso-8859-1');
    const text = Buffer.from(await res.arrayBuffer()).toString('latin1');
    const lines = text.split('\r\n').filter(Boolean);
    expect(lines.map((l) => l.length)).toEqual([500, 500, 500]);

    const [head, apple, etf] = lines as [string, string, string];
    expect(at(head, 1, 8)).toBe('17202024');
    expect(at(head, 9, 17)).toBe('12345678Z');
    expect(at(head, 18, 57).trimEnd()).toBe('PEREZ NUÑEZ MARIA JOSE');
    expect(at(head, 58, 67)).toBe('T600111222');
    expect(at(head, 108, 110)).toBe('720');
    expect(at(head, 121, 135)).toBe(`  ${'0'.repeat(13)}`);
    expect(at(head, 136, 144)).toBe('000000002');
    // 150 × 240,50 + 200,5 × 100 = 56.125,00
    expect(at(head, 145, 162)).toBe(` ${'5612500'.padStart(17, '0')}`);
    expect(at(head, 181, 500).trim()).toBe('');

    expect(at(apple, 1, 8)).toBe('27202024');
    expect(at(apple, 18, 26)).toBe('12345678Z');
    expect(at(apple, 76, 76)).toBe('1');
    expect(at(apple, 102, 103)).toBe('V1');
    expect(at(apple, 129, 143)).toBe('NL1US0378331005');
    expect(at(apple, 190, 230).trimEnd()).toBe('APPLE INC.');
    expect(at(apple, 413, 414)).toBe('US');
    expect(at(apple, 415, 431)).toBe('20210510A00000000');
    expect(at(apple, 432, 446)).toBe(` ${'3607500'.padStart(14, '0')}`);
    expect(at(apple, 462, 474)).toBe('A000000015000');
    expect(at(apple, 476, 480)).toBe('10000');

    // Un ETF es una institución de inversión colectiva: clave I y país del fondo.
    expect(at(etf, 102, 103)).toBe('I0');
    expect(at(etf, 129, 130)).toBe('IE');
    expect(at(etf, 415, 423)).toBe('20230315A');
    expect(at(etf, 463, 474)).toBe('000000020050');
  });
});

describe('Mensaje del modelo 721', () => {
  it('pide los datos de cada exchange y marca como cerrado lo ya declarado que sale', async () => {
    const profile = db.createProfile('Fichero 721');
    db.withProfile(profile.id, () => {
      const crypto = { broker: 'kraken' as const, assetClass: 'crypto' as const };
      trade({ kind: 'buy', date: '2023-03-01', quantity: '2', price: '30000', assetId: 'BTC', assetName: 'Bitcoin', ...crypto });
      trade({ kind: 'buy', date: '2023-03-01', quantity: '10', price: '2000', assetId: 'ETH', assetName: 'Ethereum', ...crypto });
      trade({ kind: 'buy', date: '2024-01-10', quantity: '1', price: '40000', assetId: 'BTC', assetName: 'Bitcoin', broker: 'coinbase', assetClass: 'crypto' });
      trade({ kind: 'sell', date: '2024-03-01', quantity: '10', price: '3000', assetId: 'ETH', assetName: 'Ethereum', ...crypto });
      const price = db.db.prepare('INSERT INTO price_history (asset_id, month, price_eur) VALUES (?, ?, ?)');
      price.run('BTC', '2023-12', '40000');
      price.run('ETH', '2023-12', '2100');
      price.run('BTC', '2024-12', '90000');
    });
    await request('/api/settings', profile.id, 'PUT', { declarant: DECLARANT, foreignFilings: [{ form: '721', year: 2023, valueEur: '101000' }] });

    const missing = await request('/api/aeat/721/2024', profile.id);
    expect(missing.status).toBe(422);
    expect((await missing.json()).error).toContain('número de identificación de Kraken');
    expect((await request('/api/settings', profile.id, 'PUT', { custodians: { '721|kraken': { country: 'Irlanda' } } })).status).toBe(422);
    await request('/api/settings', profile.id, 'PUT', { custodians: { '721|kraken': { idType: '02', id: 'IE1234567X' } } });

    const res = await request('/api/aeat/721/2024', profile.id);
    expect(res.status).toBe(200);
    const xml = await res.text();
    // Para validarlo contra el esquema de la AEAT fuera de las pruebas.
    if (process.env.AEAT_721_OUT) writeFileSync(process.env.AEAT_721_OUT, xml);
    const records = xml.split('<dec1:RegistroDeDetalle>').slice(1);
    expect(records).toHaveLength(3);
    expect(xml).toContain('<dec1:Ejercicio>2024</dec1:Ejercicio>');
    expect(xml).toContain('<dec1:NIF>12345678Z</dec1:NIF>\n<dec1:NombreRazon>Pérez Núñez María José</dec1:NombreRazon>');

    const [krakenBtc, coinbaseBtc, eth] = records as [string, string, string];
    // Ya declarado en 2023 y sigue en Kraken: M. Nuevo en Coinbase: A.
    expect(krakenBtc).toContain('<dec1:IDRegistroDetalle>KRAKEN-BTC</dec1:IDRegistroDetalle>');
    expect(krakenBtc).toContain('<dec1:NombreRazon>Payward Europe Solutions Limited</dec1:NombreRazon><dec1:IDOtro><dec1:IDType>02</dec1:IDType><dec1:ID>IE1234567X</dec1:ID></dec1:IDOtro>');
    expect(krakenBtc).toContain('<dec1:NumMonedas>2</dec1:NumMonedas><dec1:ValorMonedas>90000</dec1:ValorMonedas><dec1:OrigenValorMonedas>KRAKEN</dec1:OrigenValorMonedas><dec1:SaldoMonedasVirtuales>180000</dec1:SaldoMonedasVirtuales><dec1:OrigenMonedaVirtual>M</dec1:OrigenMonedaVirtual>');
    expect(coinbaseBtc).toContain('<dec1:IDRegistroDetalle>COINBASE-BTC</dec1:IDRegistroDetalle>');
    expect(coinbaseBtc).toContain('<dec1:IDOtro><dec1:CodigoPais>LU</dec1:CodigoPais><dec1:IDType>04</dec1:IDType><dec1:ID>B292147</dec1:ID></dec1:IDOtro>');
    expect(coinbaseBtc).toContain('<dec1:OrigenMonedaVirtual>A</dec1:OrigenMonedaVirtual>');
    // Vendido en 2024: lo que había antes de venderlo, al precio de la venta y con la fecha de fin.
    expect(eth).toContain('<dec1:NumMonedas>10</dec1:NumMonedas><dec1:ValorMonedas>3000</dec1:ValorMonedas><dec1:OrigenValorMonedas>KRAKEN</dec1:OrigenValorMonedas><dec1:FechaFinCondicion>01-03-2024</dec1:FechaFinCondicion><dec1:SaldoMonedasVirtuales>30000</dec1:SaldoMonedasVirtuales><dec1:OrigenMonedaVirtual>C</dec1:OrigenMonedaVirtual>');
  });

  it('si solo obliga un cierre, el fichero lleva solo el cierre', async () => {
    const profile = db.createProfile('Solo cierre 721');
    db.withProfile(profile.id, () => {
      const crypto = { broker: 'kraken' as const, assetClass: 'crypto' as const };
      trade({ kind: 'buy', date: '2023-03-01', quantity: '2', price: '30000', assetId: 'BTC', assetName: 'Bitcoin', ...crypto });
      trade({ kind: 'buy', date: '2023-03-01', quantity: '10', price: '2000', assetId: 'ETH', assetName: 'Ethereum', ...crypto });
      trade({ kind: 'sell', date: '2024-03-01', quantity: '10', price: '3000', assetId: 'ETH', assetName: 'Ethereum', ...crypto });
      const price = db.db.prepare('INSERT INTO price_history (asset_id, month, price_eur) VALUES (?, ?, ?)');
      price.run('BTC', '2023-12', '40000');
      price.run('ETH', '2023-12', '2100');
      price.run('BTC', '2024-12', '41000');
    });
    await request('/api/settings', profile.id, 'PUT', {
      declarant: DECLARANT, foreignFilings: [{ form: '721', year: 2023, valueEur: '101000' }], custodians: { '721|kraken': { idType: '02', id: 'IE1234567X' } },
    });
    const form = ((await (await request('/api/foreign/2024', profile.id)).json()).forms as { form: string }[]).find((f) => f.form === '721');
    expect(form).toMatchObject({ reasons: ['closures'], onlyClosures: true, missing: [] });
    const xml = await (await request('/api/aeat/721/2024', profile.id)).text();
    expect(xml.split('<dec1:RegistroDeDetalle>')).toHaveLength(2);
    expect(xml).toContain('<dec1:SiglasMonedaVirtual>ETH</dec1:SiglasMonedaVirtual>');
  });

  it('no genera ficheros de un año sin terminar', async () => {
    const profile = db.createProfile('Año en curso');
    await request('/api/settings', profile.id, 'PUT', { declarant: DECLARANT });
    const year = Number(svc.today().slice(0, 4));
    const res = await request(`/api/aeat/720/${year}`, profile.id);
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('que termine el año');
  });
});

describe('XML parcial de Renta', () => {
  it('lleva las inversiones con el esquema de Renta 2025 y pide los datos personales que exige', async () => {
    const profile = db.createProfile('Renta XML');
    db.withProfile(profile.id, () => {
      const apple = { broker: 'degiro' as const, assetId: 'US0378331005', assetName: 'Apple Inc.', assetClass: 'stock' as const };
      trade({ kind: 'buy', date: '2024-01-10', quantity: '10', price: '100', ...apple });
      trade({ kind: 'sell', date: '2025-03-10', quantity: '10', price: '150', ...apple });
      svc.createOp({ kind: 'dividend', datetime: '2025-05-01T12:00:00', ...apple, currency: 'EUR', fxRate: '1', grossLocal: '100', grossEur: '100', withholdingEur: '15', totalEur: '85' });
      const etf = { broker: 'trade_republic' as const, assetId: 'IE00B4L5Y983', assetName: 'iShares Core MSCI World', assetClass: 'etf' as const };
      trade({ kind: 'buy', date: '2024-02-01', quantity: '10', price: '100', ...etf });
      trade({ kind: 'sell', date: '2025-04-01', quantity: '10', price: '90', ...etf });
      const btc = { broker: 'kraken' as const, assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' as const };
      trade({ kind: 'buy', date: '2024-03-01', quantity: '0.5', price: '40000', ...btc });
      trade({ kind: 'sell', date: '2025-06-01', quantity: '0.5', price: '60000', ...btc });
    });

    const check = await (await request('/api/aeat/100/2025/check', profile.id)).json();
    expect(check.parts).toEqual(['Capital mobiliario', 'ETF', 'Acciones', 'Criptomonedas', 'Doble imposición internacional']);
    expect(check.missing).toEqual(['tu NIF', 'tus apellidos y nombre', 'tu fecha de nacimiento', 'tu sexo', 'tu estado civil', 'tu comunidad autónoma']);
    expect((await request('/api/aeat/100/2025', profile.id)).status).toBe(422);
    expect((await request('/api/settings', profile.id, 'PUT', { declarant: { ...DECLARANT, phone: '', birthDate: '1985-02-30' } })).status).toBe(422);
    const saved = await request('/api/settings', profile.id, 'PUT', { declarant: { ...DECLARANT, phone: '', birthDate: '1985-02-07', sex: 'M', civilStatus: '2', region: '12' } });
    expect(saved.ok).toBe(true);
    // Sin teléfono vale para la Renta, no para el 720.
    expect((await (await request('/api/aeat/100/2025/check', profile.id)).json()).missing).toEqual([]);

    const res = await request('/api/aeat/100/2025', profile.id);
    expect(res.status).toBe(200);
    const raw = Buffer.from(await res.arrayBuffer()).toString('latin1');
    if (process.env.RENTA_XML_OUT) writeFileSync(process.env.RENTA_XML_OUT, Buffer.from(raw, 'latin1'));
    const xml = raw.replace(/\n/g, '');
    expect(xml).toContain('<Declaracion modelo="100" ejercicio="2025" periodo="0A" versionxsd="1.02">');
    expect(xml).toContain('<DPNIF_D>12345678Z</DPNIF_D><DP_APENOM_D>PÉREZ NÚÑEZ, MARÍA JOSÉ</DP_APENOM_D><ECIVIL>2</ECIVIL><DPFNAC_D>07/02/1985</DPFNAC_D><SEXO_D>M</SEXO_D>');
    expect(xml).toContain('<DatosEconomicos codigoCADeclaracion="12" TIPOTRIBUTACION="1">');
    expect(xml).toContain('<TomaDatosAmpliada titular="2" nif="12345678Z">');
    expect(xml).toContain('<B13 valor="100.00"><RegistroB13><IMP1DB13>100.00</IMP1DB13></RegistroB13></B13><B1II>100.00</B1II><B1RN>100.00</B1RN><B1RNR>100.00</B1RNR>');
    expect(xml).toContain('<EntidadAccion><G2B_DE>APPLE INC.</G2B_DE><G2B_A valor="1500.00"><ENTIDAD>APPLE INC.</ENTIDAD><TRANSACCION><IT>1500.00</IT><IA>1000.00</IA></TRANSACCION></G2B_A><G2B_B>1000.00</G2B_B><G2B_C>500.00</G2B_C><G2B_D>500.00</G2B_D></EntidadAccion>');
    expect(xml).toContain('<ISINCO>IE00B4L5Y983</ISINCO><VTFC1>900.00</VTFC1><VADFC1>1000.00</VADFC1>');
    expect(xml).toContain('<G2FCPERF>100.00</G2FCPERF><G2AFCR1>100.00</G2AFCR1>');
    expect(xml).toContain('<G2CRIDEN>BITCOIN</G2CRIDEN><G2DCRIB>F</G2DCRIB><G2DCRIE valor="30000.00">');
    expect(xml).toContain('<G2DCRIF>20000.00</G2DCRIF><G2DCRII>10000.00</G2DCRII>');
    expect(xml).toContain('<DOBIMPINT><VRBE1><RDTAHVRBE1>100.00</RDTAHVRBE1><IEXAHVRBE1>15.00</IEXAHVRBE1></VRBE1></DOBIMPINT>');
  });

  it('solo existe el diseño de Renta 2025', async () => {
    const profile = db.createProfile('Renta otro año');
    db.withProfile(profile.id, () => {
      trade({ kind: 'buy', date: '2023-01-10', quantity: '1', price: '100', broker: 'degiro', assetId: 'US0378331005', assetName: 'Apple', assetClass: 'stock' });
      trade({ kind: 'sell', date: '2024-03-10', quantity: '1', price: '150', broker: 'degiro', assetId: 'US0378331005', assetName: 'Apple', assetClass: 'stock' });
    });
    const check = await (await request('/api/aeat/100/2024/check', profile.id)).json();
    expect(check.missing).toEqual(['el diseño de la Renta 2024: por ahora solo está el de 2025']);
  });
});

describe('XML de Renta: todos los apartados', () => {
  it('pone cada importe en su elemento, con las pérdidas aplazadas marcadas', () => {
    const entry = (name: string, assetId: string, t: string, a: string, extra: Record<string, unknown> = {}) => {
      const net = Number(t) - Number(a);
      return { name, assetId, transmission: t, acquisition: a, gain: net > 0 ? net.toFixed(2) : '0.00', lossObtained: net < 0 ? (-net).toFixed(2) : '0.00', lossComputable: net < 0 ? (-net).toFixed(2) : '0.00', ...extra };
    };
    const rep = {
      year: 2025, issues: [], rewards: '12.50',
      rcm: { interest: '40.00', staking: '10.00', dividends: '200.00', capitalExcess: '0.00', bonds: '-5.00', custody: '3.00', grossTotal: '245.00', net: '242.00', spanishTax: '9.50', foreignTax: '30.00', nonDeductibleFees: '0' },
      doubleTax: [{ country: 'US', gross: '200.00', withheld: '30.00', treatyRate: '15', deductible: '30.00', excess: '0.00' }],
      sections: [
        { id: 'stock', entries: [entry('Señor & Cía S.A.', 'ES0000000001', '800.00', '1000.00'), entry('Señor & Cía S.A.', 'ES0000000001', '90.00', '100.00', { lossComputable: '0.00', deferred: true })] },
        { id: 'etf', entries: [entry('Vanguard FTSE All-World (USD) Accumulating', 'IE00BK5BQT80', '900.00', '1000.00', { lossComputable: '0.00', deferred: true })] },
        { id: 'crypto', entries: [entry('Ethereum', 'ETH', '3000.00', '2000.00', { clave: 'N' })] },
        { id: 'fx', entries: [entry('USD', 'FX:USD', '110.00', '100.00')] },
        { id: 'other', entries: [entry('Producto raro', 'XX', '50.00', '80.00')] },
        { id: 'prior_losses', entries: [], lossComputableTotal: '250.00' },
      ],
    } as unknown as YearReport;
    const res = { incomes: [
      { year: 2025, type: 'interest', spanishTaxEur: '9.50' }, { year: 2025, type: 'dividend', spanishTaxEur: '0' }, { year: 2024, type: 'interest', spanishTaxEur: '99' },
    ] } as unknown as EngineResult;
    const declarant = { nif: '12345678Z', surnames: 'Ibáñez', firstName: 'Ana', phone: '', birthDate: '1990-12-31', sex: 'M' as const, civilStatus: '1' as const, region: '09' };
    const raw = buildRentaXml(rep, res, { ...DEFAULT_SETTINGS, declarant }).toString('latin1');
    if (process.env.RENTA_XML_FULL_OUT) writeFileSync(process.env.RENTA_XML_FULL_OUT, Buffer.from(raw, 'latin1'));
    const xml = raw.replace(/\n/g, '');
    expect(xml).toContain('<B11 valor="50.00"><RegistroB11><IMP1DB11>50.00</IMP1DB11><IMP2DB11>9.50</IMP2DB11></RegistroB11></B11>');
    expect(xml).toContain('<B13 valor="200.00"><RegistroB13><IMP1DB13>200.00</IMP1DB13><IMP3DB13>3.00</IMP3DB13></RegistroB13></B13>');
    expect(xml).toContain('<B15 valor="-5.00"><RegistroB15><IMP1DB15>-5.00</IMP1DB15></RegistroB15></B15><B1II>245.00</B1II><B1GD>3.00</B1GD><B1RN>242.00</B1RN>');
    expect(xml).toContain('<GPPremios><Otras><G13>12.50</G13></Otras></GPPremios>');
    // Símbolos que el esquema no admite se quitan; la denominación de acciones tiene 20 caracteres.
    expect(xml).toContain('<G2B_DE>SEÑOR & CÍA S.A.</G2B_DE>'.replace('&', '&amp;'));
    expect(xml).toContain('<TRANSACCION><IT>90.00</IT><IA>100.00</IA><VTX>1</VTX></TRANSACCION></G2B_A><G2B_B>100.00</G2B_B><G2B_E>10.00</G2B_E><G2B_F>0.00</G2B_F>');
    expect(xml).toContain('<FONDOCO>VANGUARD FTSE ALL-WORLD (USD) ACCUMULATI</FONDOCO><ISINCO>IE00BK5BQT80</ISINCO><VTFC1>900.00</VTFC1><VADFC1>1000.00</VADFC1><VTFCX1>1</VTFCX1>');
    expect(xml).toContain('<G2DCRIB>N</G2DCRIB>');
    expect(xml).toContain('<ElementoPatrimonial><G2DB>4</G2DB><F2ONEROSA>1</F2ONEROSA><G2DE>110.00</G2DE><G2DF>100.00</G2DF><G2DI>10.00</G2DI>');
    expect(xml).toContain('<G2DE>50.00</G2DE><G2DF>80.00</G2DF><G2DG>30.00</G2DG><G2DH>30.00</G2DH>');
    expect(xml).toContain('<GPOtrasGananciasEjerAnt><GPImpPerAnt><G2D_B1>250.00</G2D_B1></GPImpPerAnt></GPOtrasGananciasEjerAnt>');
    expect(xml).toContain('<DP_APENOM_D>IBÁÑEZ, ANA</DP_APENOM_D><ECIVIL>1</ECIVIL><DPFNAC_D>31/12/1990</DPFNAC_D>');
  });
});
