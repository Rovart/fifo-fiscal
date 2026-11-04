import { D, Decimal, ZERO, cents } from '../shared/decimal.ts';
import type { Broker, BrokerFreshness, LatentLoss, YearEndReview } from '../shared/types.ts';
import { db } from './db.ts';
import { storedQuotes } from './quotes.ts';
import { engine, report, today } from './service.ts';

const STALE_DAYS = 31;
const WASH_CLASSES = ['stock', 'etf', 'fund'];
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b.slice(0, 10)) - Date.parse(a.slice(0, 10))) / 86400000);
const monthsBack = (date: string, months: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

/** Un extracto subido hoy cubre hasta hoy aunque su último movimiento sea antiguo. */
export function brokerFreshness(): BrokerFreshness[] {
  const now = today();
  const rows = db.prepare(`SELECT o.broker, MAX(o.datetime) AS last_op, (SELECT MAX(i.at) FROM imports i WHERE i.broker = o.broker) AS last_import
    FROM operations o WHERE o.deleted = 0 AND o.broker NOT IN ('manual', 'cointracking') GROUP BY o.broker`).all() as { broker: Broker; last_op: string; last_import: string | null }[];
  const positions = engine().positions;
  return rows.map((r) => {
    const upTo = [r.last_op.slice(0, 10), r.last_import?.slice(0, 10) ?? ''].sort().at(-1)!;
    const holds = positions.some((p) => p.class !== 'fx' && D(p.byBroker[r.broker] ?? 0).gt(0));
    // Sin posiciones y sin actividad en el último año, no hace falta seguir subiendo extractos.
    const active = holds || daysBetween(r.last_op, now) <= 365;
    return { broker: r.broker, lastImportAt: r.last_import, lastOpAt: r.last_op, upTo, holds, stale: active && daysBetween(upTo, now) > STALE_DAYS };
  }).sort((a, b) => a.upTo.localeCompare(b.upTo));
}

/** Lo que aún se puede hacer antes del 31 de diciembre: pérdidas sin realizar que compensarían lo ganado. */
export function yearEndReview(): YearEndReview {
  const now = today();
  const year = Number(now.slice(0, 4));
  const res = engine();
  const rep = report(year);
  const quotes = storedQuotes();
  const recentFrom = monthsBack(now, 2);
  const losses: LatentLoss[] = [];
  for (const p of res.positions) {
    const price = quotes[p.assetId]?.priceEur;
    if (p.class === 'fx' || !price || D(p.quantity).lte(0)) continue;
    const value = D(p.quantity).times(D(price));
    const latent = value.minus(D(p.costEur));
    if (latent.gte(-1)) continue;
    const recentBuy = WASH_CLASSES.includes(p.class) && res.openLots.some((l) => l.assetId === p.assetId && l.acqDate.slice(0, 10) >= recentFrom);
    losses.push({ assetId: p.assetId, assetName: p.assetName, class: p.class, quantity: p.quantity, costEur: cents(D(p.costEur)), valueEur: cents(value), latentEur: cents(latent), recentBuy });
  }
  losses.sort((a, b) => D(a.latentEur).cmp(D(b.latentEur)));
  const usable = losses.filter((l) => !l.recentBuy).reduce((s, l) => s.plus(D(l.latentEur).abs()), ZERO);
  const gains = D(rep.savings.gppBalance);
  const offset = gains.gt(0) ? Decimal.min(gains, usable) : ZERO;
  const brackets = rep.savings.brackets;
  const marginal = [...brackets].reverse().find((b) => D(b.base).gt(0))?.rate ?? brackets[0]?.rate ?? '19';
  const quoted = Object.values(quotes).map((q) => q.fetchedAt).filter((x): x is string => !!x).sort();
  return {
    year, gppBalanceEur: cents(gains), marginalRate: marginal, latentLossEur: cents(losses.reduce((s, l) => s.plus(D(l.latentEur)), ZERO)),
    offsetEur: cents(offset), savingEur: cents(offset.times(D(marginal)).div(100)), losses, quotesAt: quoted.at(-1) ?? null,
  };
}
