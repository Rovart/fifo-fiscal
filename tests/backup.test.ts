import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

process.env.FIFO_DB = ':memory:';
process.env.FIFO_BACKUP_DIR = mkdtempSync(join(tmpdir(), 'fifo-copias-'));
const db = await import('../server/db.ts');
const svc = await import('../server/service.ts');
const backup = await import('../server/backup.ts');
const { app } = await import('../server/app.ts');


const buy = (quantity: string) => {
  const total = `${Number(quantity) * 100}`;
  return svc.createOp({
    kind: 'buy', datetime: '2026-01-02T12:00:00', assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', quantity, unitPrice: '100',
    currency: 'EUR', fxRate: '1', grossLocal: total, grossEur: total, totalEur: total, broker: 'kraken',
  });
};
const day = (d: string) => new Date(`${d}T09:00:00`);

describe('Copias de seguridad', () => {
  it('guarda todas las cuentas y devuelve una a como estaba sin tocar las demás', async () => {
    const ana = db.createProfile('Ana');
    db.withProfile(ana.id, () => buy('1'));
    buy('5');
    const copy = await backup.makeBackup('manual', day('2026-03-10'));
    expect(copy).toMatchObject({ kind: 'manual', profiles: expect.arrayContaining(['default', ana.id]) });

    db.withProfile(ana.id, () => {
      svc.deleteOp(db.allOps()[0]!.id);
      buy('2');
      db.saveSettings({ ...db.getSettings(), lastFiledYear: 2024 });
    });
    buy('7');
    await db.withProfile(ana.id, () => backup.restoreBackup(copy.id));

    db.withProfile(ana.id, () => {
      expect(db.allOps().map((o) => o.quantity)).toEqual(['1']);
      expect(db.getSettings().lastFiledYear ?? null).toBeNull();
    });
    // La otra cuenta sigue como estaba.
    expect(db.allOps().map((o) => o.quantity).sort()).toEqual(['5', '7']);
    // Antes de restaurar guarda cómo estaba.
    const before = backup.listBackups().find((b) => b.kind === 'antes-de-restaurar')!;
    await db.withProfile(ana.id, () => backup.restoreBackup(before.id));
    db.withProfile(ana.id, () => expect(db.allOps().map((o) => o.quantity)).toEqual(['2']));
  }, 30_000);

  it('hace una al día y conserva la última de cada día de la semana y de cada mes', async () => {
    rmSync(process.env.FIFO_BACKUP_DIR!, { recursive: true, force: true });
    for (let d = 25; d <= 40; d++) {
      const date = new Date(Date.UTC(2026, 3, d)).toISOString().slice(0, 10);
      expect(await backup.ensureDailyBackup(day(date))).not.toBeNull();
    }
    const daily = backup.listBackups().filter((b) => b.kind === 'daily').map((b) => b.at.slice(0, 10));
    // Los 7 días más recientes y la última de abril.
    expect(daily).toEqual(['2026-05-10', '2026-05-09', '2026-05-08', '2026-05-07', '2026-05-06', '2026-05-05', '2026-05-04', '2026-04-30']);
    expect(await backup.ensureDailyBackup(day('2026-05-10'))).toBeNull();
    expect(readdirSync(process.env.FIFO_BACKUP_DIR!).filter((n) => n.startsWith('.'))).toEqual([]);
  }, 30_000);

  it('restaura la copia de hoy aunque la de antes de restaurar sea del mismo día', async () => {
    rmSync(process.env.FIFO_BACKUP_DIR!, { recursive: true, force: true });
    const today = await backup.makeBackup('daily');
    buy('3');
    await backup.restoreBackup(today.id);
    expect(backup.listBackups().map((b) => b.kind).sort()).toEqual(['antes-de-restaurar', 'daily']);
    expect(db.allOps().map((o) => o.quantity)).not.toContain('3');
  });

  it('se consulta y se restaura desde la API', async () => {
    const request = (path: string, method = 'GET') => app.request(`http://127.0.0.1${path}`, { method, headers: { Host: '127.0.0.1', 'X-Fifo-Profile': 'default' } });
    const list = await (await request('/api/backups')).json();
    expect(list.items.length).toBeGreaterThan(0);
    const bad = await request('/api/backups/2026-01-01_00-00-00/restore', 'POST');
    expect(bad.status).toBe(422);
    expect((await bad.json()).error).toBe('No encuentro esa copia.');
  });
});
