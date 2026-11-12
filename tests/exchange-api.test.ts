import { generateKeyPairSync, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { parseCsv } from '../server/importers/csv.ts';
import { parseFile } from '../server/importers/index.ts';
import type { CoinbaseTx, Deps, KrakenEntry } from '../server/exchange-api.ts';

// Antes de cargar nada que abra la base de datos: estas pruebas importan y guardan claves.
process.env.FIFO_DB = ':memory:';
const db = await import('../server/db.ts');
if (db.DB_PATH !== ':memory:') throw new Error('Las pruebas de la API no pueden usar la base de datos real.');
const svc = await import('../server/service.ts');
const api = await import('../server/exchange-api.ts');
const { coinbaseCsv, coinbaseJwt, fetchCoinbase, krakenCsv, krakenSignature } = api;

const rate = (c: string) => (c === 'USD' ? D('1.25') : null);
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const deps = (fetch: Deps['fetch']): Deps => ({ fetch, sleep: async () => {}, now: () => Date.parse('2026-11-12T12:00:00Z') });

describe('Kraken por API', () => {
  it('firma como en el ejemplo de la documentación de Kraken', () => {
    const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    expect(krakenSignature('/0/private/AddOrder', 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25', '1616492376594', secret))
      .toBe('4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  });

  it('el ledger de la API da los mismos movimientos y claves que el CSV, así no se duplica lo ya subido', () => {
    const text = fixture('kraken_ledgers.csv');
    const { headers, rows } = parseCsv(text);
    const at = (n: string) => headers.indexOf(n);
    const ledger: Record<string, KrakenEntry> = Object.fromEntries(rows.map((r) => [r[at('txid')]!, {
      refid: r[at('refid')]!, time: Date.parse(`${r[at('time')]!.replace(' ', 'T')}Z`) / 1000, type: r[at('type')]!, subtype: r[at('subtype')], aclass: r[at('aclass')],
      asset: r[at('asset')]!, wallet: r[at('wallet')], amount: r[at('amount')]!, fee: r[at('fee')]!, balance: r[at('balance')],
    }]));
    const pick = (o: { sourceKey?: string | null; kind: string; assetId: string; quantity?: string | null; datetime: string }) => [o.sourceKey, o.kind, o.assetId, o.quantity, o.datetime];
    const fromCsv = parseFile(text, rate), fromApi = parseFile(krakenCsv(ledger), rate);
    expect(fromApi.ops.map(pick)).toEqual(fromCsv.ops.map(pick));
    expect(fromApi.balances).toEqual(fromCsv.balances);
  });
});

describe('Coinbase por API', () => {
  const tx = (id: string, type: string, currency: string, amount: string, native: string, p: Partial<CoinbaseTx> = {}): CoinbaseTx =>
    ({ id, type, status: 'completed', created_at: `2026-03-0${id.slice(-1)}T10:00:00Z`, amount: { amount, currency }, native_amount: { amount: native, currency: 'EUR' }, ...p });

  it('pasa cada tipo de la API al del historial de transacciones', () => {
    const fill = { fill_price: '50000', product_id: 'BTC-EUR', order_side: 'buy', commission: '5' };
    const txs = [
      tx('t1', 'buy', 'BTC', '0.01', '-405.00'),
      tx('t2', 'advanced_trade_fill', 'BTC', '0.1', '-5000.00', { advanced_trade_fill: fill }),
      tx('t3', 'advanced_trade_fill', 'EUR', '-5000.00', '-5000.00', { advanced_trade_fill: fill }),
      tx('t4', 'trade', 'ETH', '-1', '-3000.00', { trade: { id: 'x' } }),
      tx('t5', 'trade', 'SOL', '20', '3000.00', { trade: { id: 'x' } }),
      tx('t6', 'staking_reward', 'ETH', '0.01', '30.00'),
      tx('t7', 'send', 'BTC', '-0.05', '-2500.00'),
      tx('t8', 'fiat_deposit', 'EUR', '1000', '1000'),
      { ...tx('t9', 'buy', 'BTC', '1', '-1'), status: 'pending' },
    ];
    const p = parseFile(coinbaseCsv(txs), rate);
    expect(p.broker).toBe('coinbase');
    expect(p.ops.map((o) => [o.sourceKey, o.kind, o.assetId, o.quantity, o.counterAsset ?? null])).toEqual([
      ['cb:t1', 'buy', 'BTC', '0.01', null],
      ['cb:t2', 'buy', 'BTC', '0.1', null],
      ['cb:t4', 'swap', 'ETH', '1', 'SOL'],
      ['cb:t6', 'staking', 'ETH', '0.01', null],
      ['cb:t7', 'transfer_out', 'BTC', '0.05', null],
    ]);
    expect(p.ops[1]).toMatchObject({ grossEur: '5000.00', feeEur: '5.00', datetime: '2026-03-02T11:00:00' });
    expect(p.ops[2]).toMatchObject({ grossEur: '3000.00', counterQuantity: '20' });
    expect(p.ignored).toMatchObject({ 'Ingresos y retiradas en euros': 1 });
  });

  it('firma con claves ECDSA (ES256) y Ed25519 de la CDP, ligadas al método y la ruta', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const ed = generateKeyPairSync('ed25519');
    const seed = ed.privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
    const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const cases = [
      { secret: ec.privateKey.export({ format: 'pem', type: 'sec1' }).toString().replace(/\n/g, '\\n'), pub: ec.publicKey, alg: 'ES256' },
      { secret: Buffer.concat([seed, pub]).toString('base64'), pub: ed.publicKey, alg: 'EdDSA' },
    ];
    for (const c of cases) {
      const jwt = coinbaseJwt('GET', '/v2/accounts?limit=300', { key: 'organizations/o/apiKeys/k', secret: c.secret }, Date.parse('2026-11-12T12:00:00Z'));
      const [h, p, s] = jwt.split('.') as [string, string, string];
      const header = JSON.parse(Buffer.from(h, 'base64url').toString()), payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      expect(header).toMatchObject({ alg: c.alg, kid: 'organizations/o/apiKeys/k', typ: 'JWT' });
      expect(payload).toMatchObject({ sub: 'organizations/o/apiKeys/k', iss: 'cdp', uri: 'GET api.coinbase.com/v2/accounts', exp: payload.nbf + 120 });
      const ok = c.alg === 'ES256'
        ? verify('sha256', Buffer.from(`${h}.${p}`), { key: c.pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))
        : verify(null, Buffer.from(`${h}.${p}`), c.pub, Buffer.from(s, 'base64url'));
      expect(ok).toBe(true);
    }
  });

  it('recorre todas las cuentas y para al llegar a lo ya importado', async () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    const seen: string[] = [];
    const fake = (async (url: string) => {
      const path = url.replace('https://api.coinbase.com', '');
      seen.push(path);
      if (path.startsWith('/v2/accounts?')) return json({ data: [{ id: 'a' }], pagination: { next_uri: null } });
      if (path === '/v2/accounts/a/transactions?limit=100') return json({ data: [tx('n2', 'buy', 'BTC', '1', '-1'), tx('n1', 'buy', 'BTC', '1', '-1')], pagination: { next_uri: '/v2/accounts/a/transactions?limit=100&starting_after=n1' } });
      return json({ data: [{ ...tx('o1', 'buy', 'BTC', '1', '-1'), created_at: '2026-01-01T00:00:00Z' }], pagination: { next_uri: '/v2/accounts/a/transactions?limit=100&starting_after=o1' } });
    }) as unknown as Deps['fetch'];
    const got = await fetchCoinbase({ key: 'k', secret: ec }, '2026-02-01T00:00:00Z', deps(fake));
    expect(got.map((t) => t.id)).toEqual(['n2', 'n1']);
    expect(seen).toHaveLength(3);
  });
});

describe('Sincronización de Kraken', () => {
  beforeAll(() => db.seedRatesIfEmpty());
  const SECRET = Buffer.from('clave privada de prueba').toString('base64');
  const entry = (refid: string, time: string, type: string, asset: string, amount: string, balance: string): KrakenEntry =>
    ({ refid, time: Date.parse(time) / 1000, type, subtype: '', aclass: 'currency', asset, amount, fee: '0', balance });
  const ledger: Record<string, KrakenEntry> = {
    L1: entry('D1', '2026-10-01T10:00:00Z', 'deposit', 'ZEUR', '1000', '1000'),
    L2: entry('T1', '2026-10-02T10:00:00Z', 'trade', 'ZEUR', '-500', '500'),
    L3: entry('T1', '2026-10-02T10:00:00Z', 'trade', 'XETH', '0.25', '0.25'),
  };
  // El ingreso en euros no tiene efecto fiscal: queda la compra.
  const KRAKEN_OPS = [['buy', 'ETH', '0.25']];
  const calls: { path: string; body: string; sign: string; key: string }[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    calls.push({ path: new URL(url).pathname, body: String(init.body), sign: headers['API-Sign']!, key: headers['API-Key']! });
    const params = new URLSearchParams(String(init.body));
    // Kraken pagina de 50 en 50: aquí, de 2 en 2.
    const ids = params.get('start') === String(Math.floor(Date.parse('2026-11-12T12:00:00Z') / 1000)) ? [] : Object.keys(ledger).slice(Number(params.get('ofs')), Number(params.get('ofs')) + 2);
    return json({ error: [], result: { ledger: Object.fromEntries(ids.map((id) => [id, ledger[id]])), count: ids.length ? Object.keys(ledger).length : 0 } });
  }) as unknown as Deps['fetch'];

  it('comprueba la clave, guarda solo lo necesario e importa el ledger una vez', async () => {
    await api.connectExchange('kraken', { key: ' PUBLICA ', secret: SECRET }, deps(fake));
    expect(calls[0]).toMatchObject({ path: '/0/private/Ledgers', key: 'PUBLICA' });
    const nonce = new URLSearchParams(calls[0]!.body).get('nonce')!;
    expect(calls[0]!.sign).toBe(krakenSignature('/0/private/Ledgers', calls[0]!.body, nonce, SECRET));
    expect(JSON.stringify(api.listConnections())).not.toContain(SECRET);
    expect(api.listConnections()).toMatchObject([{ broker: 'kraken', hint: '…LICA', running: false }]);

    await api.startSync('kraken', deps(fake));
    expect(api.listConnections()[0]).toMatchObject({ result: { added: 1 }, error: null });
    expect(db.allOps().filter((o) => o.broker === 'kraken').map((o) => [o.kind, o.assetId, o.quantity])).toEqual(KRAKEN_OPS);
    expect(svc.listImports().map((i) => i.file)).toEqual(['API de Kraken']);

    // La segunda vez pide desde el último movimiento y no repite nada.
    await api.startSync('kraken', deps(fake));
    expect(new URLSearchParams(calls.at(-1)!.body).get('start')).toBe(String(Date.parse('2026-09-30T12:00:00Z') / 1000));
    expect(api.listConnections()[0]).toMatchObject({ result: { added: 0 } });
    expect(svc.listImports()).toHaveLength(1);
  });

  it('un error de Kraken se muestra con un mensaje claro y no guarda la clave', async () => {
    const denied = (async () => json({ error: ['EGeneral:Permission denied'] })) as unknown as Deps['fetch'];
    await expect(api.connectExchange('kraken', { key: 'OTRA', secret: SECRET }, deps(denied))).rejects.toThrow(/Query Ledger Entries/);
    expect(api.listConnections()[0]).toMatchObject({ hint: '…LICA' });
    api.disconnectExchange('kraken');
    expect(api.listConnections()).toEqual([]);
  });
});
