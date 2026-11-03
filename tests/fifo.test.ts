import { describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { buildYearReport, issuesForYear } from '../server/engine/report.ts';
import { DEFAULT_SETTINGS, type Operation } from '../shared/types.ts';
import { run, trade } from './helpers.ts';

const money = (s: string) => D(s).toDecimalPlaces(2).toNumber();

describe('FIFO', () => {
  it('consume primero lo más antiguo y reparte coste y comisiones', () => {
    const r = run([
      trade('buy', '2024-01-10', '10', '100', { feeEur: '2' }),
      trade('buy', '2024-06-10', '10', '200', { feeEur: '4' }),
      trade('sell', '2025-03-10', '15', '300', { feeEur: '3' }),
    ]);
    const d = r.disposals[0]!;
    expect(d.matches.map((m) => m.acqDate.slice(0, 10))).toEqual(['2024-01-10', '2024-06-10']);
    expect(money(d.matches[0]!.costEur)).toBe(1002);
    expect(money(d.matches[1]!.costEur)).toBe(1002);
    expect(money(d.costEur)).toBe(2004);
    expect(money(d.proceedsEur)).toBe(4497);
    expect(money(d.gainEur)).toBe(2493);
    expect(r.openLots).toHaveLength(1);
    expect(r.openLots[0]!.quantity).toBe('5');
    expect(money(r.openLots[0]!.costEur)).toBe(1002);
  });

  it('el FIFO es global: compras en un bróker y venta en otro', () => {
    const r = run([
      trade('buy', '2023-01-02', '1', '20000', { broker: 'kraken', assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' }),
      trade('buy', '2024-01-02', '1', '40000', { broker: 'trade_republic', assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' }),
      trade('sell', '2025-01-02', '1', '90000', { broker: 'trade_republic', assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' }),
    ]);
    expect(money(r.disposals[0]!.costEur)).toBe(20000);
    expect(r.disposals[0]!.clave).toBe('F');
  });

  it('avisa si se vende más de lo comprado', () => {
    const r = run([trade('sell', '2025-01-02', '1', '100')]);
    expect(r.disposals[0]!.shortfall).toBe('1');
    expect(r.issues.some((i) => i.code === 'missing_lots' && i.severity === 'error')).toBe(true);
  });

  it('split y liberadas conservan coste y fecha', () => {
    const split: Operation = { ...trade('buy', '2024-06-01', '10', '0'), kind: 'split', unitPrice: null, grossLocal: null, grossEur: null, totalEur: null };
    const r = run([trade('buy', '2024-01-10', '10', '100'), split, trade('sell', '2025-01-10', '20', '60')]);
    expect(money(r.disposals[0]!.costEur)).toBe(1000);
    expect(r.disposals[0]!.matches[0]!.acqDate.slice(0, 10)).toBe('2024-01-10');
    expect(money(r.disposals[0]!.gainEur)).toBe(200);
  });

  it('el canje traslada lotes con su fecha y coste al nuevo ISIN', () => {
    const canje: Operation = {
      ...trade('buy', '2024-06-01', '10', '0'), kind: 'isin_change', counterAsset: 'NEWISIN00001', counterName: 'Apple nueva', counterQuantity: '5',
      unitPrice: null, grossLocal: null, grossEur: null, totalEur: null,
    };
    const r = run([
      trade('buy', '2024-01-10', '10', '100'), canje,
      trade('sell', '2025-01-10', '5', '300', { assetId: 'NEWISIN00001', assetName: 'Apple nueva' }),
    ]);
    expect(money(r.disposals[0]!.costEur)).toBe(1000);
    expect(money(r.disposals[0]!.gainEur)).toBe(500);
  });
});

describe('Recompra de valores homogéneos (art. 33.5.f)', () => {
  const statuses = (r: ReturnType<typeof run>) => r.tranches.map((t) => [t.status, money(t.amountEur)]);

  it('sin recompra la pérdida se integra', () => {
    const r = run([trade('buy', '2024-01-10', '100', '10'), trade('sell', '2025-03-15', '100', '8')]);
    expect(statuses(r)).toEqual([['integrated', 200]]);
    expect(r.tranches[0]!.year).toBe(2025);
  });

  it('una compra posterior dentro de plazo bloquea y la venta definitiva libera', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '10'),
      trade('sell', '2025-03-15', '100', '8'),
      trade('buy', '2025-05-15', '100', '8'),
      trade('sell', '2026-01-15', '100', '9'),
    ]);
    expect(statuses(r)).toEqual([['integrated', 200]]);
    expect(r.tranches[0]!.year).toBe(2026);
    const rep25 = buildYearReport(r, DEFAULT_SETTINGS, 2025);
    expect(rep25.sections[0]!.lossComputableTotal).toBe('0.00');
    expect(rep25.deferred.generated).toBe('200.00');
    const rep26 = buildYearReport(r, DEFAULT_SETTINGS, 2026);
    expect(rep26.deferred.released).toBe('200.00');
    expect(rep26.savings.gppBalance).toBe('-100.00');
  });

  it('un día después del plazo no bloquea', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '10'),
      trade('sell', '2025-03-15', '100', '8'),
      trade('buy', '2025-05-16', '100', '8'),
    ]);
    expect(statuses(r)).toEqual([['integrated', 200]]);
    expect(r.tranches[0]!.year).toBe(2025);
  });

  it('recompra parcial: difiere solo la parte recomprada y libera a medida que se vende', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '20'),
      trade('sell', '2026-03-15', '100', '10'),
      trade('buy', '2026-04-01', '40', '10'),
      trade('sell', '2027-02-01', '20', '11'),
    ]);
    const by = (s: string) => r.tranches.filter((t) => t.status === s).reduce((a, t) => a + money(t.amountEur), 0);
    expect(by('integrated')).toBe(800);
    expect(by('blocked')).toBe(200);
    const y = r.tranches.filter((t) => t.status === 'integrated').map((t) => [t.year, money(t.amountEur)]).sort();
    expect(y).toEqual([[2026, 600], [2027, 200]]);
  });

  it('compras en los dos meses anteriores que siguen en cartera bloquean', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '10'),
      trade('buy', '2025-02-01', '50', '8'),
      trade('sell', '2025-03-01', '100', '8'),
    ]);
    expect(statuses(r)).toEqual([['blocked', 100], ['integrated', 100]].sort((a, b) => String(a[0]).localeCompare(String(b[0]))).reverse());
  });

  it('una compra del mismo día, antes de la venta, también bloquea', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '10'),
      { ...trade('buy', '2025-03-01', '100', '8'), datetime: '2025-03-01T09:00:00' },
      { ...trade('sell', '2025-03-01', '100', '8'), datetime: '2025-03-01T15:00:00' },
    ]);
    expect(statuses(r)).toEqual([['blocked', 200]]);
  });

  it('el número recomprado se limita a lo que queda tras la venta', () => {
    const r = run([
      trade('buy', '2025-01-20', '100', '10'),
      trade('buy', '2025-02-01', '100', '10'),
      trade('sell', '2025-03-01', '150', '8'),
    ]);
    const blocked = r.tranches.filter((t) => t.status === 'blocked');
    expect(blocked.reduce((a, t) => a + Number(t.quantity), 0)).toBe(50);
  });

  it('excepción AEAT: una sola compra en el periodo y sin valores al inicio', () => {
    const r = run([trade('buy', '2025-02-01', '100', '10'), trade('sell', '2025-03-01', '50', '8')]);
    expect(statuses(r)).toEqual([['integrated', 100]]);
  });

  it('la excepción no ampara una compra posterior', () => {
    const r = run([trade('buy', '2025-02-01', '100', '10'), trade('sell', '2025-03-01', '100', '8'), trade('buy', '2025-03-20', '100', '8')]);
    expect(statuses(r)).toEqual([['blocked', 200]]);
  });

  it('venta no definitiva: la pérdida pasa a la nueva compra', () => {
    const r = run([
      trade('buy', '2024-01-10', '100', '10'),
      trade('sell', '2025-03-15', '100', '8'),
      trade('buy', '2025-04-01', '100', '8'),
      trade('sell', '2025-10-01', '100', '8'),
      trade('buy', '2025-11-01', '100', '8'),
    ]);
    expect(statuses(r)).toEqual([['blocked', 200]]);
    expect(r.tranches[0]!.blockerDate?.slice(0, 10)).toBe('2025-11-01');
  });

  it('plazo de un año para valores de otros mercados', () => {
    const ops = [trade('buy', '2024-01-10', '100', '10'), trade('sell', '2025-03-15', '100', '8'), trade('buy', '2025-12-01', '100', '8')];
    const r = run(ops.map((o) => ({ ...o, assetId: 'XX1', assetName: 'X' })), { washMonths: { eu: 12, us: 2, other: 12 } });
    expect(statuses(r)).toEqual([['blocked', 200]]);
  });

  it('no se aplica a cripto', () => {
    const crypto = { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' as const };
    const r = run([
      trade('buy', '2024-01-10', '1', '50000', crypto),
      trade('sell', '2025-03-15', '1', '40000', crypto),
      trade('buy', '2025-03-16', '1', '40000', crypto),
    ]);
    expect(r.tranches).toHaveLength(0);
    expect(money(buildYearReport(r, DEFAULT_SETTINGS, 2025).savings.gppBalance)).toBe(-10000);
    expect(r.issues.some((i) => i.code === 'crypto_repurchase')).toBe(true);
  });
});

describe('Avisos por ejercicio', () => {
  it('una venta sin compras de otro año no afecta a un activo distinto, pero sí si se vuelve a vender', () => {
    const r = run([
      trade('sell', '2023-09-11', '10', '100', { assetId: 'CERRADO', assetName: 'Cerrado' }),
      trade('sell', '2023-09-11', '10', '100', { assetId: 'SIGUE', assetName: 'Sigue' }),
      trade('buy', '2024-01-10', '10', '100', { assetId: 'SIGUE', assetName: 'Sigue' }),
      trade('sell', '2025-06-01', '10', '120', { assetId: 'SIGUE', assetName: 'Sigue' }),
    ]);
    const of = (y: number) => issuesForYear(r, y).filter((i) => i.code === 'missing_lots').map((i) => i.assetId);
    expect(of(2023).sort()).toEqual(['CERRADO', 'SIGUE']);
    expect(of(2025)).toEqual(['SIGUE']);
    expect(of(2024)).toEqual([]);
  });
});

describe('Aviso del plazo de un año en EE. UU.', () => {
  const usa = { assetId: 'USA', assetName: 'Valor de EE. UU.' };
  const flagged = (r: ReturnType<typeof run>) => r.issues.some((i) => i.code === 'us_wash_sensitive');

  it('no avisa si lo comprado antes se vendió entero y no se ha recomprado', () => {
    expect(flagged(run([trade('buy', '2025-01-10', '10', '100', usa), trade('sell', '2025-08-10', '10', '50', usa)]))).toBe(false);
  });
  it('avisa si queda en cartera algo comprado entre 2 y 12 meses antes', () => {
    expect(flagged(run([trade('buy', '2024-10-10', '10', '100', usa), trade('buy', '2025-01-10', '10', '100', usa), trade('sell', '2025-08-10', '10', '50', usa)]))).toBe(true);
  });
  it('avisa si se recompra entre 2 y 12 meses después', () => {
    expect(flagged(run([trade('buy', '2025-01-10', '10', '100', usa), trade('sell', '2025-08-10', '10', '50', usa), trade('buy', '2026-02-10', '1', '60', usa)]))).toBe(true);
  });
});

describe('Permutas y divisas', () => {
  it('permuta entre criptos: valor de mercado como transmisión y como nuevo coste', () => {
    const swap: Operation = {
      ...trade('sell', '2025-02-01', '1', '60000', { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto', feeEur: '10' }),
      kind: 'swap', counterAsset: 'ETH', counterName: 'Ethereum', counterQuantity: '20',
    };
    const r = run([
      trade('buy', '2024-01-02', '1', '40000', { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' }),
      swap,
      trade('sell', '2025-06-01', '20', '3500', { assetId: 'ETH', assetName: 'Ethereum', assetClass: 'crypto' }),
    ]);
    expect(r.disposals[0]!.clave).toBe('N');
    expect(money(r.disposals[0]!.gainEur)).toBe(19990);
    expect(money(r.disposals[1]!.costEur)).toBe(60000);
    expect(money(r.disposals[1]!.gainEur)).toBe(10000);
  });

  it('dividendo en USD crea lote de divisa y su conversión da resultado', () => {
    const div: Operation = {
      ...trade('buy', '2025-02-01', '0', '0'), kind: 'dividend', quantity: null, unitPrice: null, currency: 'USD', fxRate: '1.25',
      grossLocal: '100', grossEur: '80.00', withholdingEur: '12.00', totalEur: '68.00', settleCurrency: 'USD',
    };
    const fx: Operation = {
      ...trade('buy', '2025-02-03', '0', '0'), kind: 'fx', assetId: 'USD', assetName: 'USD', assetClass: 'other', quantity: '85', unitPrice: null, currency: 'USD',
      counterAsset: 'EUR', counterQuantity: '70.83', fxRate: '1.2', grossLocal: null, grossEur: '70.83', totalEur: '70.83', settleCurrency: 'EUR',
    };
    const r = run([div, fx]);
    const d = r.disposals.find((x) => x.class === 'fx')!;
    expect(money(d.costEur)).toBe(68);
    expect(money(d.gainEur)).toBe(2.83);
    const rep = buildYearReport(r, DEFAULT_SETTINGS, 2025);
    expect(rep.rcm.dividends).toBe('80.00');
    expect(rep.rcm.foreignTax).toBe('12.00');
  });

  it('compra y venta en USD con AutoFX: euros a cada fecha y separación V0282-22 suman lo mismo', () => {
    const usd = (kind: 'buy' | 'sell', date: string, qty: string, price: string, rate: string, fee = '0') => {
      const gl = D(qty).times(D(price));
      const ge = gl.div(rate).toDecimalPlaces(2);
      const f = D(fee);
      return trade(kind, date, qty, price, {
        currency: 'USD', fxRate: rate, grossLocal: gl.toFixed(2), grossEur: ge.toFixed(2), feeEur: f.toFixed(2),
        totalEur: (kind === 'buy' ? ge.plus(f) : ge.minus(f)).toFixed(2),
      });
    };
    const ops = [usd('buy', '2024-01-10', '10', '80', '1.1', '2'), usd('sell', '2025-03-10', '10', '150', '1.2', '2')];
    const plain = run(ops);
    const split = run(ops, { fxMethod: 'split' });
    const total = (r: ReturnType<typeof run>) => r.disposals.reduce((s, d) => s + money(d.gainEur), 0);
    expect(plain.disposals).toHaveLength(1);
    expect(split.disposals).toHaveLength(2);
    expect(total(split)).toBeCloseTo(total(plain), 1);
    expect(money(split.disposals.find((d) => d.class === 'stock')!.gainEur)).toBeCloseTo(70 * 10 / 1.2 - 4, 1);
  });

  const fxOp = (date: string, given: string, givenCur: string, recv: string, recvCur: string, eur: string): Operation => ({
    ...trade('buy', date, '0', '0'), kind: 'fx', assetId: 'USD', assetName: 'USD', assetClass: 'other', quantity: given, unitPrice: null, currency: givenCur,
    counterAsset: recvCur, counterQuantity: recv, fxRate: '1.2', grossLocal: null, grossEur: eur, totalEur: eur, settleCurrency: 'EUR',
  });
  const usdTrade = (kind: 'buy' | 'sell', date: string, qty: string, price: string, rate: string) => {
    const local = D(qty).times(D(price));
    const value = local.div(rate).toDecimalPlaces(2).toFixed(2);
    return trade(kind, date, qty, price, { currency: 'USD', fxRate: rate, grossLocal: local.toFixed(2), grossEur: value, totalEur: value, settleCurrency: 'USD', feesInEur: true });
  };
  const fxGains = (r: ReturnType<typeof run>) => r.disposals.filter((d) => d.class === 'fx').reduce((s, d) => s + Number(d.gainEur), 0);

  it('pagar en USD sin saldo previo ni cambio posterior no inventa una ganancia', () => {
    const op = trade('buy', '2025-01-10', '1', '100', {
      assetId: 'SOL', assetName: 'Solana', assetClass: 'crypto', currency: 'USD', fxRate: '1.03', grossLocal: '100.00', grossEur: '97.09', totalEur: '97.09', settleCurrency: 'USD',
    });
    const r = run([op]);
    expect(r.disposals.filter((x) => x.class === 'fx')).toEqual([]);
    expect(r.issues.some((i) => i.code === 'fx_shortfall' && i.severity === 'info')).toBe(true);
    expect(r.issues.some((i) => i.code === 'missing_lots')).toBe(false);
  });

  it('una compra pagada después con el cambio a otro tipo da la diferencia real', () => {
    const r = run([usdTrade('buy', '2025-02-01', '10', '100', '1.25'), fxOp('2025-02-02', '833.33', 'EUR', '1000', 'USD', '833.33')]);
    expect(money(r.disposals.find((d) => d.class === 'fx')!.proceedsEur)).toBe(800);
    expect(fxGains(r)).toBeCloseTo(-33.33, 1);
    expect(r.openLots.filter((l) => l.class === 'fx')).toEqual([]);
  });

  it('vender en USD y recomprar con esos USD sin pasar por euros hace aflorar la diferencia de cambio', () => {
    const r = run([
      trade('buy', '2024-01-01', '10', '50'),
      usdTrade('sell', '2025-01-10', '10', '100', '1.00'),
      fxOp('2024-12-01', '1', 'EUR', '1.2', 'USD', '1.00'),
      usdTrade('buy', '2025-03-10', '5', '200', '1.25'),
    ].map((o) => ({ ...o, assetId: o.kind === 'fx' ? 'USD' : o.assetId })));
    // 1.000 USD valían 1.000 € al entrar y 800 € al salir.
    expect(fxGains(r)).toBeCloseTo(-200, 0);
  });

  it('sin cambios de divisa del bróker, sus operaciones se tratan como pagadas en euros', () => {
    const r = run([usdTrade('buy', '2024-01-10', '10', '100', '1.25'), usdTrade('sell', '2025-01-10', '10', '150', '1.00')]);
    expect(r.disposals.filter((d) => d.class === 'fx')).toEqual([]);
    expect(r.openLots).toEqual([]);
  });

  it('un cambio sin efecto no se declara', () => {
    const rep = run([usdTrade('buy', '2025-02-01', '10', '100', '1.25'), fxOp('2025-02-01', '800', 'EUR', '1000', 'USD', '800.00')]);
    expect(rep.disposals.filter((d) => d.class === 'fx')).toHaveLength(1);
    expect(buildYearReport(rep, DEFAULT_SETTINGS, 2025).sections.find((s) => s.id === 'fx')).toBeUndefined();
  });

  it('con tipo BCE recalcula en euros sin tocar lo guardado', () => {
    const op = trade('sell', '2025-03-10', '10', '150', { currency: 'USD', fxRate: '1.2', grossLocal: '1500.00', grossEur: '1250.00', totalEur: '1250.00' });
    const buy = trade('buy', '2024-01-10', '10', '80');
    const r = run([buy, op], { fxSource: 'ecb' }, () => '1.25');
    expect(money(r.disposals[0]!.proceedsEur)).toBe(1200);
    expect(op.grossEur).toBe('1250.00');
  });
});

describe('Integración y compensación (art. 49)', () => {
  const income = (date: string, gross: string): Operation => ({
    ...trade('buy', date, '0', '0'), kind: 'interest', assetId: 'CASH', assetName: 'Cuenta', quantity: null, unitPrice: null,
    grossLocal: gross, grossEur: gross, totalEur: gross,
  });

  it('pérdidas compensan el 25 % del capital y el resto se arrastra', () => {
    const r = run([trade('buy', '2024-01-10', '100', '10'), trade('sell', '2025-03-15', '100', '5'), income('2025-06-01', '1000')]);
    const rep = buildYearReport(r, DEFAULT_SETTINGS, 2025);
    expect(rep.savings.gppBalance).toBe('-500.00');
    expect(rep.savings.steps[0]!.amount).toBe('250.00');
    expect(rep.savings.base).toBe('750.00');
    expect(rep.savings.carryForward).toEqual([{ year: 2025, bucket: 'gpp', amount: '250.00', expires: 2029 }]);
  });

  it('las pérdidas pendientes se aplican el año siguiente y caducan a los cuatro', () => {
    const ops = [
      trade('buy', '2024-01-10', '100', '10'), trade('sell', '2025-03-15', '100', '5'),
      trade('buy', '2025-09-10', '10', '10'), trade('sell', '2026-02-01', '10', '30'),
    ];
    const r = run(ops);
    const rep = buildYearReport(r, DEFAULT_SETTINGS, 2026);
    expect(rep.savings.gppBalance).toBe('200.00');
    expect(rep.savings.base).toBe('0.00');
    expect(rep.savings.carryForward[0]!.amount).toBe('300.00');
    const expired = run([trade('buy', '2024-01-10', '100', '10'), trade('sell', '2025-03-15', '100', '5'), { ...income('2031-01-01', '100') }]);
    expect(buildYearReport(expired, DEFAULT_SETTINGS, 2031).savings.carryForward).toEqual([]);
  });

  it('con la última Renta indicada, lo anterior no se recalcula y solo cuenta lo pendiente escrito', () => {
    const ops = [trade('sell', '2023-09-11', '100', '100', { assetId: 'SINCOMPRAS', assetName: 'X' }), trade('buy', '2025-01-10', '1', '100'), trade('sell', '2025-06-01', '1', '600')];
    const losses = { openingLosses: [{ year: 2022, bucket: 'gpp' as const, amount: '800' }] };
    // Sin indicarla, la ganancia ficticia de 2023 se come la pérdida pendiente.
    expect(buildYearReport(run(ops), { ...DEFAULT_SETTINGS, ...losses }, 2025).savings.base).toBe('500.00');
    const rep = buildYearReport(run(ops), { ...DEFAULT_SETTINGS, ...losses, lastFiledYear: 2024 }, 2025);
    expect(rep.savings.base).toBe('0.00');
    expect(rep.savings.carryForward).toEqual([{ year: 2022, bucket: 'gpp', amount: '300.00', expires: 2026 }]);
  });

  it('escala del ahorro de 2025', () => {
    const r = run([trade('buy', '2024-01-10', '1', '0'), trade('sell', '2025-03-15', '1', '60000')]);
    const rep = buildYearReport(r, DEFAULT_SETTINGS, 2025);
    expect(rep.savings.tax).toBe(String((6000 * 19 + 44000 * 21 + 10000 * 23) / 100 + '.00'));
  });

  it('doble imposición: máximo el tipo de convenio y el exceso no deducible', () => {
    const div: Operation = {
      ...trade('buy', '2025-02-01', '0', '0'), kind: 'dividend', assetId: 'DE0007164600', assetName: 'SAP', quantity: null, unitPrice: null,
      grossLocal: '1000', grossEur: '1000', withholdingEur: '263.75', totalEur: '736.25',
    };
    const rep = buildYearReport(run([div]), DEFAULT_SETTINGS, 2025);
    expect(rep.doubleTax[0]).toMatchObject({ country: 'DE', deductible: '150.00', excess: '113.75' });
    expect(rep.doubleTaxDeduction).toBe('150.00');
    expect(rep.savings.tax).toBe('190.00');
  });
});

describe('Cripto que llega de fuera', () => {
  const crypto = { assetId: 'BTC', assetName: 'Bitcoin', assetClass: 'crypto' as const, broker: 'kraken' as const };
  const into = (date: string, qty: string): Operation => ({ ...trade('buy', date, qty, '0', crypto), kind: 'transfer_in', grossEur: null, grossLocal: null, unitPrice: null, totalEur: null });
  const out = (date: string, qty: string): Operation => ({ ...into(date, qty), kind: 'transfer_out' });

  it('vendida entera, falta su coste solo en el año de la venta', () => {
    const res = run([into('2021-01-10', '1'), trade('sell', '2021-02-01', '1', '100', crypto), trade('buy', '2026-01-10', '1', '200', crypto), trade('sell', '2026-02-01', '0.5', '300', crypto)]);
    const missing = res.issues.filter((i) => i.code === 'missing_lots');
    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({ settled: true, year: 2021 });
    expect(issuesForYear(res, 2026).filter((i) => i.code === 'missing_lots')).toEqual([]);
    expect(issuesForYear(res, 2021).filter((i) => i.code === 'missing_lots')).toHaveLength(1);
  });
  it('sin depósito que lo explique, el aviso sigue en los años siguientes', () => {
    const res = run([trade('sell', '2021-02-01', '1', '100', crypto), trade('buy', '2026-01-10', '1', '200', crypto), trade('sell', '2026-02-01', '0.5', '300', crypto)]);
    expect(issuesForYear(res, 2026).filter((i) => i.code === 'missing_lots')).toHaveLength(1);
  });
  it('lo que se saca y vuelve no cuenta como llegado de fuera', () => {
    const res = run([trade('buy', '2021-01-10', '2', '100', crypto), out('2021-02-01', '2'), into('2021-03-01', '1'), trade('sell', '2021-04-01', '1', '150', crypto)]);
    expect(res.issues.filter((i) => i.code === 'missing_lots')).toEqual([]);
    const p = res.positions.find((x) => x.assetId === 'BTC')!;
    expect(p.quantity).toBe('1');
    expect(p.byBroker).toMatchObject({ externo: '1' });
  });
  it('tras vender lo llegado de fuera, lo sacado coincide con los lotes', () => {
    const res = run([into('2021-01-10', '1'), trade('sell', '2021-02-01', '1', '100', crypto), trade('buy', '2022-01-10', '3', '200', crypto), out('2022-02-01', '3')]);
    const p = res.positions.find((x) => x.assetId === 'BTC')!;
    expect(p.quantity).toBe('3');
    expect(p.byBroker).toMatchObject({ externo: '3' });
  });
});

describe('Entradas del informe', () => {
  it('una pérdida aplazada entera no deja una línea a cero', () => {
    const res = run([trade('buy', '2026-01-10', '3', '4.3'), trade('buy', '2026-09-23', '7', '3.9'), trade('sell', '2026-10-27', '3', '3.7')], {}, () => null, '2026-11-02');
    const stock = buildYearReport(res, DEFAULT_SETTINGS, 2026).sections.find((s) => s.id === 'stock')!;
    expect(stock.entries).toHaveLength(1);
    expect(stock.entries[0]!.note).toBeTruthy();
  });
});

describe('Datos del aviso de pérdida aplazada', () => {
  const res = run([
    trade('buy', '2025-01-10', '6', '10'),
    trade('buy', '2026-09-23', '2', '5', { broker: 'trade_republic' }),
    trade('buy', '2026-10-09', '2', '5', { broker: 'trade_republic' }),
    trade('sell', '2026-10-27', '4', '6', { broker: 'trade_republic' }),
  ], {}, () => null, '2026-11-02');

  it('cada compra consumida dice de qué bróker viene', () => {
    const sale = res.disposals[0]!;
    expect(sale.broker).toBe('trade_republic');
    expect(sale.matches.map((m) => m.broker)).toEqual(['degiro']);
  });
  it('cada parte aplazada dice cuántos títulos se venden antes', () => {
    const blocked = res.tranches.filter((t) => t.status === 'blocked');
    expect(blocked.map((t) => [t.blockerDate?.slice(0, 10), t.quantity, t.aheadQty])).toEqual([
      ['2026-09-23', '2', '2'],
      ['2026-10-09', '2', '4'],
    ]);
  });
});
