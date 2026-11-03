import { D, Decimal, ZERO, cents, toStr } from '../../shared/decimal.ts';
import type { AssetClass, Operation } from '../../shared/types.ts';
import { utcToMadrid } from '../engine/dates.ts';
import { addCount, baseOp, finishIncome, finishTrade, num, review } from './common.ts';
import type { ParsedImport, RateFn } from './common.ts';
import { findCol } from './csv.ts';

export const looksLikeTradeRepublic = (h: string[]): boolean =>
  findCol(h, ['transaction_id']) >= 0 && findCol(h, ['asset_class']) >= 0 && findCol(h, ['category']) >= 0;

const classOf = (s: string): AssetClass => {
  const u = s.toUpperCase();
  if (u === 'STOCK') return 'stock';
  if (u === 'FUND') return 'etf';
  if (u === 'CRYPTO') return 'crypto';
  if (u === 'BOND') return 'bond';
  return 'other';
};

const CASH_IGNORED = /^(CUSTOMER_|TRANSFER_|CARD_|BANK_|PAYMENT_|PRE_DETERMINED_TAX_BASE|EARNINGS|PEER_|INSTANT_|SEPA_|DIRECT_DEBIT|REFUND)/;

/**
 * Trade Republic junta en una columna lo retenido fuera y el 19 % español sobre el neto.
 * Si llega al 19 %, separa las dos partes: total = fuera + 19 % × (bruto − fuera).
 */
function spanishPart(gross: Decimal, withheld: Decimal): string | null {
  if (gross.lte(0) || withheld.lte(0) || withheld.lt(gross.times('0.19').minus('0.02'))) return null;
  const foreign = Decimal.max(ZERO, withheld.minus(gross.times('0.19')).div('0.81')).toDecimalPlaces(2);
  return cents(withheld.minus(foreign));
}

export function parseTradeRepublic(headers: string[], rows: string[][], rate: RateFn): ParsedImport {
  const col = (n: string) => findCol(headers, [n]);
  const idx = {
    datetime: col('datetime'), date: col('date'), category: col('category'), type: col('type'), assetClass: col('asset_class'),
    name: col('name'), symbol: col('symbol'), shares: col('shares'), price: col('price'), amount: col('amount'), fee: col('fee'),
    tax: col('tax'), currency: col('currency'), originalAmount: col('original_amount'), originalCurrency: col('original_currency'),
    fxRate: col('fx_rate'), description: col('description'), id: col('transaction_id'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0 && !['datetime', 'originalAmount', 'originalCurrency', 'fxRate', 'description'].includes(k)) {
      throw new Error(`Trade Republic: falta la columna ${k}.`);
    }
  }
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const ops: Operation[] = [];
  const cancelled: { type: string; symbol: string; shares: string; amount: string }[] = [];
  const ipoFees: { symbol: string; name: string; fee: Decimal; datetime: string; key: string }[] = [];

  for (const r of rows) {
    const f = (i: number) => (i >= 0 ? (r[i] ?? '').trim() : '');
    const category = f(idx.category).toUpperCase();
    const type = f(idx.type).toUpperCase();
    const symbol = f(idx.symbol);
    const name = f(idx.name) || symbol;
    const klass = classOf(f(idx.assetClass));
    const id = f(idx.id);
    const rawDt = f(idx.datetime);
    const datetime = rawDt ? utcToMadrid(rawDt) : `${f(idx.date)}T00:00:00`;
    const currency = f(idx.currency) || 'EUR';
    const shares = num(f(idx.shares));
    const price = num(f(idx.price));
    const amount = num(f(idx.amount));
    const fee = num(f(idx.fee))?.abs() ?? ZERO;
    const tax = num(f(idx.tax));
    const key = `tr:${id}`;

    // Prepago de una OPV y devolución de lo no adjudicado: solo mueven efectivo. Lo adjudicado llega como compra.
    if (category === 'CASH' && type === 'IPO_SUBSCRIPTION') {
      addCount(ignored, 'Prepagos y devoluciones de OPV');
      if (!fee.isZero()) ipoFees.push({ symbol, name, fee, datetime, key });
      continue;
    }

    if (category === 'TRADING' && /CANCELLED|CANCELED/.test(type)) {
      cancelled.push({ type: type.replace(/_CANCELL?ED/, ''), symbol, shares: toStr((shares ?? ZERO).abs()), amount: toStr((amount ?? ZERO).abs()) });
      continue;
    }

    if (category === 'TRADING' && (type === 'BUY' || type === 'SELL' || type === 'SAVINGS_PLAN_EXECUTED' || /^(SAVEBACK|ROUND_UP)/.test(type))) {
      if (!shares || shares.isZero()) { addCount(ignored, 'Órdenes sin títulos'); continue; }
      const kind = type === 'SELL' || shares.lt(0) ? 'sell' : 'buy';
      const op = baseOp({ broker: 'trade_republic', kind, datetime, assetId: symbol, assetName: name, assetClass: klass, currency, sourceKey: key });
      const qty = shares.abs();
      const absAmount = amount?.abs() ?? null;
      const gross = price ? qty.times(price) : absAmount;
      // Según la exportación, `amount` puede venir sin comisión o con ella: se admite lo que cuadre.
      const amountIsGross = absAmount && gross ? absAmount.minus(gross).abs().lte('0.02') : true;
      const grossLocal = amountIsGross ? (absAmount ?? gross) : gross;
      // En una compra, es un tributo de la operación (ITF español, TTF francés): forma parte del coste.
      const buyTax = kind === 'buy' && tax ? tax.abs() : ZERO;
      finishTrade(op, { qty, price, grossLocal, grossEur: null, fee, other: buyTax, total: amountIsGross ? null : absAmount, rate });
      if (kind === 'sell' && tax && !tax.isZero()) {
        review(op, 'Trade Republic indica un impuesto en esta venta. Comprueba si es una retención.');
      }
      if (klass === 'bond') review(op, 'Renta fija: tributa como rendimiento (casilla 0031), no como venta de acciones.');
      ops.push(op);
      continue;
    }

    if ((category === 'CASH' && (type === 'DIVIDEND' || type === 'DISTRIBUTION' || type === 'CASH_DIVIDEND' || /^DIVIDEND/.test(type))) || (category === 'CORPORATE_ACTION' && type === 'DISTRIBUTION')) {
      const op = baseOp({ broker: 'trade_republic', kind: 'dividend', datetime, assetId: symbol, assetName: name, assetClass: klass, currency, sourceKey: key });
      const gross = amount ?? ZERO;
      const withheld = tax ? tax.neg() : ZERO;
      finishIncome(op, { grossLocal: gross, withheldLocal: withheld });
      op.spanishTaxEur = spanishPart(gross, withheld);
      if (f(idx.originalCurrency) && f(idx.originalCurrency) !== 'EUR') op.note = `Original: ${f(idx.originalAmount)} ${f(idx.originalCurrency)} al ${f(idx.fxRate)}`;
      if (gross.lt(0)) review(op, 'Corrección de dividendo: comprueba que anula el original.');
      ops.push(op);
      continue;
    }

    if (category === 'CASH' && /^INTEREST/.test(type)) {
      const op = baseOp({ broker: 'trade_republic', kind: 'interest', datetime, assetId: 'TR-CASH', assetName: 'Intereses Trade Republic', assetClass: 'other', currency, sourceKey: key });
      const taxed = tax ? tax.abs() : ZERO;
      finishIncome(op, { grossLocal: amount ?? ZERO, withheldLocal: taxed });
      if (!taxed.isZero()) {
        // Un 19 % es la retención española; otra cosa hay que mirarla.
        if (taxed.minus((amount ?? ZERO).times('0.19')).abs().lte('0.02')) op.spanishTaxEur = cents(taxed);
        else review(op, 'Trade Republic retuvo un porcentaje distinto del 19 % sobre este interés. Comprueba el importe.');
      }
      ops.push(op);
      continue;
    }

    if (category === 'DELIVERY' && type === 'FREE_RECEIPT' && shares && shares.gt(0)) {
      if (klass === 'crypto') {
        const op = baseOp({ broker: 'trade_republic', kind: 'staking', datetime, assetId: symbol, assetName: name, assetClass: 'crypto', sourceKey: key });
        op.quantity = toStr(shares);
        if (price) {
          op.unitPrice = toStr(price);
          op.grossEur = cents(shares.times(price));
          op.totalEur = op.grossEur;
        }
        review(op, 'Cripto recibida gratis: la contamos como staking. Cámbiala si fue otra cosa.');
        ops.push(op);
      } else {
        const op = baseOp({ broker: 'trade_republic', kind: 'buy', datetime, assetId: symbol, assetName: name, assetClass: klass, sourceKey: key });
        finishTrade(op, { qty: shares, price: price ?? D(0), grossLocal: price ? shares.times(price) : D(0), grossEur: null, fee: ZERO });
        review(op, 'Acciones recibidas sin coste. Si es un traspaso, escribe la fecha y el coste de la compra original.');
        ops.push(op);
      }
      continue;
    }

    if (/SAVEBACK|STOCKPERK|BONUS/.test(type) && shares && shares.gt(0)) {
      const op = baseOp({ broker: 'trade_republic', kind: 'reward', datetime, assetId: symbol, assetName: name, assetClass: klass, sourceKey: key });
      op.quantity = toStr(shares);
      if (price) {
        op.unitPrice = toStr(price);
        op.grossEur = cents(shares.times(price));
        op.totalEur = op.grossEur;
      } else if (amount) {
        op.grossEur = cents(amount.abs());
        op.totalEur = op.grossEur;
        op.unitPrice = toStr(amount.abs().div(shares), 10);
      }
      review(op, 'Saveback o regalo en acciones: no hay criterio claro. Lo contamos como ganancia por su valor.');
      ops.push(op);
      continue;
    }

    if (category === 'CORPORATE_ACTION') {
      if ((type === 'STOCK_DIVIDEND' || type === 'OPTIONAL_DIVIDEND' || type === 'SPLIT' || type === 'BONUS_ISSUE') && shares && !shares.isZero()) {
        const op = baseOp({ broker: 'trade_republic', kind: 'split', datetime, assetId: symbol, assetName: name, assetClass: klass, sourceKey: key });
        op.quantity = toStr(shares);
        review(op, 'Acciones recibidas por la empresa: se suman sin coste. Comprueba el número.');
        ops.push(op);
        continue;
      }
      warnings.push(`Operación corporativa ${type} de ${name} (${symbol}) el ${datetime.slice(0, 10)}: no se importa sola. Añádela a mano (canje, escisión o amortización).`);
      addCount(ignored, 'Operaciones corporativas pendientes');
      continue;
    }

    if (category === 'CASH' && type === 'TAX_OPTIMIZATION') {
      warnings.push(`Ajuste fiscal de Trade Republic del ${datetime.slice(0, 10)} (${f(idx.tax) || f(idx.amount)} ${currency}): propio de Alemania, no se importa. Revísalo si te afecta.`);
      addCount(ignored, 'Ajustes fiscales');
      continue;
    }
    if (category === 'CASH' && CASH_IGNORED.test(type)) { addCount(ignored, 'Movimientos de efectivo y tarjeta'); continue; }
    if (category === 'DELIVERY') {
      warnings.push(`Entrega ${type} de ${name} el ${datetime.slice(0, 10)}: revisa si es un traspaso y añádelo a mano.`);
      addCount(ignored, 'Entregas pendientes');
      continue;
    }
    addCount(ignored, 'Tipos no reconocidos');
    warnings.push(`Tipo sin clasificar ${category}/${type} del ${datetime.slice(0, 10)} (${name || f(idx.description)}). Añádelo a mano si tiene efecto fiscal.`);
  }

  for (const x of ipoFees) {
    const buy = ops.filter((o) => o.kind === 'buy' && o.assetId === x.symbol && o.datetime >= x.datetime).sort((a, b) => (a.datetime < b.datetime ? -1 : 1))[0];
    if (buy) {
      buy.feeEur = cents(D(buy.feeEur).plus(x.fee));
      buy.totalEur = cents(D(buy.totalEur).plus(x.fee));
      continue;
    }
    // OPV sin adjudicación: la comisión queda como un gasto suelto.
    const op = baseOp({ broker: 'trade_republic', kind: 'fee', datetime: x.datetime, assetId: x.symbol, assetName: x.name, assetClass: 'other', sourceKey: x.key, note: 'Comisión de suscripción a OPV' });
    op.feeClass = 'non_deductible';
    op.grossLocal = cents(x.fee);
    op.grossEur = op.grossLocal;
    op.totalEur = op.grossLocal;
    ops.push(op);
  }

  for (const c of cancelled) {
    const i = ops.findIndex((o) => o.assetId === c.symbol && (o.kind === 'buy' || o.kind === 'sell') && o.quantity === c.shares &&
      (!c.amount || D(o.grossLocal).minus(D(c.amount)).abs().lte('0.02')));
    if (i >= 0) {
      warnings.push(`Orden anulada de ${c.symbol} (${c.shares} títulos): se han quitado la orden y su anulación.`);
      ops.splice(i, 1);
    } else {
      warnings.push(`Anulación de ${c.symbol} (${c.shares} títulos) sin orden en este fichero. Si la orden se importó antes, elimínala a mano.`);
    }
  }
  return { broker: 'trade_republic', format: 'Exportación de transacciones', ops, pendingCosts: [], balances: [], markets: {}, warnings, ignored, rows: rows.length };
}
