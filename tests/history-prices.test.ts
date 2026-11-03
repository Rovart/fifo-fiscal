import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trade } from './helpers.ts';

const mocks = vi.hoisted(() => ({ chart: vi.fn(), candidates: vi.fn() }));
vi.mock('../server/quotes.ts', () => ({ refreshQuotes: async () => ({}), storedQuotes: () => ({}), symbolCandidates: mocks.candidates, yf: { chart: mocks.chart } }));
process.env.FIFO_DB = ':memory:';
const { db, putOp, saveAsset } = await import('../server/db.ts');
const { refreshPriceHistory } = await import('../server/history.ts');

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
  it('deshace también splits posteriores al cierre de una posición antigua', async () => {
    insert(); putOp(trade('sell', '2025-03-01', '1', '120', { assetId: 'EURO' }));
    mocks.candidates.mockResolvedValue(['EURO.DE']);
    mocks.chart.mockResolvedValue({ meta: { currency: 'EUR' }, quotes: [{ date: '2025-01-01', close: 10 }], events: { splits: [{ date: '2026-01-01', numerator: 10, denominator: 1 }] } });
    await refreshPriceHistory();
    expect(mocks.chart.mock.calls[0]![1].period2 >= '2026-11-01').toBe(true);
    expect(db.prepare('SELECT price_eur FROM price_history WHERE asset_id = ? AND month = ?').get('EURO', '2025-01')).toMatchObject({ price_eur: '100.00000000' });
  });
});
