import { D, type Decimal } from '../../../shared/decimal.ts';
import type { LossTranche } from '../../../shared/types.ts';
import { dateShort, eur, qty } from '../format.ts';

export interface LossGroup {
  key: string;
  assetId: string;
  assetName: string;
  originDate: string;
  status: LossTranche['status'];
  year: number;
  windowEnd: string;
  amount: Decimal;
  /** Títulos que se venden antes de empezar a liberar la pérdida. */
  ahead: Decimal | null;
  buys: { date: string; quantity: Decimal; amount: Decimal }[];
}

/** El motor reparte la pérdida de una venta por lote: aquí vuelve a ser una venta, con la compra que bloquea cada parte. */
export function groupLosses(tranches: LossTranche[]): LossGroup[] {
  const groups = new Map<string, LossGroup>();
  for (const t of tranches) {
    const key = `${t.status}|${t.assetId}|${t.originDate}|${t.status === 'blocked' ? '' : t.year}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, assetId: t.assetId, assetName: t.assetName, originDate: t.originDate, status: t.status, year: t.year, windowEnd: t.windowEnd, amount: D(0), ahead: null, buys: [] };
      groups.set(key, g);
    }
    g.amount = g.amount.plus(D(t.amountEur));
    if (t.aheadQty && (!g.ahead || D(t.aheadQty).lt(g.ahead))) g.ahead = D(t.aheadQty);
    if (!t.blockerDate) continue;
    const date = t.blockerDate.slice(0, 10);
    const buy = g.buys.find((b) => b.date === date);
    if (buy) {
      buy.quantity = buy.quantity.plus(D(t.quantity));
      buy.amount = buy.amount.plus(D(t.amountEur));
    } else {
      g.buys.push({ date, quantity: D(t.quantity), amount: D(t.amountEur) });
    }
  }
  for (const g of groups.values()) g.buys.sort((a, b) => a.date.localeCompare(b.date));
  return [...groups.values()];
}

/** Qué compra hay que vender para que cuente cada parte de la pérdida. */
export function BlockingBuys({ group }: { group: LossGroup }) {
  return (
    <>
      {group.buys.map((b) => (
        <div className="small muted" key={b.date}>
          {eur(b.amount.toFixed(2))} al vender {b.quantity.eq(1) ? 'la comprada' : `las ${qty(b.quantity.toFixed())} compradas`} el {dateShort(b.date)}
        </div>
      ))}
      {group.ahead?.gt(0) && (
        <div className="small faint">{group.ahead.eq(1) ? 'Antes se vende la más antigua.' : `Antes se venden las ${qty(group.ahead.toFixed())} más antiguas.`}</div>
      )}
    </>
  );
}
