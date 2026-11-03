import { D, Decimal, ZERO, cents } from '../../shared/decimal.ts';
import { INCOME_GROUP, type DisposalClass, type EngineResult, type IncomeGroup, type Operation, type PerformanceAsset, type PerformanceData, type PerformanceYear, type Position } from '../../shared/types.ts';
import { prevMonth } from './dates.ts';

export interface PriceLookup {
  monthly: (assetId: string, month: string) => Decimal | null;
  current: (assetId: string) => Decimal | null;
}

const dayNumber = (date: string) => Date.parse(`${date.slice(0, 10)}T00:00:00Z`) / 86400000;

/**
 * Lo que pasó realmente cada año, antes de impuestos: lo vendido, lo cobrado y cuánto
 * cambió el valor de lo que no se vendió. No sigue las reglas fiscales: una pérdida aplazada
 * cuenta cuando ocurre, y lo vendido sin coste conocido no cuenta como ganancia.
 */
export function computePerformance(res: EngineResult, ops: Operation[], prices: PriceLookup, today: string): Omit<PerformanceData, 'places' | 'hasHistory' | 'fetchedAt'> {
  const thisMonth = today.slice(0, 7);
  const thisYear = Number(today.slice(0, 4));
  const monthly = res.monthly ?? {};
  const missing = new Set<string>();

  const priceFor = (assetId: string, month: string): Decimal | null => {
    if (month === thisMonth) {
      const now = prices.current(assetId);
      if (now) return now;
    }
    let m = month;
    for (let i = 0; i < 3; i++, m = prevMonth(m)) {
      const p = prices.monthly(assetId, m);
      if (p) return p;
    }
    return null;
  };
  /** Sin precio cuenta a su coste: ni gana ni pierde. */
  const valueOf = (p: Position, month: string): Decimal => {
    const px = priceFor(p.assetId, month);
    if (px) return D(p.quantity).times(px);
    // Un resto de pocos euros no merece un aviso.
    if (D(p.costEur).gte(5)) missing.add(p.assetName);
    return D(p.costEur);
  };
  const held = (month: string) => (monthly[month] ?? []).filter((p) => p.class !== 'fx' && D(p.quantity).gt(0));

  const months = Object.keys(monthly).sort().map((month) => {
    let value = ZERO, cost = ZERO;
    for (const p of held(month)) { value = value.plus(valueOf(p, month)); cost = cost.plus(D(p.costEur)); }
    return { month, valueEur: cents(value), costEur: cents(cost) };
  });

  const first = res.years[0] ?? thisYear;
  const allYears: number[] = [];
  for (let y = first; y <= thisYear; y++) allYears.push(y);
  const closeOf = (y: number) => (y >= thisYear ? thisMonth : `${y}-12`);

  const assets = new Map<string, { name: string; klass: DisposalClass }>();
  const note = (id: string, name: string, klass: DisposalClass) => { if (!assets.has(id) || klass !== 'other') assets.set(id, { name, klass }); };
  type Tally = { realized: Decimal; income: Decimal; unrealizedEnd: Decimal; value: Decimal };
  const perAsset = new Map<string, Map<number, Tally>>();
  const tally = (id: string, y: number): Tally => {
    let by = perAsset.get(id);
    if (!by) { by = new Map(); perAsset.set(id, by); }
    let t = by.get(y);
    if (!t) { t = { realized: ZERO, income: ZERO, unrealizedEnd: ZERO, value: ZERO }; by.set(y, t); }
    return t;
  };

  const years: PerformanceYear[] = [];
  let previousEnd = ZERO, previousValue = ZERO;
  let compound = D(1), anyReturn = false, totalResult = ZERO;

  for (const y of allYears) {
    let realized = ZERO, unknown = ZERO, income = ZERO, fees = ZERO, value = ZERO, cost = ZERO;
    const byType: Record<IncomeGroup, Decimal> = { dividends: ZERO, interest: ZERO, staking: ZERO, rewards: ZERO, other: ZERO };
    const start = `${y - 1}-12-31`;
    const end = y === thisYear ? today : `${y}-12-31`;
    const span = Math.max(1, dayNumber(end) - dayNumber(start));
    const weight = (date: string) => Math.max(0, dayNumber(end) - dayNumber(date)) / span;
    let invested = previousValue;

    for (const d of res.disposals) {
      if (d.year !== y || d.simulated) continue;
      note(d.assetId, d.assetName, d.class);
      let unknownHere = ZERO;
      for (const m of d.matches) {
        if (m.missing) { unknownHere = unknownHere.plus(D(m.proceedsEur)); continue; }
        realized = realized.plus(D(m.gainEur));
        const t = tally(d.assetId, y);
        t.realized = t.realized.plus(D(m.gainEur));
      }
      unknown = unknown.plus(unknownHere);
      // Una permuta no saca dinero: lo vendido entra en lo recibido.
      if (d.class !== 'fx' && (d.clave !== 'N' || ops.some((o) => o.id === d.opId && o.fifoLeg === 'swap_out'))) invested = invested.minus(D(d.proceedsEur).minus(unknownHere).times(weight(d.date)));
    }
    for (const o of ops) {
      if (o.kind === 'buy' && !o.deleted && o.assetClass !== ('fx' as string) && o.datetime.startsWith(String(y)) && o.totalEur) invested = invested.plus(D(o.totalEur).times(weight(o.datetime)));
    }
    for (const i of res.incomes) {
      if (i.year !== y) continue;
      income = income.plus(D(i.grossEur));
      byType[INCOME_GROUP[i.type]] = byType[INCOME_GROUP[i.type]].plus(D(i.grossEur));
      fees = fees.plus(D(i.feeEur));
      note(i.assetId, i.assetName, 'other');
      const t = tally(i.assetId, y);
      t.income = t.income.plus(D(i.grossEur));
    }
    for (const f of res.fees) if (f.year === y) fees = fees.plus(D(f.amountEur));

    const close = closeOf(y);
    for (const p of held(close)) {
      const v = valueOf(p, close);
      value = value.plus(v);
      cost = cost.plus(D(p.costEur));
      note(p.assetId, p.assetName, p.class);
      const t = tally(p.assetId, y);
      t.value = v;
      t.unrealizedEnd = v.minus(D(p.costEur));
    }
    const unrealizedEnd = value.minus(cost);
    const change = unrealizedEnd.minus(previousEnd);
    const result = realized.plus(income).minus(fees).plus(change);
    // Con muchas compras y ventas el capital ponderado puede quedar casi a cero y dar cifras sin sentido: entonces, la media de lo invertido.
    const closes = [`${y - 1}-12`, ...months.filter((m) => m.month.startsWith(`${y}-`)).map((m) => m.month)];
    const byMonth = new Map(months.map((m) => [m.month, D(m.valueEur)]));
    const average = closes.reduce((s, m) => s.plus(byMonth.get(m) ?? ZERO), ZERO).div(closes.length);
    const capital = invested.gte(average.times('0.25')) ? invested : average;
    const returnPct = capital.gte(1) ? result.div(capital).times(100) : null;
    if (returnPct) { compound = compound.times(returnPct.div(100).plus(1)); anyReturn = true; }
    totalResult = totalResult.plus(result);

    years.push({
      year: y, realizedEur: cents(realized), incomeEur: cents(income), incomeByType: Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, cents(v)])) as Record<IncomeGroup, string>, feesEur: cents(fees), unrealizedEndEur: cents(unrealizedEnd), unrealizedChangeEur: cents(change),
      resultEur: cents(result), returnPct: returnPct ? returnPct.toDecimalPlaces(2).toFixed(2) : null, valueEndEur: cents(value), costEndEur: cents(cost),
      unknownCostProceedsEur: cents(unknown), taxEur: null,
    });
    previousEnd = unrealizedEnd;
    previousValue = value;
  }

  const assetRows: PerformanceAsset[] = [...perAsset.entries()].map(([assetId, by]) => {
    const meta = assets.get(assetId);
    const out: PerformanceAsset = { assetId, assetName: meta?.name ?? assetId, class: meta?.klass ?? 'other', years: {} };
    let previous = ZERO;
    for (const y of allYears) {
      const t = by.get(y);
      const end = t?.unrealizedEnd ?? ZERO;
      const change = end.minus(previous);
      previous = end;
      if (!t && change.isZero()) continue;
      const realized = t?.realized ?? ZERO, income = t?.income ?? ZERO;
      out.years[y] = {
        realizedEur: cents(realized), incomeEur: cents(income), unrealizedChangeEur: cents(change), unrealizedEndEur: cents(end),
        valueEndEur: cents(t?.value ?? ZERO), resultEur: cents(realized.plus(income).plus(change)),
      };
    }
    return out;
  });

  return {
    years, assets: assetRows, months, totalResultEur: cents(totalResult),
    totalReturnPct: anyReturn ? compound.minus(1).times(100).toDecimalPlaces(2).toFixed(2) : null,
    missingPrices: [...missing].sort(),
  };
}
