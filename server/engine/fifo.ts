import { D, Decimal, ZERO, cents, isNum, toStr } from '../../shared/decimal.ts';
import { expectedTotal, reconcile } from '../../shared/reconcile.ts';
import type {
  Asset, Broker, Disposal, DisposalClass, EngineResult, FeeEntry, Income, Issue, LossTranche, Match,
  OpKind, OpenLot, Operation, Position, Settings,
} from '../../shared/types.ts';
import { KIND_LABEL } from '../../shared/types.ts';
import { addMonths, dateOf, yearOf, nextMonth } from './dates.ts';

export interface EngineInput {
  ops: Operation[];
  assets: Map<string, Asset>;
  settings: Settings;
  /** Unidades de divisa por 1 EUR en esa fecha (BCE). */
  rateAt: (currency: string, date: string) => Decimal | null;
  today: string;
  /** Guarda también las posiciones a cierre de cada mes. */
  monthly?: boolean;
}

interface Block { tranche: Tranche; qty: Decimal; amount: Decimal }

interface Lot {
  id: string;
  assetId: string;
  assetName: string;
  klass: DisposalClass;
  opId: string | null;
  date: string;
  qty: Decimal;
  cost: Decimal;
  costLocal: Decimal;
  feesEur: Decimal;
  currency: string;
  isPurchase: boolean;
  blocks: Block[];
}

interface Tranche {
  id: string;
  assetId: string;
  assetName: string;
  klass: DisposalClass;
  originDisposalId: string;
  originMatch: number;
  originDate: string;
  qty: Decimal;
  amount: Decimal;
  date: string;
  windowEnd: string;
}

interface AssetBook {
  lots: Lot[];
  pending: Tranche[];
  purchases: { date: string; key: string }[];
  history: { date: string; qty: Decimal }[];
}

const ORDER_RANK: Partial<Record<OpKind, number>> = {
  split: 0, isin_change: 0, buy: 1, staking: 1, reward: 1, deposit: 1, transfer_in: 1,
  dividend: 2, interest: 2, return_capital: 2, swap: 3, fx: 3, fee: 3, sell: 4, withdrawal: 4, transfer_out: 4,
};

export const sortOps = (ops: Operation[]): Operation[] =>
  [...ops].sort((a, b) => {
    if (a.datetime !== b.datetime) return a.datetime < b.datetime ? -1 : 1;
    const r = (ORDER_RANK[a.kind] ?? 5) - (ORDER_RANK[b.kind] ?? 5);
    return r !== 0 ? r : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

const FX_PREFIX = 'FX:';
const NEEDS_VALUE: OpKind[] = ['buy', 'sell', 'swap', 'staking', 'reward'];
const WASH_CLASSES: DisposalClass[] = ['stock', 'etf', 'fund'];

/** Aplica el tipo oficial del BCE si así se ha configurado. No toca lo guardado. */
function resolveOp(op: Operation, settings: Settings, rateAt: EngineInput['rateAt']): Operation {
  if (settings.fxSource !== 'ecb' || op.currency === 'EUR' || !isNum(op.grossLocal)) return op;
  if (!['buy', 'sell', 'dividend', 'interest', 'return_capital', 'fee', 'deposit', 'withdrawal'].includes(op.kind)) return op;
  const r = rateAt(op.currency, dateOf(op.datetime));
  if (!r) return op;
  const next: Operation = { ...op, fxRate: r.toFixed(), grossEur: cents(D(op.grossLocal).div(r)) };
  next.totalEur = cents(expectedTotal(next));
  return next;
}

export function runEngine(input: EngineInput): EngineResult {
  const { assets, settings, rateAt, today } = input;
  const books = new Map<string, AssetBook>();
  const names = new Map<string, { name: string; klass: DisposalClass }>();
  const disposals: Disposal[] = [];
  const tranchesOut: LossTranche[] = [];
  const incomes: Income[] = [];
  const fees: FeeEntry[] = [];
  const issues: Issue[] = [];
  const brokerQty = new Map<string, Map<string, Decimal>>();
  const brokerOfOp = new Map(input.ops.map((o) => [o.id, o.broker]));
  const snapshots: Record<number, Position[]> = {};
  const monthly: Record<string, Position[]> = {};
  let currentMonth: string | null = null;
  const years = new Set<number>();
  let seq = 0;

  const book = (assetId: string): AssetBook => {
    let b = books.get(assetId);
    if (!b) { b = { lots: [], pending: [], purchases: [], history: [] }; books.set(assetId, b); }
    return b;
  };
  const holdings = (assetId: string): Decimal => book(assetId).lots.reduce((s, l) => s.plus(l.qty), ZERO);
  const noteHistory = (assetId: string, date: string) => book(assetId).history.push({ date, qty: holdings(assetId) });
  const moveBroker = (assetId: string, broker: string, delta: Decimal) => {
    let m = brokerQty.get(assetId);
    if (!m) { m = new Map(); brokerQty.set(assetId, m); }
    m.set(broker, (m.get(broker) ?? ZERO).plus(delta));
  };

  // Lo recibido de fuera sin haberlo sacado antes: se conoce la cantidad, no lo que costó.
  const outside = new Map<string, Decimal>();
  const soldFromOutside: Issue[] = [];
  const useOutside = (assetId: string, qty: Decimal): boolean => {
    const pending = outside.get(assetId) ?? ZERO;
    if (pending.lte(0)) return false;
    outside.set(assetId, Decimal.max(ZERO, pending.minus(qty)));
    return qty.lte(pending.plus('0.00001'));
  };

  const washMonths = (assetId: string, klass: DisposalClass): number | null => {
    if (!WASH_CLASSES.includes(klass)) return null;
    const a = assets.get(assetId);
    if (a?.washMonthsOverride) return a.washMonthsOverride;
    return settings.washMonths[a?.market ?? 'eu'];
  };

  const emitTranche = (t: Tranche, status: LossTranche['status'], blocker?: Lot, ahead?: Decimal) => {
    tranchesOut.push({
      id: t.id, assetId: t.assetId, assetName: t.assetName, class: t.klass,
      originDisposalId: t.originDisposalId, originDate: t.originDate,
      quantity: toStr(t.qty, 10), amountEur: toStr(t.amount, 6), status,
      date: t.date, year: yearOf(t.date), windowEnd: t.windowEnd,
      blockerLotId: blocker?.id, blockerDate: blocker?.date, aheadQty: ahead && toStr(ahead, 10),
    });
  };

  const splitTranche = (t: Tranche, qty: Decimal): Tranche => {
    const amount = t.qty.isZero() ? ZERO : t.amount.times(qty.div(t.qty));
    const part: Tranche = { ...t, id: `${t.id}.${++seq}`, qty, amount };
    t.qty = t.qty.minus(qty);
    t.amount = t.amount.minus(amount);
    return part;
  };

  const freeQty = (lot: Lot): Decimal => lot.blocks.reduce((s, b) => s.minus(b.qty), lot.qty);

  /** Asigna valores recomprados anteriores a la venta (AEAT, Manual Renta 2025, procedimiento de recompra). */
  const blockWithPrior = (t: Tranche, assetId: string, months: number) => {
    const b = book(assetId);
    const start = addMonths(t.date, -months);
    const priorPurchases = b.purchases.filter((p) => p.date >= start && p.date <= t.date);
    const distinct = new Set(priorPurchases.map((p) => p.key));
    const before = [...b.history].reverse().find((h) => h.date < start);
    if (distinct.size === 1 && (!before || before.qty.isZero())) return;
    for (const lot of b.lots) {
      if (t.qty.isZero()) break;
      if (!lot.isPurchase || dateOf(lot.date) < start || dateOf(lot.date) > t.date) continue;
      const free = freeQty(lot);
      if (free.lte(0)) continue;
      const q = Decimal.min(free, t.qty);
      const part = splitTranche(t, q);
      lot.blocks.push({ tranche: part, qty: q, amount: part.amount });
    }
  };

  const openLoss = (t: Tranche, assetId: string, months: number) => {
    blockWithPrior(t, assetId, months);
    if (t.qty.gt(0) && t.amount.gt(0)) {
      t.windowEnd = addMonths(t.date, months);
      book(assetId).pending.push(t);
    }
  };

  /** Una nueva compra bloquea las pérdidas cuya ventana sigue abierta. */
  const blockPendingWithLot = (lot: Lot) => {
    const b = book(lot.assetId);
    const day = dateOf(lot.date);
    b.pending = b.pending.filter((t) => {
      if (t.windowEnd < day) {
        emitTranche(t, 'integrated');
        return false;
      }
      const free = freeQty(lot);
      if (free.lte(0)) return true;
      const q = Decimal.min(free, t.qty);
      const part = t.qty.eq(q) ? t : splitTranche(t, q);
      lot.blocks.push({ tranche: part, qty: q, amount: part.amount });
      return t.qty.gt(0) && t !== part;
    });
  };

  const newLot = (p: {
    assetId: string; assetName: string; klass: DisposalClass; opId: string | null; date: string; qty: Decimal; cost: Decimal;
    costLocal?: Decimal; feesEur?: Decimal; currency?: string; isPurchase: boolean; orderKey?: string;
  }): Lot => {
    const lot: Lot = {
      id: `L${++seq}`, assetId: p.assetId, assetName: p.assetName, klass: p.klass, opId: p.opId, date: p.date,
      qty: p.qty, cost: p.cost, costLocal: p.costLocal ?? p.cost, feesEur: p.feesEur ?? ZERO, currency: p.currency ?? 'EUR',
      isPurchase: p.isPurchase, blocks: [],
    };
    const b = book(p.assetId);
    b.lots.push(lot);
    b.lots.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0));
    if (p.isPurchase) {
      b.purchases.push({ date: dateOf(p.date), key: p.orderKey ?? lot.id });
      blockPendingWithLot(lot);
    }
    noteHistory(p.assetId, dateOf(p.date));
    return lot;
  };

  interface Consumed { lot: Lot; qty: Decimal; cost: Decimal; costLocal: Decimal; feesEur: Decimal }

  const consume = (assetId: string, qty: Decimal, released: Tranche[], date: string): { used: Consumed[]; shortfall: Decimal } => {
    const b = book(assetId);
    const used: Consumed[] = [];
    let left = qty;
    while (left.gt(0) && b.lots.length) {
      const lot = b.lots[0] as Lot;
      const take = Decimal.min(lot.qty, left);
      const ratio = lot.qty.isZero() ? ZERO : take.div(lot.qty);
      const c: Consumed = {
        lot, qty: take, cost: lot.cost.times(ratio), costLocal: lot.costLocal.times(ratio), feesEur: lot.feesEur.times(ratio),
      };
      used.push(c);
      // Los valores considerados recomprados son los primeros del lote.
      let toRelease = take;
      while (toRelease.gt(0) && lot.blocks.length) {
        const block = lot.blocks[0] as Block;
        const r = Decimal.min(block.qty, toRelease);
        const part = block.qty.eq(r) ? block.tranche : splitTranche(block.tranche, r);
        block.qty = block.qty.minus(r);
        if (block.qty.isZero()) lot.blocks.shift();
        released.push({ ...part, date, windowEnd: date });
        toRelease = toRelease.minus(r);
      }
      lot.qty = lot.qty.minus(take);
      lot.cost = lot.cost.minus(c.cost);
      lot.costLocal = lot.costLocal.minus(c.costLocal);
      lot.feesEur = lot.feesEur.minus(c.feesEur);
      if (lot.qty.isZero()) b.lots.shift();
      left = left.minus(take);
    }
    return { used, shortfall: left };
  };

  const dispose = (p: {
    op: Operation; assetId: string; assetName: string; klass: DisposalClass; qty: Decimal; proceeds: Decimal;
    clave?: 'F' | 'N'; incomplete?: boolean; splitRate?: Decimal | null;
  }): Disposal => {
    const date = dateOf(p.op.datetime);
    const released: Tranche[] = [];
    const { used, shortfall } = consume(p.assetId, p.qty, released, date);
    const unit = p.qty.isZero() ? ZERO : p.proceeds.div(p.qty);
    const id = `D${++seq}`;
    const matches: Match[] = [];
    let costTotal = ZERO;
    const months = washMonths(p.assetId, p.klass);
    const newLosses: { idx: number; qty: Decimal; amount: Decimal }[] = [];

    for (const u of used) {
      let cost = u.cost;
      if (p.splitRate && u.lot.currency === p.op.currency && p.op.currency !== 'EUR') {
        // V0282-22 y V0152-26: resultado en la divisa del valor, al cambio de la venta. El resto es efecto divisa.
        const principalAtSale = u.costLocal.div(p.splitRate);
        const principalAtBuy = u.cost.minus(u.feesEur);
        cost = principalAtSale.plus(u.feesEur);
        const gain = principalAtSale.minus(principalAtBuy);
        disposals.push({
          id: `D${++seq}`, opId: p.op.id, date, year: yearOf(date), assetId: `${FX_PREFIX}${p.op.currency}`,
          assetName: p.op.currency, class: 'fx', broker: p.op.broker, quantity: toStr(u.costLocal, 8),
          proceedsEur: toStr(principalAtSale, 6), costEur: toStr(principalAtBuy, 6), gainEur: toStr(gain, 6),
          matches: [{
            lotId: u.lot.id, acqOpId: u.lot.opId, acqDate: u.lot.date, quantity: toStr(u.costLocal, 8),
            costEur: toStr(principalAtBuy, 6), proceedsEur: toStr(principalAtSale, 6), gainEur: toStr(gain, 6),
          }],
          shortfall: '0', derived: true, simulated: p.op.simulated,
        });
      }
      const proceeds = unit.times(u.qty);
      const gain = proceeds.minus(cost);
      costTotal = costTotal.plus(cost);
      matches.push({
        lotId: u.lot.id, acqOpId: u.lot.opId, acqDate: u.lot.date, quantity: toStr(u.qty, 10),
        costEur: toStr(cost, 6), proceedsEur: toStr(proceeds, 6), gainEur: toStr(gain, 6), broker: u.lot.opId ? brokerOfOp.get(u.lot.opId) : undefined,
      });
      if (months && gain.lt(0)) newLosses.push({ idx: matches.length - 1, qty: u.qty, amount: gain.abs() });
    }
    if (shortfall.gt(0)) {
      const proceeds = unit.times(shortfall);
      matches.push({
        lotId: 'FALTA', acqOpId: null, acqDate: date, quantity: toStr(shortfall, 10),
        costEur: '0', proceedsEur: toStr(proceeds, 6), gainEur: toStr(proceeds, 6), missing: true,
      });
    }
    const disposal: Disposal = {
      id, opId: p.op.id, date, year: yearOf(date), assetId: p.assetId, assetName: p.assetName, class: p.klass,
      broker: p.op.broker, quantity: toStr(p.qty, 10), proceedsEur: toStr(p.proceeds, 6), costEur: toStr(costTotal, 6),
      gainEur: toStr(p.proceeds.minus(costTotal), 6), clave: p.clave, matches, shortfall: toStr(shortfall, 10),
      incomplete: p.incomplete, simulated: p.op.simulated,
    };
    disposals.push(disposal);

    if (months) {
      for (const l of newLosses) {
        openLoss({
          id: `T${++seq}`, assetId: p.assetId, assetName: p.assetName, klass: p.klass, originDisposalId: id,
          originMatch: l.idx, originDate: date, qty: l.qty, amount: l.amount, date, windowEnd: date,
        }, p.assetId, months);
      }
      for (const t of released) openLoss(t, p.assetId, months);
    } else {
      for (const t of released) emitTranche(t, 'integrated');
    }
    noteHistory(p.assetId, date);
    if (shortfall.gt(0)) {
      const fromOutside = useOutside(p.assetId, shortfall);
      const issue: Issue = {
        severity: 'error', code: 'missing_lots', opId: p.op.id, assetId: p.assetId, assetName: p.assetName, date, quantity: toStr(shortfall, 8), year: yearOf(date),
        message: fromOutside
          ? `Vendiste ${toStr(shortfall, 8)} que llegaron de fuera. Falta lo que te costaron.`
          : `Has vendido ${toStr(shortfall, 8)} más de lo que consta como comprado.`,
      };
      issues.push(issue);
      if (fromOutside) soldFromOutside.push(issue);
    }
    return disposal;
  };

  const fxAsset = (c: string) => `${FX_PREFIX}${c}`;

  // Lo gastado en una moneda antes de tenerla, a la espera del cambio que lo pague (habitual con AutoFX).
  const shorts = new Map<string, { qty: Decimal; eur: Decimal }[]>();

  const cashIn = (op: Operation, currency: string, raw: Decimal, eur: Decimal) => {
    const amount = raw.toDecimalPlaces(2);
    if (!settings.fxTracking || currency === 'EUR' || amount.lte(0)) return;
    const date = dateOf(op.datetime);
    const open = shorts.get(currency) ?? [];
    let left = amount;
    while (left.gt(0) && open.length) {
      const s = open[0] as { qty: Decimal; eur: Decimal };
      const take = Decimal.min(s.qty, left);
      const proceeds = s.eur.times(take.div(s.qty));
      const cost = eur.times(take.div(amount));
      const gain = proceeds.minus(cost);
      disposals.push({
        id: `D${++seq}`, opId: op.id, date, year: yearOf(date), assetId: fxAsset(currency), assetName: currency, class: 'fx', broker: op.broker,
        quantity: toStr(take, 8), proceedsEur: toStr(proceeds, 6), costEur: toStr(cost, 6), gainEur: toStr(gain, 6),
        matches: [{ lotId: 'CAMBIO', acqOpId: op.id, acqDate: op.datetime, quantity: toStr(take, 8), costEur: toStr(cost, 6), proceedsEur: toStr(proceeds, 6), gainEur: toStr(gain, 6) }],
        shortfall: '0', simulated: op.simulated,
      });
      s.qty = s.qty.minus(take);
      s.eur = s.eur.minus(proceeds);
      if (s.qty.isZero()) open.shift();
      left = left.minus(take);
    }
    if (left.gt(0)) {
      newLot({
        assetId: fxAsset(currency), assetName: currency, klass: 'fx', opId: op.id, date: op.datetime, qty: left, cost: eur.times(left.div(amount)),
        isPurchase: false,
      });
    }
    moveBroker(fxAsset(currency), op.broker, amount);
  };

  const cashOut = (op: Operation, currency: string, raw: Decimal, eur: Decimal) => {
    const amount = raw.toDecimalPlaces(2);
    if (!settings.fxTracking || currency === 'EUR' || amount.lte(0)) return;
    const held = Decimal.min(holdings(fxAsset(currency)), amount);
    if (held.gt(0)) dispose({ op, assetId: fxAsset(currency), assetName: currency, klass: 'fx', qty: held, proceeds: eur.times(held.div(amount)) });
    if (held.lt(amount)) {
      const list = shorts.get(currency) ?? [];
      list.push({ qty: amount.minus(held), eur: eur.times(amount.minus(held).div(amount)) });
      shorts.set(currency, list);
    }
    moveBroker(fxAsset(currency), op.broker, amount.neg());
  };

  /** Importe y contravalor que mueve en su moneda una compra o venta. */
  const tradeCash = (op: Operation, total: Decimal, rate: Decimal | null): { amount: Decimal; eur: Decimal } | null => {
    if (op.feesInEur) {
      if (!fxLedgers.has(op.broker)) return null;
      const local = D(op.grossLocal);
      return { amount: op.currency === 'GBX' && op.settleCurrency === 'GBP' ? local.div(100) : local, eur: D(op.grossEur) };
    }
    return rate ? { amount: total.times(rate), eur: total } : null;
  };

  const snapshot = (year: number) => {
    snapshots[year] = buildPositions();
  };

  const buildPositions = (): Position[] => {
    const out: Position[] = [];
    for (const [assetId, b] of books) {
      const qty = b.lots.reduce((s, l) => s.plus(l.qty), ZERO);
      const cost = b.lots.reduce((s, l) => s.plus(l.cost), ZERO);
      const meta = names.get(assetId);
      const by: Record<string, string> = {};
      for (const [k, v] of brokerQty.get(assetId) ?? []) if (!v.isZero()) by[k] = toStr(v, 10);
      if (qty.isZero() && Object.keys(by).length === 0) continue;
      out.push({
        assetId, assetName: meta?.name ?? assetId, class: meta?.klass ?? 'other', quantity: toStr(qty, 10), costEur: toStr(cost, 6), byBroker: by,
      });
    }
    return out.sort((a, b) => a.assetName.localeCompare(b.assetName));
  };

  let currentYear: number | null = null;
  // Sin los cambios de divisa del bróker, su saldo en moneda no se puede reconstruir.
  const fxLedgers = new Set(input.ops.filter((o) => o.kind === 'fx' && !o.deleted).map((o) => o.broker));
  // El cambio ligado a una orden se valora al tipo de esa orden: su comisión AutoFX ya va en la operación.
  const orderRates = new Map<string, { local: Decimal; eur: Decimal; currency: string }>();
  for (const raw of input.ops) {
    if (raw.deleted || !raw.feesInEur || !raw.orderRef || (raw.kind !== 'buy' && raw.kind !== 'sell')) continue;
    const o = resolveOp(raw, settings, rateAt);
    const e = orderRates.get(raw.orderRef) ?? { local: ZERO, eur: ZERO, currency: o.currency };
    e.local = e.local.plus(D(o.grossLocal));
    e.eur = e.eur.plus(D(o.grossEur));
    orderRates.set(raw.orderRef, e);
  }

  for (const raw of sortOps(input.ops.filter((o) => !o.deleted))) {
    const op = resolveOp(raw, settings, rateAt);
    const y = yearOf(op.datetime);
    if (currentYear !== null && y !== currentYear) {
      for (let yy = currentYear; yy < y; yy++) snapshot(yy);
    }
    currentYear = y;
    years.add(y);
    const month = op.datetime.slice(0, 7);
    if (input.monthly && currentMonth && month !== currentMonth) {
      const closing = buildPositions();
      for (let m = currentMonth; m < month; m = nextMonth(m)) monthly[m] = closing;
    }
    currentMonth = month;
    const klass = op.assetClass as DisposalClass;
    if (op.assetId) names.set(op.assetId, { name: op.assetName || op.assetId, klass });
    if (settings.fxTracking && op.currency !== 'EUR' && op.currency) names.set(fxAsset(op.currency), { name: op.currency, klass: 'fx' });

    if (op.reviewReasons?.length && !op.simulated) {
      for (const reason of op.reviewReasons) {
        issues.push({ severity: 'warning', code: 'needs_review', opId: op.id, assetId: op.assetId, assetName: op.assetName, date: dateOf(op.datetime), year: y, reason, message: reason });
      }
    }
    if (!op.simulated) {
      const rec = reconcile(raw, settings.toleranceEur);
      if (!isNum(raw.grossEur) && NEEDS_VALUE.includes(raw.kind)) {
        issues.push({
          severity: 'error', code: 'missing_valuation', opId: op.id, assetId: op.assetId, assetName: op.assetName, date: dateOf(raw.datetime), year: y,
          message: `${KIND_LABEL[raw.kind]} sin precio en euros.`,
        });
      } else if (!rec.ok) {
        const bad = rec.missing.length ? `Falta: ${rec.missing.join(', ').toLowerCase()}.` : 'Los importes no cuadran.';
        issues.push({ severity: 'error', code: 'unbalanced', opId: op.id, assetId: op.assetId, assetName: op.assetName, date: dateOf(op.datetime), year: y, message: bad });
      }
    }

    const q = D(op.quantity);
    const total = D(op.totalEur);
    const rate = isNum(op.fxRate) && D(op.fxRate).gt(0) ? D(op.fxRate) : null;
    const date = dateOf(op.datetime);
    const splitRate = settings.fxMethod === 'split' && op.currency !== 'EUR' ? rate : null;
    const settleForeign = op.settleCurrency && op.settleCurrency !== 'EUR' ? op.settleCurrency : null;
    const settleRate = settleForeign ? (settleForeign === op.currency ? rate : rateAt(settleForeign, date)) : null;
    const hasValue = isNum(op.grossEur) && isNum(op.totalEur);

    switch (op.kind) {
      case 'buy': {
        newLot({
          assetId: op.assetId, assetName: op.assetName, klass, opId: op.id, date: op.datetime, qty: q, cost: total,
          costLocal: D(op.grossLocal), feesEur: D(op.feeEur).plus(D(op.otherCostsEur)), currency: op.currency, isPurchase: true,
          orderKey: op.orderRef ?? op.id,
        });
        moveBroker(op.assetId, op.broker, q);
        const paid = settleForeign ? tradeCash(op, total, settleRate) : null;
        if (paid && settleForeign) cashOut(op, settleForeign, paid.amount, paid.eur);
        break;
      }
      case 'sell': {
        dispose({
          op, assetId: op.assetId, assetName: op.assetName, klass, qty: q, proceeds: total, clave: klass === 'crypto' ? 'F' : undefined,
          splitRate, incomplete: !hasValue,
        });
        moveBroker(op.assetId, op.broker, q.neg());
        const got = settleForeign ? tradeCash(op, total, settleRate) : null;
        if (got && settleForeign) cashIn(op, settleForeign, got.amount, got.eur);
        if (klass === 'bond') addBondIncome(op);
        break;
      }
      case 'swap': {
        const value = D(op.grossEur);
        dispose({ op, assetId: op.assetId, assetName: op.assetName, klass, qty: q, proceeds: total, clave: 'N', incomplete: !hasValue });
        moveBroker(op.assetId, op.broker, q.neg());
        const counter = op.counterAsset ?? '';
        names.set(counter, { name: op.counterName || counter, klass });
        newLot({ assetId: counter, assetName: op.counterName || counter, klass, opId: op.id, date: op.datetime, qty: D(op.counterQuantity), cost: value, isPurchase: true });
        moveBroker(counter, op.broker, D(op.counterQuantity));
        break;
      }
      case 'fx': {
        const foreignCur = op.currency !== 'EUR' ? op.currency : op.counterAsset;
        const foreignAmt = op.currency !== 'EUR' ? q : D(op.counterQuantity);
        const link = op.orderRef ? orderRates.get(op.orderRef) : undefined;
        const value = link && link.currency === foreignCur && !link.local.isZero() ? foreignAmt.times(link.eur.div(link.local)) : D(op.grossEur);
        const fee = D(op.feeEur);
        if (op.currency !== 'EUR') cashOut(op, op.currency, q, value.minus(fee));
        const recv = op.counterAsset ?? 'EUR';
        if (recv !== 'EUR') cashIn(op, recv, D(op.counterQuantity), op.currency === 'EUR' ? value.plus(fee) : value);
        break;
      }
      case 'dividend':
      case 'interest': {
        const isin = op.assetId.length === 12 ? op.assetId.slice(0, 2).toUpperCase() : '';
        const withheld = D(op.withholdingEur);
        const spanish = isNum(op.spanishTaxEur) ? Decimal.min(D(op.spanishTaxEur), withheld) : isin === 'ES' ? withheld : ZERO;
        incomes.push({
          opId: op.id, date, year: y, type: op.kind, assetId: op.assetId, assetName: op.assetName, broker: op.broker,
          country: isin, grossEur: toStr(D(op.grossEur), 6), foreignTaxEur: toStr(withheld.minus(spanish), 6),
          spanishTaxEur: toStr(spanish, 6), feeEur: toStr(D(op.feeEur), 6), netEur: toStr(total, 6),
        });
        if (settleForeign && settleRate) cashIn(op, settleForeign, total.times(settleRate), total);
        break;
      }
      case 'return_capital': {
        const value = D(op.grossEur);
        const b = book(op.assetId);
        const basis = b.lots.reduce((s, l) => s.plus(l.cost), ZERO);
        const applied = Decimal.min(value, basis);
        if (basis.gt(0)) {
          for (const l of b.lots) {
            const k = l.cost.div(basis);
            l.cost = l.cost.minus(applied.times(k));
            l.costLocal = l.costLocal.minus(l.costLocal.times(applied.div(basis)));
          }
        }
        const excess = value.minus(applied);
        if (excess.gt(0)) {
          incomes.push({
            opId: op.id, date, year: y, type: 'capital_excess', assetId: op.assetId, assetName: op.assetName, broker: op.broker,
            country: op.assetId.slice(0, 2), grossEur: toStr(excess, 6), foreignTaxEur: '0', spanishTaxEur: '0', feeEur: '0', netEur: toStr(excess, 6),
          });
        }
        if (settleForeign && settleRate) cashIn(op, settleForeign, total.times(settleRate), total);
        break;
      }
      case 'staking':
      case 'reward': {
        incomes.push({
          opId: op.id, date, year: y, type: op.kind, assetId: op.assetId, assetName: op.assetName, broker: op.broker, country: '',
          grossEur: toStr(D(op.grossEur), 6), foreignTaxEur: '0', spanishTaxEur: '0', feeEur: '0', netEur: toStr(D(op.grossEur), 6),
        });
        newLot({ assetId: op.assetId, assetName: op.assetName, klass, opId: op.id, date: op.datetime, qty: q, cost: D(op.grossEur), isPurchase: false });
        moveBroker(op.assetId, op.broker, q);
        break;
      }
      case 'fee': {
        fees.push({
          opId: op.id, date, year: y, broker: op.broker, label: op.note || op.assetName || 'Comisión',
          amountEur: toStr(D(op.grossEur), 6), feeClass: op.feeClass ?? 'non_deductible',
        });
        // Coste pagado en cripto de forma mínima y repetida: reduce el saldo sin contarlo como venta.
        if (klass === 'crypto' && isNum(op.quantity) && q.gt(0)) {
          const { shortfall } = consume(op.assetId, q, [], date);
          if (shortfall.gt(0)) useOutside(op.assetId, shortfall);
          moveBroker(op.assetId, op.broker, q.neg());
          noteHistory(op.assetId, date);
        }
        if (op.currency !== 'EUR' && rate) cashOut(op, op.currency, D(op.grossLocal), D(op.grossEur));
        break;
      }
      case 'deposit': {
        if (op.currency !== 'EUR') cashIn(op, op.currency, D(op.grossLocal), D(op.grossEur));
        break;
      }
      case 'withdrawal': {
        if (settings.fxTracking && op.currency !== 'EUR') {
          consume(fxAsset(op.currency), D(op.grossLocal), [], date);
          moveBroker(fxAsset(op.currency), op.broker, D(op.grossLocal).neg());
        }
        break;
      }
      case 'transfer_in': {
        // Primero vuelve lo que habías sacado; el resto viene de fuera.
        const back = Decimal.min(q, Decimal.max(ZERO, brokerQty.get(op.assetId)?.get('externo') ?? ZERO));
        moveBroker(op.assetId, op.broker, q);
        moveBroker(op.assetId, 'externo', back.neg());
        if (q.gt(back)) outside.set(op.assetId, (outside.get(op.assetId) ?? ZERO).plus(q.minus(back)));
        break;
      }
      case 'transfer_out': {
        moveBroker(op.assetId, op.broker, q.neg());
        moveBroker(op.assetId, 'externo', q);
        break;
      }
      case 'split': {
        const b = book(op.assetId);
        const held = holdings(op.assetId);
        if (held.lte(0)) {
          issues.push({ severity: 'error', code: 'split_no_lots', opId: op.id, assetId: op.assetId, assetName: op.assetName, date, year: y, message: 'Split sin acciones en cartera ese día. Falta alguna compra anterior.' });
          break;
        }
        const ratio = held.plus(q).div(held);
        for (const l of b.lots) {
          l.qty = l.qty.times(ratio);
          for (const block of l.blocks) { block.qty = block.qty.times(ratio); block.tranche.qty = block.tranche.qty.times(ratio); }
        }
        for (const t of b.pending) t.qty = t.qty.times(ratio);
        moveBroker(op.assetId, op.broker, q);
        noteHistory(op.assetId, date);
        break;
      }
      case 'isin_change': {
        const from = book(op.assetId);
        const counter = op.counterAsset ?? '';
        const held = holdings(op.assetId);
        const moved = Decimal.min(q, held);
        if (moved.lt(q)) {
          issues.push({ severity: 'error', code: 'missing_lots', opId: op.id, assetId: op.assetId, assetName: op.assetName, date, quantity: toStr(q.minus(held), 8), year: y, message: `El canje mueve ${toStr(q, 8)} acciones, pero solo constan ${toStr(held, 8)}.` });
        }
        const ratio = q.isZero() ? ZERO : D(op.counterQuantity).div(q);
        names.set(counter, { name: op.counterName || counter, klass });
        const to = book(counter);
        let left = moved;
        const keep: Lot[] = [];
        for (const l of from.lots) {
          if (left.lte(0)) { keep.push(l); continue; }
          const take = Decimal.min(l.qty, left);
          const k = take.div(l.qty);
          const lot: Lot = {
            ...l, id: `L${++seq}`, assetId: counter, assetName: op.counterName || counter,
            qty: take.times(ratio), cost: l.cost.times(k), costLocal: l.costLocal.times(k), feesEur: l.feesEur.times(k), blocks: [],
          };
          let blocked = take;
          while (blocked.gt(0) && l.blocks.length) {
            const block = l.blocks[0] as Block;
            const r = Decimal.min(block.qty, blocked);
            const part = block.qty.eq(r) ? block.tranche : splitTranche(block.tranche, r);
            block.qty = block.qty.minus(r);
            if (block.qty.isZero()) l.blocks.shift();
            part.qty = r.times(ratio);
            lot.blocks.push({ tranche: part, qty: part.qty, amount: part.amount });
            blocked = blocked.minus(r);
          }
          to.lots.push(lot);
          l.qty = l.qty.minus(take); l.cost = l.cost.minus(lot.cost); l.costLocal = l.costLocal.minus(lot.costLocal); l.feesEur = l.feesEur.minus(lot.feesEur);
          if (l.qty.gt(0)) keep.push(l);
          left = left.minus(take);
        }
        from.lots = keep;
        to.lots.sort((x, y2) => (x.date < y2.date ? -1 : x.date > y2.date ? 1 : 0));
        to.pending.push(...from.pending.map((t) => ({ ...t, qty: t.qty.times(ratio) })));
        from.pending = [];
        to.purchases.push(...from.purchases);
        moveBroker(op.assetId, op.broker, q.neg());
        moveBroker(counter, op.broker, D(op.counterQuantity));
        noteHistory(op.assetId, date);
        noteHistory(counter, date);
        break;
      }
    }
  }

  function addBondIncome(op: Operation) {
    const d = disposals[disposals.length - 1] as Disposal;
    incomes.push({
      opId: op.id, date: d.date, year: d.year, type: 'bond', assetId: op.assetId, assetName: op.assetName, broker: op.broker, country: '',
      grossEur: d.gainEur, foreignTaxEur: '0', spanishTaxEur: '0', feeEur: '0', netEur: d.gainEur,
    });
  }

  const openLots: OpenLot[] = [];
  for (const [assetId, b] of books) {
    for (const t of b.pending) {
      emitTranche(t, t.windowEnd >= today ? 'pending_window' : 'integrated');
    }
    let ahead = ZERO;
    for (const l of b.lots) {
      const blocked = l.blocks.reduce((s, x) => s.plus(x.qty), ZERO);
      let inLot = ZERO;
      for (const block of l.blocks) {
        emitTranche(block.tranche, 'blocked', l, ahead.plus(inLot));
        inLot = inLot.plus(block.qty);
      }
      ahead = ahead.plus(l.qty);
      if (l.qty.isZero()) continue;
      openLots.push({
        lotId: l.id, assetId, assetName: l.assetName, class: l.klass, acqDate: l.date, quantity: toStr(l.qty, 10), costEur: toStr(l.cost, 6),
        unitCostEur: toStr(l.cost.div(l.qty), 8), blockedQuantity: toStr(blocked, 10), acqOpId: l.opId,
      });
    }
  }

  for (const [currency, open] of shorts) {
    const missing = open.reduce((s, x) => s.plus(x.qty), ZERO);
    if (missing.gte('1')) {
      issues.push({
        severity: 'info', code: 'fx_shortfall',
        message: `Consta un gasto de ${toStr(missing, 2)} ${currency} sin saldo previo. No cuenta como ganancia ni pérdida. Si tenías esa moneda, añade cómo la conseguiste.`,
      });
    }
  }

  // Sensibilidad al criterio sobre mercados no UE y a la recompra de cripto.
  for (const d of disposals) {
    const loss = d.matches.some((m) => D(m.gainEur).lt(0));
    if (!loss || d.simulated) continue;
    const a = assets.get(d.assetId);
    const b = books.get(d.assetId);
    if (!b) continue;
    if (WASH_CLASSES.includes(d.class) && a?.market === 'us' && !a.washMonthsOverride && settings.washMonths.us === 2) {
      const lo = addMonths(d.date, -12), hi = addMonths(d.date, 12), lo2 = addMonths(d.date, -2), hi2 = addMonths(d.date, 2);
      // Con plazo de un año bloquearían las compras posteriores y las anteriores que sigan en cartera.
      const later = b.purchases.some((p) => p.date > hi2 && p.date <= hi);
      const stillHeld = b.lots.some((l) => l.isPurchase && dateOf(l.date) >= lo && dateOf(l.date) < lo2);
      if (later || stillHeld) {
        issues.push({
          severity: 'info', code: 'us_wash_sensitive', opId: d.opId, assetId: d.assetId, assetName: d.assetName, date: d.date, year: d.year,
          message: 'Vendiste con pérdida y compraste entre 2 y 12 meses antes o después. Con el plazo de 1 año, parte quedaría aplazada.',
        });
      }
    }
    if (d.class === 'crypto') {
      const hi = addMonths(d.date, 12);
      if (b.purchases.some((p) => p.date > d.date && p.date <= hi)) {
        issues.push({
          severity: 'info', code: 'crypto_repurchase', opId: d.opId, assetId: d.assetId, assetName: d.assetName, date: d.date, year: d.year,
          message: 'Vendiste con pérdida y recompraste antes de un año. Normalmente no limita la pérdida, pero no hay criterio cerrado.',
        });
      }
    }
  }

  const positions = buildPositions();
  if (currentYear !== null) {
    const endYear = Math.max(currentYear, yearOf(today));
    for (let yy = currentYear; yy <= endYear; yy++) snapshots[yy] = positions;
  }

  // Si todo lo llegado de fuera ya se vendió, los lotes siguientes quedan igual que si constara su coste.
  for (const i of soldFromOutside) i.settled = (outside.get(i.assetId as string) ?? ZERO).lt('0.00001');
  if (input.monthly && currentMonth) {
    for (let m = currentMonth; m <= input.today.slice(0, 7); m = nextMonth(m)) monthly[m] = positions;
  }
  return { disposals, tranches: tranchesOut, incomes, fees, openLots, positions, snapshots, issues, years: [...years].sort(), ...(input.monthly ? { monthly } : {}) };
}

export type { Broker };
