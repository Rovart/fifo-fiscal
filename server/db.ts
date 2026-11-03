import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { D, type Decimal } from '../shared/decimal.ts';
import { DEFAULT_SETTINGS, type Asset, type Operation, type Settings } from '../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.FIFO_DB ?? join(here, '..', 'data', 'fifo.db');
if (DB_PATH !== ':memory:') mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS assets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY, data TEXT NOT NULL, datetime TEXT NOT NULL, year INTEGER NOT NULL, broker TEXT NOT NULL, kind TEXT NOT NULL,
    asset_id TEXT NOT NULL, source_key TEXT UNIQUE, import_id TEXT, deleted INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS ops_dt ON operations (datetime);
  CREATE TABLE IF NOT EXISTS op_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL, at TEXT NOT NULL, action TEXT NOT NULL, before TEXT, after TEXT
  );
  CREATE TABLE IF NOT EXISTS imports (id TEXT PRIMARY KEY, at TEXT NOT NULL, file TEXT, broker TEXT, format TEXT, summary TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS applied_costs (key TEXT PRIMARY KEY);
  CREATE TABLE IF NOT EXISTS quotes (asset_id TEXT PRIMARY KEY, symbol TEXT, currency TEXT, price TEXT, price_eur TEXT, at TEXT, fetched_at TEXT);
  CREATE TABLE IF NOT EXISTS price_history (asset_id TEXT NOT NULL, month TEXT NOT NULL, price_eur TEXT NOT NULL, PRIMARY KEY (asset_id, month));
  CREATE TABLE IF NOT EXISTS price_symbols (asset_id TEXT PRIMARY KEY, symbol TEXT, fetched_at TEXT);
  CREATE TABLE IF NOT EXISTS fx_rates (date TEXT NOT NULL, currency TEXT NOT NULL, rate TEXT NOT NULL, PRIMARY KEY (date, currency));
  CREATE TABLE IF NOT EXISTS crypto_prices (asset TEXT NOT NULL, ts INTEGER NOT NULL, eur TEXT NOT NULL, PRIMARY KEY (asset, ts));
  CREATE TABLE IF NOT EXISTS balances (broker TEXT NOT NULL, asset_id TEXT NOT NULL, quantity TEXT NOT NULL, as_of TEXT, source TEXT, PRIMARY KEY (broker, asset_id));
`);

let revision = 0;
export const bump = () => { revision++; };
export const rev = () => revision;

export function getSettings(): Settings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('main') as { value: string } | undefined;
  return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
}
export function saveSettings(s: Settings) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('main', JSON.stringify(s));
  bump();
}

export function listAssets(): Asset[] {
  return (db.prepare('SELECT data FROM assets').all() as { data: string }[]).map((r) => JSON.parse(r.data) as Asset);
}
export function saveAsset(a: Asset) {
  db.prepare('INSERT INTO assets (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(a.id, JSON.stringify(a));
  bump();
}

export function allOps(includeDeleted = false): Operation[] {
  const sql = includeDeleted ? 'SELECT data FROM operations ORDER BY datetime' : 'SELECT data FROM operations WHERE deleted = 0 ORDER BY datetime';
  return (db.prepare(sql).all() as { data: string }[]).map((r) => JSON.parse(r.data) as Operation);
}
export function getOp(id: string): Operation | null {
  const r = db.prepare('SELECT data FROM operations WHERE id = ?').get(id) as { data: string } | undefined;
  return r ? (JSON.parse(r.data) as Operation) : null;
}
export function hasSourceKey(key: string): boolean {
  return !!db.prepare('SELECT 1 FROM operations WHERE source_key = ?').get(key);
}
export function putOp(op: Operation) {
  db.prepare(`INSERT INTO operations (id, data, datetime, year, broker, kind, asset_id, source_key, import_id, deleted)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data, datetime = excluded.datetime, year = excluded.year, broker = excluded.broker,
      kind = excluded.kind, asset_id = excluded.asset_id, deleted = excluded.deleted`)
    .run(op.id, JSON.stringify(op), op.datetime, Number(op.datetime.slice(0, 4)), op.broker, op.kind, op.assetId, op.sourceKey ?? null, op.importId ?? null, op.deleted ? 1 : 0);
  bump();
}
export function addHistory(opId: string, action: string, before: unknown, after: unknown) {
  db.prepare('INSERT INTO op_history (op_id, at, action, before, after) VALUES (?, ?, ?, ?, ?)')
    .run(opId, new Date().toISOString(), action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
}
export function getHistory(opId: string) {
  return (db.prepare('SELECT at, action, before, after FROM op_history WHERE op_id = ? ORDER BY id DESC').all(opId) as { at: string; action: string; before: string | null; after: string | null }[])
    .map((h) => ({ at: h.at, action: h.action, before: h.before ? JSON.parse(h.before) : null, after: h.after ? JSON.parse(h.after) : null }));
}

// ---- Tipos del BCE ----
const rates = new Map<string, { dates: string[]; values: string[] }>();

function loadRatesIntoMemory() {
  rates.clear();
  const rows = db.prepare('SELECT date, currency, rate FROM fx_rates ORDER BY date').all() as { date: string; currency: string; rate: string }[];
  for (const r of rows) {
    let e = rates.get(r.currency);
    if (!e) { e = { dates: [], values: [] }; rates.set(r.currency, e); }
    e.dates.push(r.date);
    e.values.push(r.rate);
  }
}

export function seedRatesIfEmpty() {
  const n = (db.prepare('SELECT COUNT(*) c FROM fx_rates').get() as { c: number }).c;
  if (n === 0) {
    const lines = readFileSync(join(here, 'seed', 'ecb-rates.csv'), 'utf8').trim().split('\n');
    const head = (lines[0] as string).split(',');
    const ins = db.prepare('INSERT OR IGNORE INTO fx_rates (date, currency, rate) VALUES (?, ?, ?)');
    db.exec('BEGIN');
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      head.slice(1).forEach((cur, i) => {
        const v = cells[i + 1];
        if (v) ins.run(cells[0] as string, cur, v);
      });
    }
    db.exec('COMMIT');
  }
  loadRatesIntoMemory();
}

export function insertRates(items: { date: string; currency: string; rate: string }[]) {
  const ins = db.prepare('INSERT OR REPLACE INTO fx_rates (date, currency, rate) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  for (const i of items) ins.run(i.date, i.currency, i.rate);
  db.exec('COMMIT');
  loadRatesIntoMemory();
  bump();
}
export function latestRateDate(): string | null {
  return (db.prepare('SELECT MAX(date) d FROM fx_rates').get() as { d: string | null }).d;
}

/** Último tipo publicado no posterior a la fecha, con un máximo de 10 días (el BCE no publica en festivos). */
export function rateAt(currency: string, date: string): Decimal | null {
  if (currency === 'EUR') return D(1);
  if (currency === 'GBX' || currency === 'GBp') {
    const g = rateAt('GBP', date);
    return g ? g.times(100) : null;
  }
  const e = rates.get(currency);
  if (!e) return null;
  let lo = 0, hi = e.dates.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((e.dates[mid] as string) <= date) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found < 0) return null;
  const gap = (Date.parse(date) - Date.parse(e.dates[found] as string)) / 86400000;
  return gap <= 10 ? D(e.values[found] as string) : null;
}
