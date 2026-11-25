import { beforeEach, describe, expect, it, vi } from 'vitest';
import { validIsin } from '../shared/review.ts';
import { SECURITIES } from '../server/securities.ts';

const mocks = vi.hoisted(() => ({ search: vi.fn(), quote: vi.fn(), chart: vi.fn(), engine: vi.fn() }));
vi.mock('yahoo-finance2', () => ({ default: class { search = mocks.search; quote = mocks.quote; chart = mocks.chart; } }));
vi.mock('../server/service.ts', () => ({ engine: mocks.engine, refreshEcbRates: async () => ({}), priceEur: async () => null, today: () => '2026-11-03' }));
process.env.FIFO_DB = ':memory:';
const { db, insertRates, putOp } = await import('../server/db.ts');
const { symbolCandidates, refreshQuotes, storedQuotes } = await import('../server/quotes.ts');

describe('Identificación y precios por bolsa', () => {
  beforeEach(() => { vi.clearAllMocks(); db.exec('DELETE FROM quotes'); mocks.search.mockResolvedValue({ quotes: [] }); });
  it('usa el ISIN y la clase exacta de los ETF verificados', async () => {
    for (const s of SECURITIES) {
      expect(validIsin(s.isin)).toBe(true);
      expect(await symbolCandidates(s.isin, s.name, 'etf')).toEqual(s.symbols);
      expect(await symbolCandidates(s.ticker, s.name, 'etf')).toEqual(s.symbols);
    }
    expect(mocks.search).not.toHaveBeenCalled();
  });
  it('descarta una cotización guardada de otra clase del ETF', async () => {
    const assetId = 'IE00BFM6TC58';
    mocks.engine.mockReturnValue({ positions: [{ assetId, assetName: 'iShares Treasury Acc', class: 'etf', quantity: '10' }] });
    db.prepare('INSERT INTO quotes (asset_id,symbol,price_eur) VALUES (?,?,?)').run(assetId, 'IS04.DE', '2.75');
    expect(storedQuotes()[assetId]).toBeUndefined();
    mocks.quote.mockResolvedValue({ regularMarketPrice: 4.5, currency: 'EUR' });
    await refreshQuotes();
    expect(mocks.quote.mock.calls.map(([symbol]) => symbol)).toEqual(['DTLA.L']);
    expect(storedQuotes()[assetId]).toMatchObject({ symbol: 'DTLA.L', priceEur: '4.50000000' });
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
  it('valora el OAT en euros por unidad nominal con el cupón corrido', async () => {
    mocks.engine.mockReturnValue({ positions: [{ assetId: 'FR0010070060', assetName: 'Apr. 2035', class: 'bond', quantity: '5820.78' }] });
    const fetch = vi.fn(async () => Response.json([
      { time: '2026-11-03 01:00', price: 100.5 },
      { time: '2026-11-04 01:00', price: 110 },
      { time: '2026-11-02 01:00', price: 100 },
    ]));
    vi.stubGlobal('fetch', fetch);
    try {
      expect(await refreshQuotes()).toMatchObject({ updated: 1, missing: [] });
      expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/FR0010070060-MOTX/1M'), expect.anything());
      expect(mocks.search).not.toHaveBeenCalled();
      expect(storedQuotes().FR0010070060).toMatchObject({ symbol: 'Euronext MOT', currency: 'EUR', priceEur: '1.02998630', at: '2026-11-03' });
    } finally { vi.unstubAllGlobals(); }
  });
  it('una cripto que Yahoo solo cotiza en dólares, como stETH, se pasa a euros al cambio del BCE', async () => {
    insertRates([{ date: '2026-11-03', currency: 'USD', rate: '1.25' }]);
    mocks.engine.mockReturnValue({ positions: [{ assetId: 'STETH', assetName: 'Lido Staked ETH', class: 'crypto', quantity: '1' }] });
    mocks.quote.mockImplementation(async (symbol) => symbol === 'STETH-USD' ? { regularMarketPrice: 2500, currency: 'USD' } : undefined);
    await refreshQuotes();
    expect(storedQuotes().STETH).toMatchObject({ symbol: 'STETH-USD', priceEur: '2000.00000000' });
  });

  it('pone lo que da el ISIN antes que lo encontrado por nombre, que puede ser otra clase', async () => {
    mocks.search.mockImplementation(async (query: string) => ({
      quotes: query === 'IE00B3VWN518' ? [{ symbol: 'CSBGU0.SW', quoteType: 'ETF' }] : [{ symbol: 'IDTM.L', quoteType: 'ETF' }, { symbol: 'IBTM.L', quoteType: 'ETF' }],
    }));
    expect(await symbolCandidates('IE00B3VWN518', 'ISHARES $ TREASURY BOND 7-10YR UCITS ETF USD (ACC)', 'etf')).toEqual(['CSBGU0.SW', 'IDTM.L', 'IBTM.L']);
  });

  it('descarta un símbolo cuyo precio no casa con tu última compra y quita el precio que dejó guardado', async () => {
    const assetId = 'IE00B3VWN518';
    insertRates(['2026-10-19', '2026-10-20'].map((date) => ({ date, currency: 'USD', rate: '1.0935' })));
    // 127 participaciones a unos 149,8 $ (137,01 €) el 20 de octubre.
    putOp({
      id: 'idtm-buy', broker: 'degiro', kind: 'buy', datetime: '2026-10-20T10:00:00', assetId, assetName: 'iShares $ Treasury 7-10yr Acc', assetClass: 'etf',
      quantity: '127', unitPrice: '149.8', currency: 'USD', fxRate: '1.0935', grossLocal: '19024.60', grossEur: '17399.94', feeEur: '0', otherCostsEur: '0', withholdingEur: '0',
      totalEur: '17399.94', settleCurrency: 'EUR',
    });
    mocks.engine.mockReturnValue({ positions: [{ assetId, assetName: 'iShares $ Treasury 7-10yr Acc', class: 'etf', quantity: '127' }] });
    mocks.search.mockImplementation(async (query: string) => ({ quotes: query === assetId ? [{ symbol: 'CSBGU0.SW', quoteType: 'ETF' }] : [{ symbol: 'IDTM.L', quoteType: 'ETF' }] }));
    const day = (d: string, low: number, high: number) => ({ date: new Date(`${d}T16:00:00Z`), low, high });
    // La clase de distribución cotiza un 9 % más cara que la de acumulación.
    mocks.chart.mockImplementation(async (symbol: string) => ({
      meta: { currency: 'USD' },
      quotes: symbol === 'IDTM.L' ? [day('2026-10-19', 163.1, 163.6), day('2026-10-20', 162.9, 163.5)] : [day('2026-10-19', 149.6, 150.2), day('2026-10-20', 149.5, 150.4)],
    }));
    mocks.quote.mockImplementation(async (symbol: string) => ({ regularMarketPrice: symbol === 'IDTM.L' ? 166.33 : 153.75, currency: 'USD' }));
    db.prepare('INSERT INTO quotes (asset_id,symbol,currency,price,price_eur) VALUES (?,?,?,?,?)').run(assetId, 'IDTM.L', 'USD', '166.33', '152.10791038');

    await refreshQuotes();
    expect(storedQuotes()[assetId]).toMatchObject({ symbol: 'CSBGU0.SW', price: '153.75' });

    // Si ningún símbolo casa, mejor sin precio que con el de otra clase.
    db.prepare('UPDATE quotes SET symbol = ?, price_eur = ? WHERE asset_id = ?').run('IDTM.L', '152.10791038', assetId);
    mocks.search.mockResolvedValue({ quotes: [] });
    expect(await refreshQuotes()).toMatchObject({ missing: ['iShares $ Treasury 7-10yr Acc'] });
    expect(storedQuotes()[assetId]).toMatchObject({ symbol: null, priceEur: null });
  });
});
