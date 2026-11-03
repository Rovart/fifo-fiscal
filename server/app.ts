import { Hono } from 'hono';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reconcile } from '../shared/reconcile.ts';
import type { Asset, Operation, Settings } from '../shared/types.ts';
import { D } from '../shared/decimal.ts';
import { fifoOperations } from '../shared/fifo-start.ts';
import { ProfileError, allOps, createProfile, currentProfileId, getHistory, getOp, getSettings, latestRateDate, listAssets, listProfiles, profileDbPath, rateAt, renameProfile, saveAsset, saveSettings, withProfile } from './db.ts';
import { isNeutralFx } from './engine/report.ts';
import { fifoHistory } from './engine/history.ts';
import { runEngine } from './engine/fifo.ts';
import { exportYear } from './export.ts';
import { performance, refreshPriceHistory } from './history.ts';
import { refreshQuotes, storedQuotes } from './quotes.ts';
import { resolutionRunning, scheduleResolution } from './resolution.ts';
import {
  ValidationError, assetsMap, brokerNames, calculationOps, checks, commitImport, confirmReview, countMissingValues, createOp, deleteOp, engine, pendingByYear, previewImport, priceEur, refreshEcbRates, report, resolveCryptoValues,
  listImports, removeBrokerImports, restoreDeleted, restoreOriginal, setAssetIsin, setDeclaredBalance, simulateSales, today, undoImport, updateOp, withAssetMeta,
} from './service.ts';

const here = dirname(fileURLToPath(import.meta.url));

export const app = new Hono();

// Solo este equipo: una web externa no debe poder leer ni tocar datos fiscales desde el navegador.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
app.use('/api/*', async (c, next) => {
  const host = c.req.header('host') ?? '';
  const origin = c.req.header('origin');
  if (!LOCAL_HOST.test(host)) return c.json({ error: 'Host no permitido' }, 403);
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return c.json({ error: 'Origen no permitido' }, 403);
  return withProfile(c.req.header('X-Fifo-Profile') ?? c.req.query('profile') ?? 'default', next);
});

app.onError((err, c) => {
  if (err instanceof ProfileError) return c.json({ error: err.message }, 422);
  if (err instanceof ValidationError) return c.json({ error: err.message, detail: err.detail }, 422);
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get('/api/profiles', (c) => c.json(listProfiles()));
app.get('/api/health', (c) => c.json({ app: 'fifo-fiscal' }));
app.post('/api/profiles', async (c) => c.json(createProfile((await c.req.json()).name), 201));
app.put('/api/profiles/:id', async (c) => c.json(renameProfile(c.req.param('id'), (await c.req.json()).name)));

app.get('/api/state', (c) => {
  scheduleResolution();
  const res = engine();
  const yearNow = Number(today().slice(0, 4));
  const ops = allOps();
  const years = [...new Set([...ops.map((o) => Number(o.datetime.slice(0, 4))), ...res.years, yearNow])].sort();
  // Un activo sin movimientos (por ejemplo, tras quitar un fichero) no debe seguir apareciendo.
  const used = new Set(ops.flatMap((o) => [o.assetId, o.counterAsset ?? '']));
  return c.json({
    profileId: currentProfileId(), profiles: listProfiles(), resolving: resolutionRunning(),
    settings: getSettings(), assets: listAssets().filter((a) => used.has(a.id)), years, today: today(), dbPath: relative(join(here, '..'), profileDbPath()) || profileDbPath(), latestRate: latestRateDate(),
    counts: { operations: ops.length, byYear: pendingByYear(), missingValues: countMissingValues() },
  });
});

app.get('/api/fifo/history', (c) => {
  const assets = assetsMap();
  const full = c.req.query('full') === '1';
  const settings = { ...getSettings(), ...(full ? { fifoStartDates: {}, fifoAutoStart: false } : {}) };
  const input = { ops: withAssetMeta(allOps(), assets), assets, settings, rateAt, today: today() };
  return c.json(fifoHistory(input, full ? runEngine(input) : engine()));
});

app.post('/api/fifo/recalculate', (c) => {
  saveSettings({ ...getSettings(), fifoAutoStart: true, fifoStartDates: {} });
  const result = engine();
  return c.json(result.fifoAuto);
});

app.get('/api/operations', (c) => {
  const q = c.req.query();
  const limit = Math.min(Number(q.limit ?? 200), 1000), offset = Number(q.offset ?? 0);
  const res = engine();
  const assets = assetsMap();
  const problem = new Map<string, string>();
  const calculated = new Map(calculationOps().map((o) => [o.id, o]));
  for (const i of res.issues) if (i.opId && i.severity !== 'info') problem.set(i.opId, i.severity);
  let ops = allOps(q.flag === 'deleted').filter((o) => (q.flag === 'deleted' ? o.deleted : true));
  if (q.year) ops = ops.filter((o) => o.datetime.startsWith(q.year as string));
  if (q.broker) ops = ops.filter((o) => o.broker === q.broker);
  if (q.kind) {
    const kinds = (q.kind as string).split(',');
    ops = ops.filter((o) => kinds.includes(o.kind));
  }
  if (q.asset) ops = ops.filter((o) => o.assetId === q.asset || o.counterAsset === q.asset);
  if (q.q) {
    const t = (q.q as string).toLowerCase();
    ops = ops.filter((o) => `${o.assetName} ${assets.get(o.assetId)?.name ?? ''} ${o.assetId} ${o.note ?? ''}`.toLowerCase().includes(t));
  }
  if (q.flag === 'review') ops = ops.filter((o) => calculated.get(o.id)?.reviewReasons?.length);
  if (q.flag === 'edited') ops = ops.filter((o) => o.edited);
  if (q.flag === 'errors') ops = ops.filter((o) => problem.get(o.id) === 'error');
  ops.reverse();
  return c.json({
    total: ops.length,
    items: withAssetMeta(ops.slice(offset, offset + limit), assets).map((o) => ({ ...o, _issue: problem.get(o.id) ?? null, _excluded: !calculated.has(o.id), _partial: !!calculated.get(o.id)?.fifoLeg })),
  });
});

app.get('/api/operations/:id', (c) => {
  const op = getOp(c.req.param('id'));
  return op ? c.json(withAssetMeta([op], assetsMap())[0]) : c.json({ error: 'No encontrada' }, 404);
});
app.post('/api/operations', async (c) => c.json(createOp((await c.req.json()) as Partial<Operation>)));
app.put('/api/operations/:id', async (c) => c.json(updateOp(c.req.param('id'), (await c.req.json()) as Partial<Operation>)));
app.delete('/api/operations/:id', (c) => { deleteOp(c.req.param('id')); return c.json({ ok: true }); });
app.post('/api/operations/:id/undelete', (c) => { restoreDeleted(c.req.param('id')); return c.json({ ok: true }); });
app.post('/api/operations/:id/restore', (c) => c.json(restoreOriginal(c.req.param('id'))));
app.post('/api/review/confirm', async (c) => {
  const b = (await c.req.json()) as { ids: string[]; reason?: string };
  return c.json({ confirmed: confirmReview(b.ids, b.reason) });
});
app.post('/api/review/resolve', (c) => { scheduleResolution(true); return c.json({ resolving: resolutionRunning() }); });
app.get('/api/operations/:id/history', (c) => c.json(getHistory(c.req.param('id'))));
app.post('/api/reconcile', async (c) => c.json(reconcile((await c.req.json()) as Operation, getSettings().toleranceEur)));

app.post('/api/import/preview', async (c) => {
  const { content } = (await c.req.json()) as { content: string };
  try {
    return c.json(previewImport(content).preview);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});
app.post('/api/import/commit', async (c) => {
  const { file, content } = (await c.req.json()) as { file: string; content: string };
  try {
    const result = commitImport(file, content);
    scheduleResolution(true);
    return c.json(result);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 422);
  }
});
app.get('/api/imports', (c) => c.json(listImports()));
app.delete('/api/imports/:id', (c) => c.json({ removed: undoImport(c.req.param('id')) }));
app.delete('/api/imports/broker/:broker', (c) => c.json({ removed: removeBrokerImports(c.req.param('broker')) }));

app.get('/api/report/:year', (c) => c.json(report(Number(c.req.param('year')))));
app.get('/api/disposals', (c) => {
  const y = Number(c.req.query('year'));
  const res = engine();
  const tranches = res.tranches.filter((t) => Number(t.originDate.slice(0, 4)) === y);
  return c.json({ items: res.disposals.filter((d) => d.year === y && !isNeutralFx(d)), tranches });
});
app.get('/api/incomes', (c) => {
  const y = Number(c.req.query('year'));
  const res = engine();
  return c.json({ incomes: res.incomes.filter((i) => i.year === y), fees: res.fees.filter((f) => f.year === y) });
});
app.get('/api/portfolio', (c) => {
  const res = engine();
  const balanceDifferences = checks().positions.filter((p) => p.broker === 'externo' && p.ok === false);
  return c.json({ lots: res.openLots, positions: res.positions, quotes: storedQuotes(), brokerNames: brokerNames(), today: today(), balanceDifferences });
});
app.get('/api/performance', (c) => c.json(performance()));
app.post('/api/performance/refresh', async (c) => {
  try { return c.json(await refreshPriceHistory()); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.post('/api/quotes/refresh', async (c) => {
  try { return c.json(await refreshQuotes()); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.get('/api/checks', (c) => {
  const y = Number(c.req.query('year'));
  return c.json(checks(Number.isFinite(y) && y > 0 ? y : undefined));
});
app.put('/api/balances', async (c) => {
  const b = (await c.req.json()) as { broker: string; assetId: string; quantity: string | null };
  setDeclaredBalance(b.broker, b.assetId, b.quantity);
  return c.json({ ok: true });
});

app.post('/api/simulate', async (c) => c.json(simulateSales((await c.req.json()) as Parameters<typeof simulateSales>[0])));

app.get('/api/settings', (c) => c.json(getSettings()));
app.put('/api/settings', async (c) => {
  const settings = (await c.req.json()) as Settings;
  if (settings.fifoAutoStart !== undefined && typeof settings.fifoAutoStart !== 'boolean') throw new ValidationError('Revisa el inicio automático del FIFO.', null);
  if (settings.fifoConfirmedClosures !== undefined && (!settings.fifoConfirmedClosures || typeof settings.fifoConfirmedClosures !== 'object' || Array.isArray(settings.fifoConfirmedClosures)
    || Object.entries(settings.fifoConfirmedClosures).some(([id, c]) => !/^[A-Z0-9._-]+$/.test(id) || !c || !/^\d{4}-(0[1-9]|1[0-2])$/.test(c.month) || typeof c.note !== 'string' || !c.note.trim()))) throw new ValidationError('Revisa los cierres de inventario confirmados.', null);
  const starts = settings.fifoStartDates;
  if (starts !== undefined && (!starts || typeof starts !== 'object' || Array.isArray(starts) || Object.entries(starts).some(([id, date]) => {
    if (!/^[A-Z0-9:*._-]+$/.test(id) || typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return true;
    const time = Date.parse(`${date}T12:00:00Z`);
    return !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date;
  }))) throw new ValidationError('Revisa las fechas de inicio del FIFO.', null);
  saveSettings({ ...getSettings(), ...settings });
  return c.json(getSettings());
});
app.post('/api/assets/:id/isin', async (c) => {
  const { isin } = (await c.req.json()) as { isin: string };
  setAssetIsin(c.req.param('id'), isin);
  return c.json({ ok: true });
});
app.put('/api/assets/:id', async (c) => { saveAsset((await c.req.json()) as Asset); return c.json({ ok: true }); });

app.post('/api/rates/refresh', async (c) => {
  try { return c.json(await refreshEcbRates()); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.get('/api/rates/:currency/:date', (c) => {
  const r = rateAt(c.req.param('currency'), c.req.param('date'));
  return c.json({ rate: r ? r.toFixed() : null });
});
app.post('/api/prices/resolve', async (c) => {
  try { return c.json(await resolveCryptoValues()); } catch (e) { return c.json({ error: (e as Error).message }, 502); }
});
app.get('/api/prices/:asset/:datetime', async (c) => {
  const p = await priceEur(c.req.param('asset'), c.req.param('datetime')).catch(() => null);
  return c.json({ price: p ? D(p).toFixed() : null });
});

app.get('/api/export/:year', async (c) => {
  const y = Number(c.req.param('year'));
  const data = await exportYear(y);
  return new Response(data as BodyInit, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="fifo-fiscal-${y}.xlsx"`,
    },
  });
});
