import { describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import type { Position } from '../shared/types.ts';
import type { PortfolioQuote } from '../client/src/api.ts';
import { holdings, isZeroPosition } from '../client/src/holdings.ts';
import { ASSETS, run, trade } from './helpers.ts';

const quote = (priceEur: string | null, symbol: string | null = null): PortfolioQuote => ({
  priceEur, symbol, currency: 'EUR', price: priceEur, at: null, fetchedAt: null,
});
const position = (assetId: string, quantity: string, costEur: string, extra: Partial<Position> = {}): Position => ({
  assetId, assetName: assetId, quantity, costEur, class: 'stock', byBroker: {}, ...extra,
});

describe('Cartera de consulta', () => {
  it('muestra las unidades que quedan entre brókers y usa su coste FIFO después de vender', () => {
    const { positions } = run([
      trade('buy', '2024-01-01', '10', '100'),
      trade('buy', '2024-02-01', '10', '200', { broker: 'revolut' }),
      trade('sell', '2024-03-01', '5', '130'),
    ]);
    const result = holdings(positions, { US0378331005: quote('200', 'AAPL') }, [...ASSETS.values()]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].position.quantity).toBe('15');
    expect(D(result.rows[0].position.costEur).eq(2500)).toBe(true);
    expect(result.rows[0].ticker).toBe('AAPL');
    expect(result.rows[0].valueEur).toBe('3000');
    expect(result.rows[0].gainPercent).toBe('20');
    expect(result.gainPercent).toBe('20');
  });

  it('pondera la ganancia total por coste y no promedia los porcentajes', () => {
    const result = holdings([position('BIG', '10', '1000'), position('SMALL', '1', '100')], {
      BIG: quote('110'), SMALL: quote('50'),
    }, []);
    expect(result.rows.find((r) => r.ticker === 'BIG')?.gainPercent).toBe('10');
    expect(result.rows.find((r) => r.ticker === 'SMALL')?.gainPercent).toBe('-50');
    expect(result.valueEur).toBe('1150');
    expect(D(result.gainPercent).toFixed(2)).toBe('4.55');
  });

  it('ordena por valor total en euros de mayor a menor y deja al final los activos sin precio', () => {
    const result = holdings([
      position('NO_PRICE', '10', '100'), position('ZERO', '1', '100'),
      position('EXPENSIVE_UNIT', '1', '100'), position('BIG_POSITION', '20', '100'),
      position('B_TIE', '2', '100'), position('A_TIE', '1', '100'),
    ], {
      ZERO: quote('0'), EXPENSIVE_UNIT: quote('100'), BIG_POSITION: quote('20'),
      B_TIE: quote('10'), A_TIE: quote('20'),
    }, []);
    expect(result.rows.map((row) => [row.ticker, row.valueEur])).toEqual([
      ['BIG_POSITION', '400'], ['EXPENSIVE_UNIT', '100'],
      ['A_TIE', '20'], ['B_TIE', '20'], ['ZERO', '0'], ['NO_PRICE', null],
    ]);
  });

  it('conserva activos sin precio o coste y no presenta un porcentaje parcial como total', () => {
    const result = holdings([position('PRICED', '1', '100'), position('UNKNOWN', '12', '0')], {
      PRICED: quote('120'),
    }, []);
    expect(result.rows).toHaveLength(2);
    expect(result.unpriced).toBe(1);
    expect(result.valueEur).toBe('120');
    expect(result.rows.find((r) => r.ticker === 'UNKNOWN')?.gainPercent).toBeNull();
    expect(result.gainPercent).toBeNull();
    const zeroCost = holdings([position('FREE', '1', '0')], { FREE: quote('100') }, []);
    expect(zeroCost.rows[0].gainPercent).toBeNull();
    expect(zeroCost.gainPercent).toBeNull();
  });

  it('admite una pérdida del 100 % y precios no disponibles sin producir NaN', () => {
    expect(holdings([position('ZERO', '1', '100')], { ZERO: quote('0') }, []).gainPercent).toBe('-100');
    for (const price of [null, '-1', 'NaN', 'Infinity']) {
      const result = holdings([position('MISSING', '1', '100')], { MISSING: quote(price) }, []);
      expect(result.valueEur).toBeNull();
      expect(result.gainPercent).toBeNull();
    }
  });

  it('no incluye posiciones cerradas, divisas ni restos, pero conserva fracciones valiosas', () => {
    const result = holdings([
      position('CLOSED', '0', '0'), position('SOLD', '-1', '0'),
      position('FX:USD', '100', '90', { class: 'fx' }),
      position('DUST', '0.00001', '0'),
      position('BTC', '0.00001', '0', { class: 'crypto' }),
    ], { DUST: quote('0.1'), BTC: quote('100000') }, []);
    expect(result.rows.map((r) => r.ticker)).toEqual(['BTC']);
    expect(result.valueEur).toBe('1');
    expect(isZeroPosition(position('UNKNOWN', '10', '0'))).toBe(false);
  });

  it('usa tickers conocidos y no confunde un proveedor ni un ISIN con un ticker', () => {
    const result = holdings([
      position('BTC', '1', '100', { class: 'crypto' }),
      position('US0378331005', '1', '100'),
      position('IE00BFMXXD54', '1', '100'),
      position('ES0113900J37', '1', '100'),
    ], { BTC: quote('200', 'Kraken'), US0378331005: quote('120', 'AAPL'), IE00BFMXXD54: quote('150', 'VUAA.DE') }, [
      { id: 'IE00BFMXXD54', name: 'Vanguard', class: 'etf', market: 'eu', ticker: 'VUAA' },
    ]);
    const tickers = Object.fromEntries(result.rows.map((row) => [row.position.assetId, row.ticker]));
    expect(tickers).toEqual({ BTC: 'BTC', US0378331005: 'AAPL', IE00BFMXXD54: 'VUAA', ES0113900J37: null });
  });
});
