import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validIsin } from '../shared/review.ts';
import { SECURITIES } from '../server/securities.ts';

const mocks = vi.hoisted(() => ({ search: vi.fn(), quote: vi.fn(), engine: vi.fn() }));
vi.mock('yahoo-finance2', () => ({ default: class { search = mocks.search; quote = mocks.quote; } }));
vi.mock('../server/service.ts', () => ({ engine: mocks.engine, refreshEcbRates: async () => ({}), priceEur: async () => null, today: () => '2026-11-03' }));
process.env.FIFO_DB = ':memory:';
const { db, insertRates } = await import('../server/db.ts');
const { symbolCandidates, refreshQuotes, storedQuotes } = await import('../server/quotes.ts');

describe('Identificación y precios por bolsa', () => {
  beforeEach(() => { vi.clearAllMocks(); db.exec('DELETE FROM quotes'); mocks.search.mockResolvedValue({ quotes: [] }); });
  it('usa el ISIN y la clase exacta de los cuatro ETF europeos', async () => {
    for (const s of SECURITIES) {
      expect(validIsin(s.isin)).toBe(true);
      expect(await symbolCandidates(s.isin, s.name, 'etf')).toEqual(s.symbols);
      expect(await symbolCandidates(s.ticker, s.name, 'etf')).toEqual(s.symbols);
    }
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('busca sufijos de bolsa sin aceptar otros tickers parecidos', async () => {
    mocks.search.mockResolvedValue({ quotes: [{ symbol: 'EURO.DE', quoteType: 'ETF' }, { symbol: 'EURO.L', quoteType: 'ETF' }, { symbol: 'EUROX.DE', quoteType: 'ETF' }] });
    expect(await symbolCandidates('EURO', 'EURO', 'etf')).toEqual(['EURO', 'EURO.DE', 'EURO.L']);
  });
  it('recupera un precio aunque falle el ticker sin sufijo y una caché anterior no tuviera precio', async () => {
    mocks.engine.mockReturnValue({ positions: [{ assetId: 'EURO', assetName: 'ETF europeo', class: 'etf', quantity: '2' }] });
    mocks.search.mockResolvedValue({ quotes: [{ symbol: 'EURO.DE', quoteType: 'ETF' }] });
    mocks.quote.mockImplementation(async (symbol) => symbol === 'EURO.DE' ? { regularMarketPrice: 120, currency: 'EUR' } : undefined);
    db.prepare('INSERT INTO quotes (asset_id,symbol) VALUES (?,?)').run('EURO', 'EURO');
    expect(await refreshQuotes()).toMatchObject({ updated: 1, missing: [] });
    expect(storedQuotes().EURO).toMatchObject({ symbol: 'EURO.DE', priceEur: '120.00000000' });
  });
  it('convierte peniques a libras antes de convertir a euros', async () => {
    insertRates([{ date: '2026-11-03', currency: 'GBP', rate: '0.8' }]);
    mocks.engine.mockReturnValue({ positions: [{ assetId: 'TEST.L', assetName: 'Valor británico', class: 'stock', quantity: '1' }] });
    mocks.quote.mockResolvedValue({ regularMarketPrice: 800, currency: 'GBp' });
    await refreshQuotes();
    expect(storedQuotes()['TEST.L']).toMatchObject({ currency: 'GBP', price: '8', priceEur: '10.00000000' });
  });
});
