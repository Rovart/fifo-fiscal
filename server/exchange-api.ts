import { createHash, createHmac, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DB_PATH, currentProfileId, db } from './db.ts';
import { ValidationError, commitImport, previewImport } from './service.ts';

/**
 * Conexión de solo lectura con Kraken y Coinbase. La API devuelve los mismos movimientos que el extracto:
 * se escriben en el formato de su CSV y pasan por el mismo importador, con las mismas reglas y sin duplicar
 * lo ya subido. Solo se pide lo posterior al último movimiento de ese exchange.
 */
export type ApiBroker = 'kraken' | 'coinbase';
export const API_BROKERS: ApiBroker[] = ['kraken', 'coinbase'];
const LABEL: Record<ApiBroker, string> = { kraken: 'Kraken', coinbase: 'Coinbase' };

export interface ApiCredentials { key: string; secret: string }
interface SyncResult { added: number; found: number; warnings: string[] }
interface Stored extends ApiCredentials { addedAt: string; syncedAt?: string; result?: SyncResult; error?: string }
export interface Deps { fetch: typeof fetch; sleep: (ms: number) => Promise<void>; now: () => number }
const DEPS: Deps = { fetch: (...a) => fetch(...a), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now() };

export class ExchangeApiError extends Error {}

// ── Claves ──────────────────────────────────────────────────────────────────
// Fuera de la base de datos y con permisos 600: no viajan en las copias de seguridad ni al navegador.
const FILE = DB_PATH === ':memory:' ? null : join(dirname(DB_PATH), 'claves-api.json');
let memory: Record<string, Partial<Record<ApiBroker, Stored>>> = {};
const readAll = (): typeof memory => (FILE && existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : memory);
function writeAll(all: typeof memory) {
  if (!FILE) { memory = all; return; }
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 1), { mode: 0o600 });
  renameSync(tmp, FILE);
  chmodSync(FILE, 0o600);
}
const stored = (broker: ApiBroker): Stored | undefined => readAll()[currentProfileId()]?.[broker];
function update(broker: ApiBroker, next: Stored | null) {
  const all = readAll();
  const mine = { ...all[currentProfileId()] };
  if (next) mine[broker] = next; else delete mine[broker];
  all[currentProfileId()] = mine;
  writeAll(all);
}

const isBroker = (b: string): b is ApiBroker => (API_BROKERS as string[]).includes(b);
export function assertBroker(b: string): ApiBroker {
  if (!isBroker(b)) throw new ValidationError('Solo hay API para Kraken y Coinbase.', null);
  return b;
}

// ── Kraken ──────────────────────────────────────────────────────────────────
const KRAKEN = 'https://api.kraken.com';

/** Firma de Kraken: HMAC-SHA512 de la ruta y el SHA-256 del nonce con el cuerpo, con la clave privada en base64. */
export function krakenSignature(path: string, body: string, nonce: string, secret: string): string {
  const hash = createHash('sha256').update(nonce + body).digest();
  return createHmac('sha512', Buffer.from(secret, 'base64')).update(Buffer.concat([Buffer.from(path), hash])).digest('base64');
}

let lastNonce = 0;
// Contador de Kraken: cada consulta del ledger suma 2, el tope es 15 y baja 0,33 por segundo.
let counter = 0, counterAt = 0;
async function krakenTurn(deps: Deps) {
  const decay = () => { const now = deps.now(); counter = Math.max(0, counter - ((now - counterAt) / 1000) * 0.33); counterAt = now; };
  decay();
  if (counter + 2 > 15) { await deps.sleep(((counter + 2 - 15) / 0.33) * 1000); decay(); }
  counter += 2;
}

const KRAKEN_ERRORS: [RegExp, string][] = [
  [/Invalid key/i, 'Kraken no reconoce esa clave pública.'],
  [/Invalid signature/i, 'La clave privada no corresponde a esa clave pública.'],
  [/Permission denied/i, 'La clave no tiene permiso para consultar el ledger: marca «Query Ledger Entries».'],
  [/Invalid nonce/i, 'Kraken rechazó la petición por el nonce. Usa una clave solo para esta aplicación.'],
];

async function krakenPrivate<T>(path: string, params: Record<string, string>, creds: ApiCredentials, deps: Deps): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await krakenTurn(deps);
    lastNonce = Math.max(deps.now() * 1000, lastNonce + 1);
    const nonce = String(lastNonce);
    const body = new URLSearchParams({ nonce, ...params }).toString();
    const res = await deps.fetch(KRAKEN + path, {
      method: 'POST', body, signal: AbortSignal.timeout(30_000),
      headers: { 'API-Key': creds.key, 'API-Sign': krakenSignature(path, body, nonce, creds.secret), 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string[]; result?: T };
    const error = json.error?.join(' ') ?? '';
    if (/Rate limit|Too many requests/i.test(error) && attempt < 6) { counter = 15; await deps.sleep(10_000); continue; }
    if (error) throw new ExchangeApiError(KRAKEN_ERRORS.find(([re]) => re.test(error))?.[1] ?? `Kraken respondió: ${error}`);
    if (!res.ok || !json.result) throw new ExchangeApiError(`Kraken respondió ${res.status}. Inténtalo en unos minutos.`);
    return json.result;
  }
}

export interface KrakenEntry { refid: string; time: number; type: string; subtype?: string; aclass?: string; subclass?: string; asset: string; wallet?: string; amount: string; fee: string; balance?: string }

/** Ledger completo desde `start` (segundos Unix, exclusivo), de 50 en 50. */
export async function fetchKrakenLedger(creds: ApiCredentials, start: number | null, deps: Deps = DEPS, onPage?: (n: number) => void): Promise<Record<string, KrakenEntry>> {
  const all: Record<string, KrakenEntry> = {};
  for (let ofs = 0, page = 0; page < 4000; page++) {
    const r = await krakenPrivate<{ ledger: Record<string, KrakenEntry>; count: number }>('/0/private/Ledgers', { ofs: String(ofs), ...(start ? { start: String(start) } : {}) }, creds, deps);
    const ids = Object.keys(r.ledger ?? {});
    Object.assign(all, r.ledger);
    ofs += ids.length;
    onPage?.(Object.keys(all).length);
    if (!ids.length || ofs >= r.count) break;
  }
  return all;
}

const cell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (headers: string[], rows: unknown[][]) => [headers, ...rows].map((r) => r.map(cell).join(',')).join('\n');
const utc = (seconds: number) => new Date(Math.floor(seconds) * 1000).toISOString().slice(0, 19).replace('T', ' ');

/** El ledger de la API con las columnas del CSV «Ledgers». */
export function krakenCsv(ledger: Record<string, KrakenEntry>): string {
  const rows = Object.entries(ledger).sort(([, a], [, b]) => a.time - b.time)
    .map(([id, e]) => [id, e.refid, utc(e.time), e.type, e.subtype ?? '', e.aclass ?? '', e.subclass ?? '', e.asset, e.wallet ?? '', e.amount, e.fee, e.balance ?? '']);
  return csv(['txid', 'refid', 'time', 'type', 'subtype', 'aclass', 'subclass', 'asset', 'wallet', 'amount', 'fee', 'balance'], rows);
}

// ── Coinbase ────────────────────────────────────────────────────────────────
const COINBASE = 'api.coinbase.com';

/** Claves de la CDP: ECDSA en PEM (ES256) o Ed25519 en base64 (EdDSA). */
function coinbaseKey(secret: string): { key: KeyObject; alg: 'ES256' | 'EdDSA' } {
  const text = secret.replace(/\\n/g, '\n').trim();
  try {
    if (text.includes('BEGIN')) return { key: createPrivateKey(text), alg: 'ES256' };
    const raw = Buffer.from(text, 'base64');
    if (raw.length !== 64 && raw.length !== 32) throw new Error('longitud');
    // PKCS#8 de una semilla Ed25519: prefijo fijo más los 32 bytes.
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), raw.subarray(0, 32)]);
    return { key: createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }), alg: 'EdDSA' };
  } catch {
    throw new ValidationError('No reconozco la clave privada de Coinbase. Pega la que empieza por «-----BEGIN EC PRIVATE KEY-----» o el JSON que descargaste.', null);
  }
}

/** JWT de un solo uso que Coinbase exige en cada petición, ligado a su método y ruta. */
export function coinbaseJwt(method: string, path: string, creds: ApiCredentials, now = Date.now()): string {
  const { key, alg } = coinbaseKey(creds.secret);
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const t = Math.floor(now / 1000);
  const data = `${b64({ alg, kid: creds.key, nonce: randomBytes(16).toString('hex'), typ: 'JWT' })}.${b64({ sub: creds.key, iss: 'cdp', nbf: t, exp: t + 120, uri: `${method} ${COINBASE}${path.split('?')[0]}` })}`;
  const signature = alg === 'ES256' ? sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }) : sign(null, Buffer.from(data), key);
  return `${data}.${signature.toString('base64url')}`;
}

async function coinbaseGet<T>(path: string, creds: ApiCredentials, deps: Deps): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await deps.fetch(`https://${COINBASE}${path}`, { headers: { Authorization: `Bearer ${coinbaseJwt('GET', path, creds, deps.now())}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 429 && attempt < 6) { await deps.sleep(5_000); continue; }
    if (res.status === 401) throw new ExchangeApiError('Coinbase no acepta la clave. Comprueba el nombre y la clave privada.');
    if (res.status === 403) throw new ExchangeApiError('La clave de Coinbase no tiene permiso de lectura («View»).');
    if (!res.ok) throw new ExchangeApiError(`Coinbase respondió ${res.status}. Inténtalo en unos minutos.`);
    return (await res.json()) as T;
  }
}

interface Money { amount: string; currency: string }
export interface CoinbaseTx {
  id: string; type: string; status: string; created_at: string; amount: Money; native_amount?: Money; description?: string | null;
  details?: { title?: string; subtitle?: string; header?: string } | null;
  trade?: { id: string } | null;
  advanced_trade_fill?: { fill_price: string; product_id: string; order_side: string; commission?: string } | null;
}
interface Page<T> { data: T[]; pagination?: { next_uri?: string | null } }

/** Movimientos de todas las cuentas, del más reciente hacia atrás hasta `since` (ISO, UTC). */
export async function fetchCoinbase(creds: ApiCredentials, since: string | null, deps: Deps = DEPS, onPage?: (n: number) => void): Promise<CoinbaseTx[]> {
  const accounts: { id: string }[] = [];
  for (let next: string | null | undefined = '/v2/accounts?limit=300'; next;) {
    const page: Page<{ id: string }> = await coinbaseGet(next, creds, deps);
    accounts.push(...page.data);
    next = page.pagination?.next_uri;
  }
  const out: CoinbaseTx[] = [];
  const queue = [...accounts];
  const work = async () => {
    for (let a = queue.shift(); a; a = queue.shift()) {
      for (let next: string | null | undefined = `/v2/accounts/${a.id}/transactions?limit=100`; next;) {
        const page: Page<CoinbaseTx> = await coinbaseGet(next, creds, deps);
        const fresh = page.data.filter((t) => !since || t.created_at > since);
        out.push(...fresh);
        onPage?.(out.length);
        next = fresh.length < page.data.length ? null : page.pagination?.next_uri;
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, work));
  return out;
}

const TYPE: Record<string, string> = {
  buy: 'Buy', sell: 'Sell', trade: 'Convert', staking_reward: 'Staking Income', inflation_reward: 'Inflation Reward', interest: 'Rewards Income',
  earn_payout: 'Coinbase Earn', fiat_deposit: 'Deposit', fiat_withdrawal: 'Withdrawal', exchange_deposit: 'Exchange Deposit', exchange_withdrawal: 'Exchange Withdrawal',
  pro_deposit: 'Pro Deposit', pro_withdrawal: 'Pro Withdrawal', staking_transfer: 'Staking Transfer', unstaking_transfer: 'Unstaking Transfer',
  retail_simple_dust: 'Retail Simple Dust', card_spend: 'Card Spend', cardspend: 'Card Spend',
};
const title = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const abs = (s: string | undefined) => (s ?? '').replace(/^-/, '');
const money = (m: Money | undefined) => (m ? `${abs(m.amount)} ${m.currency}` : '');

/** Los movimientos de la API con las columnas del «Historial de transacciones». */
export function coinbaseCsv(txs: CoinbaseTx[]): string {
  const rows: unknown[][] = [];
  const done = txs.filter((t) => t.status === 'completed').sort((a, b) => a.created_at.localeCompare(b.created_at));
  const legs = new Map<string, CoinbaseTx[]>();
  for (const t of done) if (t.type === 'trade' && t.trade?.id) legs.set(t.trade.id, [...(legs.get(t.trade.id) ?? []), t]);
  const notesOf = (t: CoinbaseTx) => [t.details?.title, t.details?.subtitle, t.description].filter(Boolean).join(' · ');
  const row = (t: CoinbaseTx, type: string, notes: string, fees = '') =>
    rows.push([t.id, t.created_at, type, t.amount.currency, abs(t.amount.amount), t.native_amount?.currency ?? '', '', money(t.native_amount), money(t.native_amount), fees, notes]);

  for (const t of done) {
    const fill = t.advanced_trade_fill;
    if (t.type === 'advanced_trade_fill' && fill) {
      const [base, quote] = fill.product_id.split('-');
      // Cada ejecución aparece en las dos cuentas: basta la del activo comprado o vendido.
      if (t.amount.currency !== base) continue;
      const qty = abs(t.amount.amount), quoteQty = (Number(qty) * Number(fill.fill_price)).toFixed(8);
      const buy = fill.order_side.toLowerCase() === 'buy';
      // La comisión va en la moneda del par; se pasa a la moneda del valor con la misma proporción.
      const native = Number(abs(t.native_amount?.amount));
      const fee = fill.commission && Number(quoteQty) ? `${(Number(fill.commission) * native / Number(quoteQty)).toFixed(2)} ${t.native_amount?.currency ?? ''}` : '';
      row(t, buy ? 'Advanced Trade Buy' : 'Advanced Trade Sell', `${buy ? 'Bought' : 'Sold'} ${qty} ${base} for ${quoteQty} ${quote} on ${fill.product_id} at ${fill.fill_price} ${quote}/${base}`, fee);
    } else if (t.type === 'trade') {
      const pair = t.trade?.id ? legs.get(t.trade.id) ?? [] : [];
      const from = pair.find((x) => x.amount.amount.startsWith('-')), to = pair.find((x) => !x.amount.amount.startsWith('-'));
      if (t !== (from ?? t)) continue;
      row(t, 'Convert', to ? `Converted ${abs(t.amount.amount)} ${t.amount.currency} to ${abs(to.amount.amount)} ${to.amount.currency}` : '');
    } else if (t.type === 'send') {
      row(t, t.amount.amount.startsWith('-') ? 'Send' : 'Receive', notesOf(t));
    } else if (t.type === 'buy' || t.type === 'sell') {
      row(t, TYPE[t.type]!, `${t.type === 'buy' ? 'Bought' : 'Sold'} ${abs(t.amount.amount)} ${t.amount.currency} for ${money(t.native_amount)}`);
    } else {
      row(t, TYPE[t.type] ?? title(t.type), notesOf(t));
    }
  }
  return csv(['ID', 'Timestamp', 'Transaction Type', 'Asset', 'Quantity Transacted', 'Price Currency', 'Price at Transaction', 'Subtotal', 'Total (inclusive of fees and/or spread)', 'Fees and/or Spread', 'Notes'], rows);
}

// ── Conexión y sincronización ───────────────────────────────────────────────
/** Coinbase entrega la clave en un JSON: se acepta pegado entero. */
function normalize(broker: ApiBroker, raw: ApiCredentials): ApiCredentials {
  let key = (raw.key ?? '').trim(), secret = (raw.secret ?? '').trim();
  if (broker === 'coinbase' && secret.startsWith('{')) {
    try {
      const j = JSON.parse(secret) as { name?: string; id?: string; privateKey?: string };
      key = key || j.name || j.id || '';
      secret = j.privateKey ?? '';
    } catch { /* Se valida abajo. */ }
  }
  if (!key || !secret) throw new ValidationError(broker === 'kraken' ? 'Pega la clave pública y la privada.' : 'Pega el nombre de la clave y la clave privada.', null);
  return { key, secret };
}

export async function connectExchange(broker: ApiBroker, raw: ApiCredentials, deps: Deps = DEPS) {
  const creds = normalize(broker, raw);
  // Una consulta mínima comprueba la clave y sus permisos antes de guardarla.
  if (broker === 'kraken') await krakenPrivate('/0/private/Ledgers', { start: String(Math.floor(deps.now() / 1000)) }, creds, deps);
  else await coinbaseGet('/v2/accounts?limit=1', creds, deps);
  update(broker, { ...creds, addedAt: new Date(deps.now()).toISOString() });
}

export const disconnectExchange = (broker: ApiBroker) => update(broker, null);

const running = new Map<string, { fetched: number }>();
const jobKey = (broker: ApiBroker) => `${currentProfileId()}:${broker}`;

/** Lo que ve el navegador: nunca las claves, solo sus últimos caracteres. */
export function listConnections() {
  return API_BROKERS.flatMap((broker) => {
    const s = stored(broker);
    if (!s) return [];
    const job = running.get(jobKey(broker));
    return [{ broker, hint: `…${s.key.slice(-4)}`, addedAt: s.addedAt, syncedAt: s.syncedAt ?? null, result: s.result ?? null, error: s.error ?? null, running: !!job, fetched: job?.fetched ?? 0 }];
  });
}

/** Desde el último movimiento de ese exchange, con dos días de margen: lo repetido no se duplica. */
function since(broker: ApiBroker): Date | null {
  const last = (db.prepare('SELECT MAX(datetime) AS dt FROM operations WHERE broker = ?').get(broker) as { dt: string | null }).dt;
  return last ? new Date(Date.parse(`${last}Z`) - 2 * 86_400_000) : null;
}

export async function syncExchange(broker: ApiBroker, deps: Deps = DEPS, onProgress?: (n: number) => void): Promise<SyncResult> {
  const creds = stored(broker);
  if (!creds) throw new ValidationError(`Conecta antes la API de ${LABEL[broker]}.`, null);
  const from = since(broker);
  const text = broker === 'kraken'
    ? krakenCsv(await fetchKrakenLedger(creds, from ? Math.floor(from.getTime() / 1000) : null, deps, onProgress))
    : coinbaseCsv(await fetchCoinbase(creds, from?.toISOString() ?? null, deps, onProgress));
  const { preview } = previewImport(text);
  const result: SyncResult = { added: 0, found: preview.newOps + preview.duplicates, warnings: preview.warnings };
  if (preview.newOps > 0) result.added = commitImport(`API de ${LABEL[broker]}`, text).newOps;
  return result;
}

/** Arranca la sincronización y responde al momento: un ledger largo de Kraken tarda minutos por su límite de consultas. */
export function startSync(broker: ApiBroker, deps: Deps = DEPS, after?: (r: SyncResult) => void): Promise<void> | null {
  const key = jobKey(broker);
  if (running.has(key)) return null;
  if (!stored(broker)) throw new ValidationError(`Conecta antes la API de ${LABEL[broker]}.`, null);
  const job = { fetched: 0 };
  running.set(key, job);
  return syncExchange(broker, deps, (n) => { job.fetched = n; })
    .then((result) => {
      const s = stored(broker);
      if (s) update(broker, { ...s, syncedAt: new Date(deps.now()).toISOString(), result, error: undefined });
      after?.(result);
    })
    .catch((e: Error) => {
      const s = stored(broker);
      if (s) update(broker, { ...s, error: e instanceof ExchangeApiError || e instanceof ValidationError ? e.message : `No se pudo leer ${LABEL[broker]}: ${e.message}` });
    })
    .finally(() => running.delete(key));
}
