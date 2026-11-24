import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trade } from './helpers.ts';

const mocks = vi.hoisted(() => ({ chart: vi.fn(), candidates: vi.fn() }));
vi.mock('../server/quotes.ts', () => ({ refreshQuotes: async () => ({}), storedQuotes: () => ({}), symbolCandidates: mocks.candidates, yf: { chart: mocks.chart } }));
process.env.FIFO_DB = ':memory:';
const { db, putOp, saveAsset } = await import('../server/db.ts');
const { performance, refreshPriceHistory } = await import('../server/history.ts');

describe('Cobertura del histórico de precios', () => {
  beforeEach(() => { db.exec('DELETE FROM operations; DELETE FROM price_history; DELETE FROM price_symbols; DELETE FROM assets'); vi.clearAllMocks(); });
  const insert = () => { putOp(trade('buy', '2025-01-02', '1', '100', { assetId: 'EURO' })); saveAsset({ id: 'EURO', name: 'ETF europeo', class: 'etf', market: 'eu' }); };
  it('prefiere una bolsa con histórico completo a una que solo devuelve la cotización de hoy', async () => {
    insert();
    mocks.candidates.mockResolvedValue(['EURO.DU', 'EURO.L']);
    mocks.chart.mockImplementation(async (symbol) => ({ meta: { currency: 'EUR' }, quotes: symbol === 'EURO.DU' ? [{ date: '2026-11-03', close: 110 }] : [{ date: '2024-12-31T23:00:00Z', close: 100 }, { date: '2025-01-31T23:00:00Z', close: 105 }, { date: '2026-11-03', close: 110 }] }));
    await refreshPriceHistory();
    expect(db.prepare('SELECT symbol FROM price_symbols WHERE asset_id = ?').get('EURO')).toMatchObject({ symbol: 'EURO.L' });
    expect(db.prepare('SELECT price_eur FROM price_history WHERE asset_id = ? AND month = ?').get('EURO', '2025-01')).toMatchObject({ price_eur: '100.00000000' });
  });
  it('rehace una búsqueda cuando el símbolo recordado dejó de dar datos', async () => {
    insert(); db.prepare('INSERT INTO price_symbols VALUES (?,?,?)').run('EURO', 'OLD', '2025-01-01');
    mocks.candidates.mockResolvedValue(['EURO.DE']);
    mocks.chart.mockImplementation(async (symbol) => ({ meta: { currency: 'EUR' }, quotes: symbol === 'OLD' ? [] : [{ date: '2025-01-01', close: 100 }] }));
    await refreshPriceHistory();
    expect(db.prepare('SELECT symbol FROM price_symbols WHERE asset_id = ?').get('EURO')).toMatchObject({ symbol: 'EURO.DE' });
  });
  it('ignora y sustituye la serie de una clase distinta aunque tenga más meses', async () => {
    const assetId = 'IE00BFM6TC58';
    putOp(trade('buy', '2025-10-03', '100', '4', { assetId, assetName: 'iShares Treasury Acc', assetClass: 'etf' }));
    db.prepare('INSERT INTO price_symbols VALUES (?,?,?)').run(assetId, 'IS04.DE', '2026-01-01');
    db.prepare('INSERT INTO price_history VALUES (?,?,?)').run(assetId, '2025-12', '2.75');
    expect(performance().assets.find((a) => a.assetId === assetId)?.years[2025]?.valueEndEur).toBe('400.00');

    mocks.candidates.mockResolvedValue(['DTLA.L']);
    mocks.chart.mockResolvedValue({ meta: { currency: 'EUR' }, quotes: [{ date: '2025-11-01', close: 4.2 }] });
    await refreshPriceHistory();
    expect(mocks.chart.mock.calls.map(([symbol]) => symbol)).toEqual(['DTLA.L']);
    expect(db.prepare('SELECT month, price_eur FROM price_history WHERE asset_id = ?').all(assetId)).toEqual([{ month: '2025-11', price_eur: '4.20000000' }]);
    expect(performance().assets.find((a) => a.assetId === assetId)?.years[2025]?.valueEndEur).toBe('420.00');
  });
  it('guarda como cierre del OAT su última cotización válida del mes con cupón corrido', async () => {
    const assetId = 'FR0010070060';
    putOp(trade('buy', '2025-12-11', '100', '1', { assetId, assetName: 'Apr. 2035', assetClass: 'bond' }));
    const fetch = vi.fn(async () => Response.json([
      { time: '2025-12-31 01:00', price: 100.75 },
      { time: '2025-11-28 01:00', price: 100.25 },
      { time: '2025-12-29 01:00', price: 100.5 },
      { time: '2025-12-32 01:00', price: 120 },
    ]));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await refreshPriceHistory()).toMatchObject({ assets: 1, missing: [] });
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/FR0010070060-MOTX/max'), expect.anything());
      expect(mocks.chart).not.toHaveBeenCalled();
      expect(db.prepare('SELECT month, price_eur FROM price_history WHERE asset_id = ?').all(assetId)).toEqual([{ month: '2025-12', price_eur: '1.04003425' }]);
    } finally { vi.unstubAllGlobals(); }
  });
  it('completa con Kraken los meses de cripto sin precio en Yahoo y recuerda los que no tienen operaciones', async () => {
    db.exec('DELETE FROM price_gaps');
    putOp(trade('buy', '2016-06-10', '1', '10', { assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', broker: 'kraken' }));
    putOp(trade('sell', '2016-08-05', '1', '12', { assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto', broker: 'kraken' }));
    saveAsset({ id: 'ETH', name: 'Ethereum', class: 'crypto', market: 'other' });
    mocks.candidates.mockResolvedValue([]);
    const july = Date.parse('2016-07-31T21:00:00Z') / 1000;
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('AssetPairs')) return Response.json({ error: [], result: { XETHZEUR: { altname: 'ETHEUR' }, XETHZUSD: { altname: 'ETHUSD' } } });
      const since = Number(new URL(url).searchParams.get('since'));
      // Junio tiene operaciones al cierre; julio, no hasta días después.
      const time = since >= july ? since + 3 * 86400 : since + 600;
      return Response.json({ error: [], result: { XETHZEUR: [['11.5', '1', time]], last: '0' } });
    });
    vi.stubGlobal('fetch', fetch);
    try {
      await refreshPriceHistory();
      expect(db.prepare('SELECT month, price_eur FROM price_history WHERE asset_id = ?').all('ETH')).toEqual([{ month: '2016-06', price_eur: '11.50000000' }]);
      expect(db.prepare('SELECT month FROM price_gaps WHERE asset_id = ?').all('ETH')).toEqual([{ month: '2016-07' }]);
      const calls = fetch.mock.calls.length;
      await refreshPriceHistory();
      expect(fetch.mock.calls.length).toBe(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  }, 20_000);
  it('deshace también splits posteriores al cierre de una posición antigua', async () => {
    insert(); putOp(trade('sell', '2025-03-01', '1', '120', { assetId: 'EURO' }));
    mocks.candidates.mockResolvedValue(['EURO.DE']);
    mocks.chart.mockResolvedValue({ meta: { currency: 'EUR' }, quotes: [{ date: '2025-01-01', close: 10 }], events: { splits: [{ date: '2026-01-01', numerator: 10, denominator: 1 }] } });
    await refreshPriceHistory();
    expect(mocks.chart.mock.calls[0]![1].period2 >= '2026-11-01').toBe(true);
    expect(db.prepare('SELECT price_eur FROM price_history WHERE asset_id = ? AND month = ?').get('EURO', '2025-01')).toMatchObject({ price_eur: '100.00000000' });
  });
});
