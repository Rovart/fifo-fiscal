import { D, isNum } from '../../shared/decimal.ts';
import type { Asset, Position } from '../../shared/types.ts';
import type { PortfolioQuote } from './api.ts';
import { isinOf } from './format.ts';

/** El mismo criterio de restos que utiliza la página de Cartera. */
export function isZeroPosition(position: Position, quote?: PortfolioQuote): boolean {
  const price = position.class === 'fx' ? null : quote?.priceEur;
  return D(position.quantity).toDecimalPlaces(8).isZero()
    || (D(position.costEur).abs().lt('0.01') && isNum(price) && D(price).gte(0) && D(position.quantity).times(D(price)).lt('0.01'));
}

export function holdings(positions: Position[], quotes: Record<string, PortfolioQuote>, assets: Asset[]) {
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const rows = positions
    .filter((p) => p.class !== 'fx' && D(p.quantity).gt(0) && !isZeroPosition(p, quotes[p.assetId]))
    .map((position) => {
      const quote = quotes[position.assetId];
      const price = quote?.priceEur;
      const value = isNum(price) && D(price).gte(0) ? D(position.quantity).times(D(price)) : null;
      const cost = D(position.costEur);
      const ticker = position.class === 'crypto' ? position.assetId
        : assetById.get(position.assetId)?.ticker
          || (quote?.symbol !== 'Kraken' ? quote?.symbol : null)
          || (!isinOf(position.assetId) ? position.assetId : null);
      return {
        position, ticker,
        valueEur: value?.toFixed() ?? null,
        gainPercent: value !== null && cost.gt(0) ? value.minus(cost).div(cost).times(100).toFixed() : null,
      };
    })
    .sort((a, b) => (a.ticker || a.position.assetName).localeCompare(b.ticker || b.position.assetName, 'es'));

  const priced = rows.filter((row) => row.valueEur !== null);
  const value = priced.reduce((sum, row) => sum.plus(D(row.valueEur)), D(0));
  const cost = rows.reduce((sum, row) => sum.plus(D(row.position.costEur)), D(0));
  // Un total solo es comparable si conocemos el precio y el coste de todos.
  const complete = rows.length > 0 && rows.every((row) => row.gainPercent !== null);
  return {
    rows,
    valueEur: priced.length ? value.toFixed() : null,
    gainPercent: complete && cost.gt(0) ? value.minus(cost).div(cost).times(100).toFixed() : null,
    unpriced: rows.length - priced.length,
  };
}
