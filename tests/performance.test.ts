import { describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { runEngine } from '../server/engine/fifo.ts';
import { computePerformance, type PriceLookup } from '../server/engine/performance.ts';
import { ASSETS, trade } from './helpers.ts';

const APPLE = 'US0378331005';
const engine = (ops: Operation[], today: string) => runEngine({ ops, assets: ASSETS, settings: DEFAULT_SETTINGS, rateAt: () => null, today, monthly: true });
const book = (monthly: Record<string, string>, current?: string): PriceLookup => ({
  monthly: (id, m) => (id === APPLE && monthly[m] ? D(monthly[m] as string) : null),
  current: (id) => (id === APPLE && current ? D(current) : null),
});
const money = (s: string) => D(s).toNumber();

describe('Desempeño', () => {
  const ops = [trade('buy', '2024-01-02', '10', '100'), trade('sell', '2025-06-30', '4', '150')];
  const res = engine(ops, '2026-03-15');
  const p = computePerformance(res, ops, book({ '2024-12': '120', '2025-12': '130', '2026-02': '125' }, '110'), '2026-03-15');
  const y = (n: number) => p.years.find((x) => x.year === n)!;

  it('el resultado suma lo vendido y lo que cambia lo no vendido', () => {
    expect(y(2024)).toMatchObject({ realizedEur: '0.00', unrealizedEndEur: '200.00', unrealizedChangeEur: '200.00', resultEur: '200.00', valueEndEur: '1200.00', costEndEur: '1000.00' });
    // Vende 4 con 200 de ganancia; las 6 restantes pasan de +120 a +180 (cambio de −20 respecto a los +200).
    expect(y(2025)).toMatchObject({ realizedEur: '200.00', unrealizedEndEur: '180.00', unrealizedChangeEur: '-20.00', resultEur: '180.00' });
    // El año en curso usa el precio de hoy.
    expect(y(2026)).toMatchObject({ unrealizedEndEur: '60.00', unrealizedChangeEur: '-120.00', resultEur: '-120.00' });
    expect(money(p.totalResultEur)).toBe(260);
  });
  it('coincide con valor final menos inicial menos lo aportado', () => {
    // 2025: 780 − 1200 − (0 compras − 600 vendidas) = 180
    expect(money(y(2025).valueEndEur) - money(y(2024).valueEndEur) + 600).toBe(money(y(2025).resultEur));
  });
  it('la rentabilidad tiene en cuenta cuánto tiempo estuvo invertido el dinero', () => {
    const plain = [trade('buy', '2024-12-20', '10', '100')];
    const r = computePerformance(engine(plain, '2025-12-31'), plain, book({ '2024-12': '100', '2025-12': '110' }), '2025-12-31');
    expect(r.years.find((x) => x.year === 2025)!.returnPct).toBe('10.00');
    // 1.000 invertidos a mitad de año y 100 de ganancia: unos 500 de media, alrededor de un 20 %.
    const half = [trade('buy', '2025-07-02', '10', '100')];
    const h = computePerformance(engine(half, '2025-12-31'), half, book({ '2025-12': '110' }), '2025-12-31');
    expect(Number(h.years[0]!.returnPct)).toBeCloseTo(19.9, 0);
  });
  it('con mucho movimiento usa la media de lo invertido en lugar de una cifra sin sentido', () => {
    const busy = [trade('buy', '2025-01-02', '10', '100'), trade('sell', '2025-01-03', '10', '60'), trade('buy', '2025-12-30', '10', '50')];
    const r = computePerformance(engine(busy, '2025-12-31'), busy, book({ '2025-01': '60', '2025-12': '50' }), '2025-12-31');
    expect(Number(r.years[0]!.returnPct)).toBeGreaterThan(-100);
  });
  it('encadena las rentabilidades', () => {
    const plain = [trade('buy', '2024-12-20', '10', '100')];
    const r = computePerformance(engine(plain, '2026-12-31'), plain, book({ '2024-12': '100', '2025-12': '110', '2026-12': '121' }, '121'), '2026-12-31');
    expect(Number(r.totalReturnPct)).toBeCloseTo(21, 1);
  });
  it('lo vendido sin coste conocido no cuenta como ganancia', () => {
    const noBuy = [trade('sell', '2025-03-01', '5', '100')];
    const r = computePerformance(engine(noBuy, '2025-12-31'), noBuy, book({}), '2025-12-31');
    expect(r.years[0]).toMatchObject({ realizedEur: '0.00', resultEur: '0.00', unknownCostProceedsEur: '500.00', returnPct: null });
  });
  it('sin precio cuenta a su coste y lo indica', () => {
    const r = computePerformance(res, ops, book({}), '2026-03-15');
    expect(r.years.find((x) => x.year === 2024)).toMatchObject({ unrealizedEndEur: '0.00', resultEur: '0.00' });
    expect(r.missingPrices).toEqual(['Apple']);
  });
  it('usa el último precio de hasta dos meses antes si falta el del mes', () => {
    const r = computePerformance(res, ops, book({ '2024-10': '120' }), '2026-03-15');
    expect(r.years.find((x) => x.year === 2024)).toMatchObject({ unrealizedEndEur: '200.00' });
  });
  it('desglosa por activo y serie mensual', () => {
    expect(p.assets[0]).toMatchObject({ assetId: APPLE, assetName: 'Apple', class: 'stock' });
    expect(p.assets[0]!.years[2025]).toMatchObject({ realizedEur: '200.00', unrealizedEndEur: '180.00', unrealizedChangeEur: '-20.00', resultEur: '180.00', valueEndEur: '780.00' });
    expect(p.months[0]).toMatchObject({ month: '2024-01', costEur: '1000.00' });
    expect(p.months.at(-1)).toMatchObject({ month: '2026-03', valueEur: '660.00', costEur: '600.00' });
    expect(p.months.some((m) => m.month === '2025-06' && m.costEur === '600.00')).toBe(true);
  });
  it('sin pedirlo no calcula los cierres mensuales', () => {
    const r = runEngine({ ops, assets: ASSETS, settings: DEFAULT_SETTINGS, rateAt: () => null, today: '2026-03-15' });
    expect(r.monthly).toBeUndefined();
  });
});

describe('Desempeño: rentas por tipo', () => {
  it('desglosa dividendos, intereses, staking y recompensas sin cambiar el total', () => {
    const income = (kind: Operation['kind'], date: string, eur: string, extra: Partial<Operation> = {}): Operation =>
      ({ ...trade('buy', date, '0', '0'), kind, quantity: null, grossLocal: eur, grossEur: eur, totalEur: eur, ...extra });
    const ops: Operation[] = [
      trade('buy', '2026-01-02', '10', '100'), income('dividend', '2026-03-01', '16'),
      income('interest', '2026-04-01', '60.89', { assetId: 'TR-CASH', assetName: 'Intereses', assetClass: 'other' }),
      income('reward', '2026-01-16', '30.26', { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto', quantity: '0.0003680756' }),
    ];
    const year = computePerformance(engine(ops, '2026-11-03'), ops, book({}), '2026-11-03').years.find((x) => x.year === 2026)!;
    expect(year.incomeEur).toBe('107.15');
    expect(year.incomeByType).toEqual({ dividends: '16.00', interest: '60.89', staking: '0.00', rewards: '30.26', other: '0.00' });
  });
});
