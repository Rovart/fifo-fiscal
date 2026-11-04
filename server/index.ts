import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app } from './app.ts';
import { startBackups } from './backup.ts';
import { DB_PATH, listProfiles, seedRatesIfEmpty, withProfile } from './db.ts';
import { enableAutoResolution, scheduleResolution } from './resolution.ts';

const PORT = Number(process.env.PORT ?? 5199);
const here = dirname(fileURLToPath(import.meta.url));
seedRatesIfEmpty();
enableAutoResolution();
for (const profile of listProfiles()) withProfile(profile.id, () => scheduleResolution());
startBackups();

const devMode = process.argv.includes('--dev');
const dist = join(here, '..', 'dist');
if (!devMode && existsSync(dist)) {
  const root = relative(process.cwd(), dist) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ path: join(root, 'index.html') }));
}

serve({ fetch: app.fetch, port: PORT, hostname: '127.0.0.1' }, () => {
  if (!devMode) console.log(`FIFO Fiscal en http://127.0.0.1:${PORT}  (datos: ${DB_PATH})`);
});

if (devMode) {
  const { createServer } = await import('vite');
  const vite = await createServer({
    configFile: join(here, '..', 'vite.config.ts'),
    server: { port: 5173, strictPort: false, proxy: { '/api': `http://127.0.0.1:${PORT}` } },
  });
  await vite.listen();
  vite.printUrls();
}
