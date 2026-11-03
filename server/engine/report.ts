import { D, Decimal, ZERO, toStr } from '../../shared/decimal.ts';
import type { Disposal, EngineResult, Issue, LossTranche, Settings } from '../../shared/types.ts';

const c = (d: Decimal): string => d.toDecimalPlaces(2).toFixed(2);

export interface FormEntry {
  name: string;
  assetId: string;
  clave?: string;
  transmission: string;
  acquisition: string;
  gain: string;
  lossObtained: string;
  lossComputable: string;
  note?: string;
}

export interface FormSection {
  id: 'stock' | 'etf' | 'crypto' | 'fx' | 'other';
  title: string;
  boxes: Record<string, string>;
  entries: FormEntry[];
  gainTotal: string;
  lossTotal: string;
  lossComputableTotal: string;
}

export interface SavingsStep { label: string; amount: string }

export interface YearReport {
  year: number;
  sections: FormSection[];
  rcm: {
    interest: string; dividends: string; staking: string; bonds: string; capitalExcess: string;
    grossTotal: string; custody: string; net: string; spanishTax: string; foreignTax: string; nonDeductibleFees: string;
  };
  rewards: string;
  doubleTax: { country: string; gross: string; withheld: string; treatyRate: string; deductible: string; excess: string }[];
  doubleTaxDeduction: string;
  art80Limit: string;
  deferred: { generated: string; released: string; pendingEnd: string; tranches: LossTranche[] };
  savings: {
    gppBalance: string; rcmBalance: string; steps: SavingsStep[]; base: string;
    tax: string; avgRate: string; brackets: { from: string; to: string | null; rate: string; base: string; tax: string }[];
    taxAfterCredits: string; carryForward: { year: number; bucket: 'gpp' | 'rcm'; amount: string; expires: number }[];
  };
  yearEnd: { assetId: string; assetName: string; class: string; quantity: string; costEur: string; byBroker: Record<string, string> }[];
  issues: Issue[];
}

const SECTION_META: Record<FormSection['id'], { title: string; boxes: Record<string, string> }> = {
  stock: {
    title: 'F2. Acciones admitidas a negociación',
    boxes: { name: '0327', transmission: '0328', acquisition: '0331', gain: '0332', lossObtained: '0337', lossComputable: '0338', sumGain: '0339', sumLoss: '0340' },
  },
  etf: {
    title: 'F2. ETF e IIC del art. 75.3.j) RIRPF',
    boxes: { name: '2226', transmission: '2227', acquisition: '2229', gain: '2230', lossObtained: '2233', lossComputable: '2234', sumGain: '2235', sumLoss: '2236' },
  },
  crypto: {
    title: 'F2. Monedas virtuales',
    boxes: { name: '1802', clave: '1803', transmission: '1804', acquisition: '1806', gain: '1809', lossObtained: '1807', lossComputable: '1808', sumGain: '1814', sumLoss: '1813' },
  },
  fx: {
    title: 'F2. Otros elementos patrimoniales: divisas (clave 4, casilla 1626)',
    boxes: { transmission: '1633', acquisition: '1637', transmissionDate: '1631', acquisitionDate: '1632' },
  },
  other: {
    title: 'F2. Otros valores sin bloque propio',
    boxes: { transmission: '1633', acquisition: '1637' },
  },
};

/**
 * Avisos que pueden cambiar el resultado de un año: los suyos y los de años anteriores
 * de un activo que se vende ese año. Un año posterior nunca altera a uno anterior.
 */
export function issuesForYear(res: EngineResult, year: number): Issue[] {
  const sold = new Set(res.disposals.filter((d) => d.year === year).map((d) => d.assetId));
  return res.issues.filter((i) => i.year === undefined || i.year === year || (i.year < year && !i.settled && !!i.assetId && sold.has(i.assetId)));
}

/** Cambio de moneda sin efecto: el dinero solo pasa por la divisa para pagar o cobrar una operación. */
export const isNeutralFx = (d: Disposal): boolean => d.class === 'fx' && D(d.gainEur).abs().lt('0.005');

const sectionOf = (d: Disposal): FormSection['id'] => {
  if (d.class === 'stock') return 'stock';
  if (d.class === 'etf' || d.class === 'fund') return 'etf';
  if (d.class === 'crypto') return 'crypto';
  if (d.class === 'fx') return 'fx';
  return 'other';
};

/** Escala estatal + autonómica general del ahorro por ejercicio (Navarra y País Vasco tienen la suya). */
export function savingsBrackets(year: number): { to: number | null; rate: number }[] {
  if (year >= 2025) return [{ to: 6000, rate: 19 }, { to: 50000, rate: 21 }, { to: 200000, rate: 23 }, { to: 300000, rate: 27 }, { to: null, rate: 30 }];
  if (year >= 2023) return [{ to: 6000, rate: 19 }, { to: 50000, rate: 21 }, { to: 200000, rate: 23 }, { to: 300000, rate: 27 }, { to: null, rate: 28 }];
  if (year >= 2021) return [{ to: 6000, rate: 19 }, { to: 50000, rate: 21 }, { to: 200000, rate: 23 }, { to: null, rate: 26 }];
  return [{ to: 6000, rate: 19 }, { to: 50000, rate: 21 }, { to: null, rate: 23 }];
}

interface PendingLoss { year: number; bucket: 'gpp' | 'rcm'; amount: Decimal }

/** Saldos del año: resultado de transmisiones y capital mobiliario neto. */
function yearBalances(res: EngineResult, year: number) {
  let gpp = ZERO;
  for (const d of res.disposals) {
    if (d.year !== year || d.class === 'bond') continue;
    for (const m of d.matches) {
      const g = D(m.gainEur);
      if (g.gte(0)) gpp = gpp.plus(g);
    }
  }
  for (const t of res.tranches) {
    if (t.status === 'blocked' || t.year !== year) continue;
    gpp = gpp.minus(D(t.amountEur));
  }
  // Pérdidas de clases sin regla de recompra: se integran directamente.
  for (const d of res.disposals) {
    if (d.year !== year || d.class === 'bond' || d.class === 'stock' || d.class === 'etf' || d.class === 'fund') continue;
    for (const m of d.matches) {
      const g = D(m.gainEur);
      if (g.lt(0)) gpp = gpp.plus(g);
    }
  }
  let rcmGross = ZERO;
  for (const i of res.incomes) {
    if (i.year === year && i.type !== 'reward') rcmGross = rcmGross.plus(D(i.grossEur));
  }
  let custody = ZERO;
  for (const f of res.fees) {
    if (f.year === year && f.feeClass === 'custody') custody = custody.plus(D(f.amountEur));
  }
  return { gpp, rcm: rcmGross.minus(custody) };
}

export function compensate(res: EngineResult, settings: Settings, upToYear: number) {
  const pending: PendingLoss[] = settings.openingLosses.map((o) => ({ year: o.year, bucket: o.bucket, amount: D(o.amount) }));
  const firstData = res.years[0] ?? upToYear;
  const firstOpening = pending.reduce((m, p) => Math.min(m, p.year + 1), firstData);
  const filed = settings.lastFiledYear;
  // Lo ya presentado no se vuelve a calcular: solo cuenta lo pendiente que indica el usuario.
  const first = filed && upToYear > filed ? filed + 1 : Math.min(firstData, firstOpening);
  let last = { gpp: ZERO, rcm: ZERO, gppFinal: ZERO, rcmFinal: ZERO, steps: [] as SavingsStep[] };

  for (let y = first; y <= upToYear; y++) {
    const { gpp: gpp0, rcm: rcm0 } = yearBalances(res, y);
    let gpp = gpp0, rcm = rcm0;
    const steps: SavingsStep[] = [];
    const capOnGpp0 = gpp.gt(0) ? gpp.times('0.25') : ZERO;
    const capOnRcm0 = rcm.gt(0) ? rcm.times('0.25') : ZERO;
    let capOnGpp = capOnGpp0, capOnRcm = capOnRcm0;

    if (rcm.lt(0) && gpp.gt(0)) {
      const x = Decimal.min(rcm.abs(), capOnGpp);
      rcm = rcm.plus(x); gpp = gpp.minus(x); capOnGpp = capOnGpp.minus(x);
      steps.push({ label: 'Saldo negativo de capital compensado con transmisiones (máx. 25 %)', amount: c(x) });
    }
    if (gpp.lt(0) && rcm.gt(0)) {
      const x = Decimal.min(gpp.abs(), capOnRcm);
      gpp = gpp.plus(x); rcm = rcm.minus(x); capOnRcm = capOnRcm.minus(x);
      steps.push({ label: 'Saldo negativo de transmisiones compensado con capital (máx. 25 %)', amount: c(x) });
    }

    const live = pending.filter((p) => p.amount.gt(0) && y - p.year <= 4 && p.year < y).sort((a, b) => a.year - b.year);
    for (const p of live) {
      const own = p.bucket === 'gpp' ? gpp : rcm;
      if (own.gt(0)) {
        const x = Decimal.min(p.amount, own);
        p.amount = p.amount.minus(x);
        if (p.bucket === 'gpp') gpp = gpp.minus(x); else rcm = rcm.minus(x);
        steps.push({ label: `Pérdidas de ${p.year} compensadas en su mismo grupo`, amount: c(x) });
      }
      if (p.amount.gt(0)) {
        if (p.bucket === 'gpp' && rcm.gt(0) && capOnRcm.gt(0)) {
          const x = Decimal.min(p.amount, capOnRcm, rcm);
          p.amount = p.amount.minus(x); rcm = rcm.minus(x); capOnRcm = capOnRcm.minus(x);
          steps.push({ label: `Pérdidas de ${p.year} compensadas con capital (máx. 25 %)`, amount: c(x) });
        } else if (p.bucket === 'rcm' && gpp.gt(0) && capOnGpp.gt(0)) {
          const x = Decimal.min(p.amount, capOnGpp, gpp);
          p.amount = p.amount.minus(x); gpp = gpp.minus(x); capOnGpp = capOnGpp.minus(x);
          steps.push({ label: `Saldo de capital de ${p.year} compensado con transmisiones (máx. 25 %)`, amount: c(x) });
        }
      }
    }
    if (gpp.lt(0)) pending.push({ year: y, bucket: 'gpp', amount: gpp.abs() });
    if (rcm.lt(0)) pending.push({ year: y, bucket: 'rcm', amount: rcm.abs() });
    last = { gpp: gpp0, rcm: rcm0, gppFinal: Decimal.max(gpp, ZERO), rcmFinal: Decimal.max(rcm, ZERO), steps };
  }
  const carry = pending
    .filter((p) => p.amount.gt(0) && p.year + 4 >= upToYear + 1)
    .map((p) => ({ year: p.year, bucket: p.bucket, amount: c(p.amount), expires: p.year + 4 }));
  return { ...last, carry };
}

export function buildYearReport(res: EngineResult, settings: Settings, year: number): YearReport {
  const disposals = res.disposals.filter((d) => d.year === year && d.class !== 'bond' && !isNeutralFx(d));

  // Por disposición y lote: parte de la pérdida que este año no se integra.
  const deferredByDisposal = new Map<string, Decimal>();
  for (const t of res.tranches) {
    if (t.status === 'blocked' || t.year > year) {
      if (Number(t.originDate.slice(0, 4)) === year) {
        deferredByDisposal.set(t.originDisposalId, (deferredByDisposal.get(t.originDisposalId) ?? ZERO).plus(D(t.amountEur)));
      }
    }
  }

  const buckets = new Map<string, {
    section: FormSection['id']; name: string; assetId: string; clave?: string;
    tA: Decimal; aA: Decimal; gain: Decimal; lossA: Decimal;
    tB: Decimal; aB: Decimal; lossB: Decimal;
  }>();
  const bucket = (d: Disposal) => {
    const section = sectionOf(d);
    const key = `${section}|${d.assetId}|${d.clave ?? ''}`;
    let b = buckets.get(key);
    if (!b) {
      b = { section, name: d.assetName, assetId: d.assetId, clave: d.clave, tA: ZERO, aA: ZERO, gain: ZERO, lossA: ZERO, tB: ZERO, aB: ZERO, lossB: ZERO };
      buckets.set(key, b);
    }
    return b;
  };

  for (const d of disposals) {
    const b = bucket(d);
    let deferred = deferredByDisposal.get(d.id) ?? ZERO;
    for (const m of d.matches) {
      const gain = D(m.gainEur), proceeds = D(m.proceedsEur), cost = D(m.costEur);
      if (gain.gte(0)) {
        b.tA = b.tA.plus(proceeds); b.aA = b.aA.plus(cost); b.gain = b.gain.plus(gain);
        continue;
      }
      const loss = gain.abs();
      const part = Decimal.min(deferred, loss);
      deferred = deferred.minus(part);
      const k = part.div(loss);
      b.tB = b.tB.plus(proceeds.times(k)); b.aB = b.aB.plus(cost.times(k)); b.lossB = b.lossB.plus(part);
      b.tA = b.tA.plus(proceeds.times(D(1).minus(k))); b.aA = b.aA.plus(cost.times(D(1).minus(k)));
      b.lossA = b.lossA.plus(loss.minus(part));
    }
  }

  // Pérdidas diferidas de años anteriores que este año pasan a integrarse.
  const released = new Map<string, Decimal>();
  for (const t of res.tranches) {
    if (t.status === 'blocked' || t.year !== year) continue;
    if (Number(t.originDate.slice(0, 4)) < year) {
      released.set(t.assetId, (released.get(t.assetId) ?? ZERO).plus(D(t.amountEur)));
    }
  }

  const sections: FormSection[] = (['stock', 'etf', 'crypto', 'fx', 'other'] as const).map((id) => {
    const entries: FormEntry[] = [];
    let gainTotal = ZERO, lossTotal = ZERO, computable = ZERO;
    const rows = [...buckets.values()].filter((b) => b.section === id).sort((a, b) => a.name.localeCompare(b.name));
    for (const b of rows) {
      const net = b.gain.minus(b.lossA);
      // Cuando toda la pérdida se aplaza, solo queda un resto de redondeo: no es una entrada.
      if (c(b.tA) !== '0.00' || c(b.aA) !== '0.00') {
        entries.push({
          name: b.name, assetId: b.assetId, clave: b.clave, transmission: c(b.tA), acquisition: c(b.aA),
          gain: net.gt(0) ? c(net) : '0.00', lossObtained: net.lt(0) ? c(net.abs()) : '0.00', lossComputable: net.lt(0) ? c(net.abs()) : '0.00',
        });
      }
      if (!b.lossB.isZero()) {
        entries.push({
          name: b.name, assetId: b.assetId, clave: b.clave, transmission: c(b.tB), acquisition: c(b.aB), gain: '0.00',
          lossObtained: c(b.lossB), lossComputable: '0.00', note: 'Ponla en una entrada aparte: esta pérdida aún no cuenta porque has recomprado.',
        });
      }
      gainTotal = gainTotal.plus(Decimal.max(net, ZERO));
      lossTotal = lossTotal.plus(Decimal.max(net.neg(), ZERO)).plus(b.lossB);
      computable = computable.plus(Decimal.max(net.neg(), ZERO));
    }
    for (const [assetId, amount] of released) {
      const r = rows.find((x) => x.assetId === assetId);
      const sample = res.tranches.find((t) => t.assetId === assetId);
      if ((r?.section ?? (sample?.class === 'etf' || sample?.class === 'fund' ? 'etf' : 'stock')) !== id) continue;
      entries.push({
        name: sample?.assetName ?? assetId, assetId, transmission: '0.00', acquisition: '0.00', gain: '0.00',
        lossObtained: '0.00', lossComputable: c(amount),
        note: 'Pérdida aplazada de años anteriores que ya cuenta este año.',
      });
      computable = computable.plus(amount);
    }
    return { id, ...SECTION_META[id], entries, gainTotal: c(gainTotal), lossTotal: c(lossTotal), lossComputableTotal: c(computable) };
  }).filter((s) => s.entries.length > 0);

  const sum = (pred: (t: string) => boolean) =>
    res.incomes.filter((i) => i.year === year && pred(i.type)).reduce((s, i) => s.plus(D(i.grossEur)), ZERO);
  const interest = sum((t) => t === 'interest'), dividends = sum((t) => t === 'dividend'), staking = sum((t) => t === 'staking');
  const bonds = sum((t) => t === 'bond'), capitalExcess = sum((t) => t === 'capital_excess');
  const grossTotal = interest.plus(dividends).plus(staking).plus(bonds).plus(capitalExcess);
  const yearFees = res.fees.filter((f) => f.year === year);
  const custody = yearFees.filter((f) => f.feeClass === 'custody').reduce((s, f) => s.plus(D(f.amountEur)), ZERO);
  const nonDeductible = yearFees.filter((f) => f.feeClass !== 'custody').reduce((s, f) => s.plus(D(f.amountEur)), ZERO);
  const yearIncomes = res.incomes.filter((i) => i.year === year);
  const spanishTax = yearIncomes.reduce((s, i) => s.plus(D(i.spanishTaxEur)), ZERO);
  const foreignTax = yearIncomes.reduce((s, i) => s.plus(D(i.foreignTaxEur)), ZERO);
  const rewards = sum((t) => t === 'reward');

  const comp = compensate(res, settings, year);
  const base = comp.gppFinal.plus(comp.rcmFinal);
  const brackets: YearReport['savings']['brackets'] = [];
  let tax = ZERO, from = ZERO;
  for (const b of savingsBrackets(year)) {
    const to = b.to === null ? null : D(b.to);
    const slice = Decimal.max(ZERO, (to ? Decimal.min(base, to) : base).minus(from));
    const t = slice.times(b.rate).div(100);
    brackets.push({ from: c(from), to: to ? c(to) : null, rate: String(b.rate), base: c(slice), tax: c(t) });
    tax = tax.plus(t);
    if (to) from = to;
  }
  const avgRate = base.gt(0) ? tax.div(base) : ZERO;

  const byCountry = new Map<string, { gross: Decimal; withheld: Decimal }>();
  for (const i of yearIncomes) {
    if (D(i.foreignTaxEur).isZero()) continue;
    const key = i.country || '??';
    const e = byCountry.get(key) ?? { gross: ZERO, withheld: ZERO };
    e.gross = e.gross.plus(D(i.grossEur)); e.withheld = e.withheld.plus(D(i.foreignTaxEur));
    byCountry.set(key, e);
  }
  let deductible = ZERO, foreignBase = ZERO;
  const doubleTax = [...byCountry.entries()].sort().map(([country, e]) => {
    const treaty = D(settings.treatyRates[country] ?? settings.treatyDefault);
    const cap = e.gross.times(treaty).div(100);
    const d = Decimal.max(ZERO, Decimal.min(e.withheld, cap));
    deductible = deductible.plus(d);
    foreignBase = foreignBase.plus(e.gross);
    return { country, gross: c(e.gross), withheld: c(e.withheld), treatyRate: treaty.toFixed(), deductible: c(d), excess: c(e.withheld.minus(d)) };
  });
  const art80Limit = foreignBase.times(avgRate);
  const doubleTaxDeduction = Decimal.min(deductible, art80Limit);

  // Lo aplazado de años anteriores que sigue pendiente también se lista: forma parte del total pendiente.
  const tranches = res.tranches.filter((t) => Number(t.originDate.slice(0, 4)) === year || t.year === year || (t.status === 'blocked' && Number(t.originDate.slice(0, 4)) < year));
  const generated = res.tranches
    .filter((t) => Number(t.originDate.slice(0, 4)) === year && (t.status === 'blocked' || t.year > year))
    .reduce((s, t) => s.plus(D(t.amountEur)), ZERO);
  const releasedTotal = [...released.values()].reduce((s, v) => s.plus(v), ZERO);
  const pendingEnd = res.tranches
    .filter((t) => Number(t.originDate.slice(0, 4)) <= year && (t.status === 'blocked' || t.year > year))
    .reduce((s, t) => s.plus(D(t.amountEur)), ZERO);

  return {
    year,
    sections,
    rcm: {
      interest: c(interest), dividends: c(dividends), staking: c(staking), bonds: c(bonds), capitalExcess: c(capitalExcess),
      grossTotal: c(grossTotal), custody: c(custody), net: c(grossTotal.minus(custody)), spanishTax: c(spanishTax),
      foreignTax: c(foreignTax), nonDeductibleFees: c(nonDeductible),
    },
    rewards: c(rewards),
    doubleTax,
    doubleTaxDeduction: c(doubleTaxDeduction),
    art80Limit: c(art80Limit),
    deferred: { generated: c(generated), released: c(releasedTotal), pendingEnd: c(pendingEnd), tranches },
    savings: {
      gppBalance: c(comp.gpp), rcmBalance: c(comp.rcm), steps: comp.steps, base: c(base), tax: c(tax),
      avgRate: toStr(avgRate.times(100), 2), brackets,
      taxAfterCredits: c(Decimal.max(ZERO, tax.minus(doubleTaxDeduction).minus(spanishTax))), carryForward: comp.carry,
    },
    yearEnd: (res.snapshots[year] ?? []).filter((p) => !D(p.quantity).isZero()).map((p) => ({
      assetId: p.assetId, assetName: p.assetName, class: p.class, quantity: p.quantity, costEur: c(D(p.costEur)), byBroker: p.byBroker,
    })),
    issues: issuesForYear(res, year),
  };
}
