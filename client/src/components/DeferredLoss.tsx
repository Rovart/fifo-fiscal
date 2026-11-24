import { CalendarClock } from 'lucide-react';
import { D, type Decimal } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type LossTranche } from '../../../shared/types.ts';
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
  buys: { date: string; broker?: Broker; quantity: Decimal; amount: Decimal }[];
}

/** El motor reparte la pérdida de una venta por lote: aquí vuelve a ser una venta, con la compra que bloquea cada parte. */
export function groupLosses(tranches: LossTranche[]): LossGroup[] {
  const groups = new Map<string, LossGroup>();
  for (const t of tranches) {
    const key = `${t.status}|${t.originDisposalId}|${t.status === 'blocked' ? '' : t.year}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, assetId: t.assetId, assetName: t.assetName, originDate: t.originDate, status: t.status, year: t.year, windowEnd: t.windowEnd, amount: D(0), ahead: null, buys: [] };
      groups.set(key, g);
    }
    g.amount = g.amount.plus(D(t.amountEur));
    if (t.aheadQty && (!g.ahead || D(t.aheadQty).lt(g.ahead))) g.ahead = D(t.aheadQty);
    if (!t.blockerDate) continue;
    const date = t.blockerDate.slice(0, 10);
    const buy = g.buys.find((b) => b.date === date && b.broker === t.blockerBroker);
    if (buy) {
      buy.quantity = buy.quantity.plus(D(t.quantity));
      buy.amount = buy.amount.plus(D(t.amountEur));
    } else {
      g.buys.push({ date, broker: t.blockerBroker, quantity: D(t.quantity), amount: D(t.amountEur) });
    }
  }
  for (const g of groups.values()) g.buys.sort((a, b) => a.date.localeCompare(b.date));
  return [...groups.values()];
}

function roundedBlockingBuys(group: LossGroup) {
  let subtotal = D(0);
  return group.buys.map((buy) => {
    // Redondear los acumulados hace que los importes visibles sumen el subtotal de la venta.
    const previous = subtotal.toDecimalPlaces(2);
    subtotal = subtotal.plus(buy.amount);
    return { ...buy, roundedAmount: subtotal.toDecimalPlaces(2).minus(previous).toFixed(2) };
  });
}

const unitsOf = (quantity: Decimal) => quantity.eq(1) ? '1 unidad' : `${qty(quantity.toFixed())} unidades`;

/** Qué compra hay que vender para que cuente cada parte de la pérdida. */
export function BlockingBuys({ group }: { group: LossGroup }) {
  return (
    <>
      {roundedBlockingBuys(group).map((b) => (
        <div className="small muted" key={`${b.date}|${b.broker ?? ''}`}>
          {eur(b.roundedAmount)} al vender {b.quantity.eq(1) ? 'la unidad comprada' : `las ${unitsOf(b.quantity)} compradas`} el {dateShort(b.date)}{b.broker && ` en ${BROKER_LABEL[b.broker]}`}
        </div>
      ))}
      {group.ahead?.gt(0) && (
        <div className="small faint">{group.ahead.eq(1) ? 'Antes se vende la más antigua.' : `Antes se venden las ${qty(group.ahead.toFixed())} más antiguas.`}</div>
      )}
    </>
  );
}

export function DeferredLossBreakdown({ sales }: { sales: LossGroup[] }) {
  return (
    <div className="deferred-breakdown">
      <h3 className="deferred-heading"><CalendarClock size={16} aria-hidden="true" /> Compras que aplazan esta pérdida</h3>
      {sales.map((sale) => (
        <div className="deferred-sale" key={sale.key}>
          <div className="deferred-sale-header">
            <h4>Venta del <time dateTime={sale.originDate}>{dateShort(sale.originDate)}</time></h4>
            <div className="deferred-value">
              <strong className="num">{eur(sale.amount.toFixed(2))}</strong>
              <div className="muted">aplazados</div>
            </div>
          </div>
          <ul className="deferred-purchases" role="list">
            {roundedBlockingBuys(sale).map((buy) => (
              <li key={`${buy.date}|${buy.broker ?? ''}`}>
                <div>
                  <div className="deferred-purchase-date">
                    <time dateTime={buy.date}>{dateShort(buy.date)}</time>
                    <span>{buy.date < sale.originDate ? 'Compra anterior' : buy.date > sale.originDate ? 'Compra posterior' : 'Compra del mismo día'}</span>
                  </div>
                  <div className="deferred-purchase-meta muted">
                    {buy.broker && <span>{BROKER_LABEL[buy.broker]}</span>}
                    <span>{unitsOf(buy.quantity)}</span>
                  </div>
                </div>
                <span className="num deferred-value">{eur(buy.roundedAmount)}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
