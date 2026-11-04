import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import type { Backup } from '../shared/types.ts';
import { DB_PATH, bump, currentProfileId, db, initialize, listProfiles, withProfile } from './db.ts';

/** Fuera de las copias que hagas tú a mano: solo se borran las que crea la aplicación. */
export const BACKUP_DIR = process.env.FIFO_BACKUP_DIR ?? (DB_PATH === ':memory:' ? null : join(dirname(DB_PATH), 'backups', 'auto'));
const NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:-\d+)?(?:_(manual|antes-de-restaurar))?$/;
const DONE = 'cuentas.json';
const KEEP_DAYS = 7;
const KEEP_MONTHS = 12;
const KEEP_EXTRA_DAYS = 30;

export class BackupError extends Error {}

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;

function describe(id: string): Backup {
  const m = NAME.exec(id)!;
  const files = readdirSync(join(BACKUP_DIR!, id));
  return {
    id, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, kind: (m[7] as Backup['kind'] | undefined) ?? 'daily',
    bytes: files.reduce((s, f) => s + statSync(join(BACKUP_DIR!, id, f)).size, 0),
    profiles: files.filter((f) => f.endsWith('.db.gz')).map((f) => f.slice(0, -'.db.gz'.length)),
  };
}

/** Solo las terminadas: una copia a medias no tiene la lista de cuentas. */
export function listBackups(): Backup[] {
  if (!BACKUP_DIR || !existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR).filter((n) => NAME.test(n) && existsSync(join(BACKUP_DIR!, n, DONE))).sort().reverse().map(describe);
}

/** Una por día de los últimos 7 con copia, una por mes del último año y las manuales del último mes.
 * La de antes de restaurar no ocupa el hueco del día: borraría la que se está restaurando. */
function prune(now: Date) {
  const all = listBackups();
  const keep = new Set<string>();
  const days = new Set<string>();
  const months = new Set<string>();
  const recent = stamp(new Date(now.getTime() - KEEP_EXTRA_DAYS * 86400000)).slice(0, 10);
  for (const b of all) {
    const day = b.at.slice(0, 10), month = b.at.slice(0, 7);
    if (b.kind !== 'daily' && day >= recent) keep.add(b.id);
    if (b.kind === 'antes-de-restaurar') continue;
    if (!days.has(day) && days.size < KEEP_DAYS) { days.add(day); keep.add(b.id); }
    if (!months.has(month) && months.size < KEEP_MONTHS) { months.add(month); keep.add(b.id); }
  }
  for (const b of all) if (!keep.has(b.id)) rmSync(join(BACKUP_DIR!, b.id), { recursive: true, force: true });
}

let running: Promise<Backup> | null = null;

export function makeBackup(kind: Backup['kind'] = 'daily', now = new Date()): Promise<Backup> {
  if (!BACKUP_DIR) return Promise.reject(new BackupError('Las copias de seguridad están desactivadas.'));
  // Dos copias a la vez escribirían en la misma carpeta.
  const previous = running ?? Promise.resolve(null);
  const next = previous.catch(() => null).then(async () => {
    let id = `${stamp(now)}${kind === 'daily' ? '' : `_${kind}`}`;
    for (let n = 2; existsSync(join(BACKUP_DIR!, id)); n++) id = `${stamp(now)}-${n}${kind === 'daily' ? '' : `_${kind}`}`;
    const target = join(BACKUP_DIR!, id);
    mkdirSync(target, { recursive: true });
    const profiles = listProfiles();
    for (const p of profiles) {
      const raw = join(target, `${p.id}.db`);
      // Copia coherente aunque la aplicación esté escribiendo.
      withProfile(p.id, () => db.exec(`VACUUM INTO ${quote(raw)}`));
      await pipeline(createReadStream(raw), createGzip(), createWriteStream(`${raw}.gz`));
      rmSync(raw);
    }
    writeFileSync(join(target, DONE), JSON.stringify(profiles));
    prune(now);
    return describe(id);
  });
  running = next;
  return next;
}

/** La primera vez que arranca cada día. */
export async function ensureDailyBackup(now = new Date()): Promise<Backup | null> {
  const today = stamp(now).slice(0, 10);
  if (!BACKUP_DIR || listBackups().some((b) => b.kind !== 'antes-de-restaurar' && b.at.startsWith(today))) return null;
  return makeBackup('daily', now);
}

export function startBackups() {
  if (!BACKUP_DIR) return;
  const run = () => void ensureDailyBackup().catch((e: Error) => console.error(`No se pudo hacer la copia de seguridad: ${e.message}`));
  setTimeout(run, 10_000).unref();
  setInterval(run, 3600_000).unref();
}

/** Devuelve la cuenta actual a como estaba en esa copia. Antes guarda cómo está ahora. */
export async function restoreBackup(id: string): Promise<void> {
  const profile = currentProfileId();
  const backup = listBackups().find((b) => b.id === id);
  if (!backup) throw new BackupError('No encuentro esa copia.');
  if (!backup.profiles.includes(profile)) throw new BackupError('Esa copia no tiene esta cuenta.');
  const tmp = join(BACKUP_DIR!, `.restaurar-${randomUUID()}.db`);
  try {
    await pipeline(createReadStream(join(BACKUP_DIR!, id, `${profile}.db.gz`)), createGunzip(), createWriteStream(tmp));
    await makeBackup('antes-de-restaurar');
    // Una copia antigua se pone al día antes de copiar sus datos.
    const source = new DatabaseSync(tmp);
    initialize(source);
    source.exec('PRAGMA journal_mode = DELETE');
    source.close();
    db.prepare('ATTACH DATABASE ? AS src').run(tmp);
    try {
      const tables = (db.prepare("SELECT name FROM main.sqlite_master WHERE type = 'table' AND name NOT IN ('sqlite_sequence', 'profiles')").all() as { name: string }[]).map((r) => r.name);
      const columns = (schema: string, table: string) => (db.prepare(`PRAGMA ${schema}.table_info("${table}")`).all() as { name: string }[]).map((c) => c.name);
      db.exec('BEGIN');
      try {
        for (const table of tables) {
          const there = new Set(columns('src', table));
          const shared = columns('main', table).filter((c) => there.has(c)).map((c) => `"${c}"`).join(', ');
          db.exec(`DELETE FROM main."${table}"`);
          if (shared) db.exec(`INSERT INTO main."${table}" (${shared}) SELECT ${shared} FROM src."${table}"`);
        }
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    } finally {
      db.exec('DETACH DATABASE src');
    }
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) rmSync(f, { force: true });
  }
  bump();
}
