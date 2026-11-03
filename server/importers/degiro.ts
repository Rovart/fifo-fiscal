import { D, Decimal, ZERO, cents, toStr } from '../../shared/decimal.ts';
import type { Market, Operation } from '../../shared/types.ts';
import { KeyCounter, addCount, baseOp, classifyProduct, finishCash, finishIncome, finishTrade, marketOf, num, review } from './common.ts';
import type { ParsedImport, PendingCost, RateFn } from './common.ts';
import { findCol, findColStarts, norm } from './csv.ts';

const dmy = (d: string, t: string): string => {
  const m = d.trim().match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (!m) throw new Error(`Fecha no reconocida: ${d}`);
  const hm = (t || '00:00').trim();
  return `${m[3]}-${(m[2] as string).padStart(2, '0')}-${(m[1] as string).padStart(2, '0')}T${hm.length === 5 ? `${hm}:00` : hm}`;
};

/** DEGIRO parte los textos largos en otra fila sin fecha: se devuelven a la fila a la que pertenecen. */
function joinContinuations(rows: string[][], dateCol: number): string[][] {
  const out: string[][] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (!(r[dateCol] ?? '').trim() && prev) {
      r.forEach((cell, i) => {
        if (cell.trim()) prev[i] = `${prev[i] ?? ''} ${cell.trim()}`.trim();
      });
    } else {
      out.push([...r]);
    }
  }
  return out;
}

/** Producto de cambio de divisa: ISIN «EURUSD......» o nombre «EUR/USD». */
const isFxProduct = (isin: string, product: string): boolean => /^[A-Z]{6}\.+$/.test(isin) || /^[A-Z]{3}\/[A-Z]{3}$/.test(product.trim());

export const looksLikeDegiroTransactions = (h: string[]): boolean =>
  findCol(h, ['isin']) >= 0 && findColStarts(h, ['precio', 'price', 'koers', 'kurs']) >= 0 &&
  findCol(h, ['numero', 'cantidad', 'quantity', 'number', 'aantal', 'anzahl']) >= 0;

export const looksLikeDegiroAccount = (h: string[]): boolean =>
  findCol(h, ['isin']) >= 0 && findCol(h, ['descripcion', 'description', 'omschrijving', 'beschreibung']) >= 0;

interface TradeRow {
  idx: number; dt: string; product: string; isin: string; exchange: string; qty: Decimal; price: Decimal | null; priceCur: string;
  localValue: Decimal | null; eurValue: Decimal | null; rate: Decimal | null; costs: Decimal; autoFx: Decimal; total: Decimal | null;
  totalCur: string; orderId: string;
}

export function parseDegiroTransactions(headers: string[], rawRows: string[][], rate: RateFn): ParsedImport {
  const c = {
    date: findCol(headers, ['fecha', 'date', 'datum']),
    time: findCol(headers, ['hora', 'time', 'tijd', 'zeit', 'uhrzeit']),
    product: findCol(headers, ['producto', 'product', 'produkt']),
    isin: findCol(headers, ['isin']),
    exchange: findColStarts(headers, ['bolsa de', 'reference', 'centro de referencia', 'beurs', 'referenzbörse', 'bolsa']),
    qty: findCol(headers, ['numero', 'cantidad', 'quantity', 'number', 'aantal', 'anzahl']),
    price: findColStarts(headers, ['precio', 'price', 'koers', 'kurs']),
    local: findColStarts(headers, ['valor local', 'local value', 'lokale waarde', 'lokaler wert']),
    rate: findColStarts(headers, ['tipo de cambio', 'exchange rate', 'wisselkoers', 'wechselkurs']),
    autoFx: findColStarts(headers, ['autofx']),
    total: findCol(headers, ['total', 'total eur', 'totaal', 'totaal eur', 'gesamt', 'gesamt eur']),
    order: findColStarts(headers, ['id orden', 'order id', 'order-id', 'auftrags', 'id de orden']),
  };
  if (c.date < 0 || c.qty < 0 || c.price < 0 || c.isin < 0) {
    throw new Error('DEGIRO Transactions: faltan columnas (Fecha, ISIN, Número, Precio).');
  }
  const rows = joinContinuations(rawRows, c.date);
  // «Comisión AutoFX» va antes que los costes y no debe confundirse con ellos.
  const costCol = (names: string[]) => headers.findIndex((h, i) => i !== c.autoFx && names.some((w) => norm(h).includes(w)));
  const costs = [costCol(['costes de transaccion', 'transaction and', 'transaction cost', 'transaction fee', 'transactiekosten', 'transaktionskosten']), costCol(['comision', 'costes', 'kosten', 'fee'])].find((i) => i >= 0) ?? -1;
  const valueCol = findColStarts(headers, ['valor eur', 'value eur', 'waarde eur', 'wert eur']) >= 0
    ? findColStarts(headers, ['valor eur', 'value eur', 'waarde eur', 'wert eur'])
    : headers.findIndex((h, i) => i > (c.local >= 0 ? c.local : c.price) && ['valor', 'value', 'waarde', 'wert'].includes(norm(h)));
  const totalHasCurrency = c.total >= 0 && (norm(headers[c.total] as string).includes('eur') === false) && (headers[c.total + 1] ?? '') === '';
  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const markets: Record<string, Market> = {};
  const parsed: TradeRow[] = [];

  rows.forEach((r, idx) => {
    const qty = num(r[c.qty]);
    const isin = (r[c.isin] ?? '').trim();
    if (!isin || !qty || qty.isZero()) { addCount(ignored, 'Filas sin ISIN o sin cantidad'); return; }
    const totalCur = totalHasCurrency ? (r[c.total + 1] ?? '').trim() || 'EUR' : 'EUR';
    parsed.push({
      idx, dt: dmy(r[c.date] ?? '', c.time >= 0 ? r[c.time] ?? '' : ''), product: (r[c.product] ?? isin).trim(), isin,
      exchange: c.exchange >= 0 ? (r[c.exchange] ?? '').trim() : '', qty, price: num(r[c.price]), priceCur: (r[c.price + 1] ?? 'EUR').trim() || 'EUR',
      localValue: c.local >= 0 ? num(r[c.local]) : null, eurValue: valueCol >= 0 ? num(r[valueCol]) : null, rate: c.rate >= 0 ? num(r[c.rate]) : null,
      costs: costs >= 0 ? (num(r[costs]) ?? ZERO).abs() : ZERO, autoFx: c.autoFx >= 0 ? (num(r[c.autoFx]) ?? ZERO).abs() : ZERO,
      total: c.total >= 0 ? num(r[c.total]) : null, totalCur, orderId: c.order >= 0 ? (r[c.order] ?? '').trim() : '',
    });
  });

  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const used = new Set<number>();

  // Cambios de divisa: la orden es el cambio real; la fila contraria de la misma orden es solo su liquidación.
  const fxRows = parsed.filter((p) => isFxProduct(p.isin, p.product)).sort((a, b) => (a.dt < b.dt ? -1 : 1));
  const fxSeen = new Map<string, TradeRow>();
  for (const p of fxRows) {
    used.add(p.idx);
    const first = p.orderId ? fxSeen.get(p.orderId) : undefined;
    if (first && first.qty.plus(p.qty).isZero()) { addCount(ignored, 'Liquidaciones de cambios de divisa'); continue; }
    if (p.orderId) fxSeen.set(p.orderId, p);
    const pair = p.isin.length >= 6 && /^[A-Z]{6}/.test(p.isin) ? p.isin.slice(0, 6) : p.product.replace('/', '').trim();
    const base = pair.slice(0, 3), quote = pair.slice(3, 6);
    const baseAmount = p.qty.abs();
    const quoteAmount = (p.localValue ?? baseAmount.times(p.price ?? 1)).abs();
    const buysBase = p.qty.gt(0);
    const given = buysBase ? quote : base;
    const received = buysBase ? base : quote;
    const foreign = given === 'EUR' ? received : given;
    const op = baseOp({ broker: 'degiro', kind: 'fx', datetime: p.dt, assetId: foreign, assetName: foreign, assetClass: 'other', currency: given, sourceKey: keys.key('dg-fxt', p.dt, p.isin, p.qty, p.orderId) });
    op.quantity = toStr(buysBase ? quoteAmount : baseAmount);
    op.counterAsset = received;
    op.counterName = received;
    op.counterQuantity = toStr(buysBase ? baseAmount : quoteAmount);
    op.orderRef = p.orderId || null;
    const value = p.eurValue?.abs() ?? (base === 'EUR' ? baseAmount : null);
    if (!value) { review(op, 'Sin contravalor en euros.'); ops.push(op); continue; }
    op.grossEur = cents(value);
    op.feeEur = cents(p.costs.plus(p.autoFx));
    op.totalEur = cents(value.minus(p.costs).minus(p.autoFx));
    op.fxRate = toStr((foreign === quote ? quoteAmount : baseAmount).div(value), 10);
    op.fxSource = 'broker';
    ops.push(op);
  }

  // DEGIRO refleja splits y cambios de ISIN como venta y compra sin orden ni gastos el mismo día.
  const orphan = parsed.filter((p) => !p.orderId && p.costs.isZero() && p.autoFx.isZero());
  const absLocal = (p: TradeRow) => (p.localValue ?? (p.price ? p.qty.times(p.price) : ZERO)).abs();
  for (const neg of orphan.filter((p) => p.qty.lt(0))) {
    if (used.has(neg.idx)) continue;
    const day = neg.dt.slice(0, 10);
    const pos = orphan.find((p) => p.qty.gt(0) && !used.has(p.idx) && p.dt.slice(0, 10) === day &&
      (p.isin === neg.isin || (absLocal(neg).isZero() || absLocal(p).minus(absLocal(neg)).abs().div(absLocal(neg)).lte('0.015'))));
    if (!pos) continue;
    used.add(neg.idx); used.add(pos.idx);
    const klass = classifyProduct(neg.product).assetClass;
    if (pos.isin === neg.isin) {
      const op = baseOp({ broker: 'degiro', kind: 'split', datetime: neg.dt, assetId: neg.isin, assetName: neg.product, assetClass: klass, sourceKey: keys.key('dg-split', neg.dt, neg.isin, neg.qty, pos.qty) });
      op.quantity = toStr(pos.qty.plus(neg.qty));
      review(op, 'Parece un split. Comprueba que el número de acciones es correcto.');
      ops.push(op);
    } else {
      const op = baseOp({ broker: 'degiro', kind: 'isin_change', datetime: neg.dt, assetId: neg.isin, assetName: neg.product, assetClass: klass, sourceKey: keys.key('dg-isin', neg.dt, neg.isin, pos.isin, neg.qty, pos.qty) });
      op.quantity = toStr(neg.qty.abs());
      op.counterAsset = pos.isin;
      op.counterName = pos.product;
      op.counterQuantity = toStr(pos.qty);
      review(op, 'Parece un split o canje sin impuestos. Comprueba que fue así.');
      const cashDiff = absLocal(neg).minus(absLocal(pos));
      if (cashDiff.abs().gte('0.01')) op.note = `Fracciones pagadas en efectivo: ${toStr(cashDiff)} ${neg.priceCur}.`;
      ops.push(op);
    }
    markets[pos.isin] = marketOf(pos.exchange);
    markets[neg.isin] = marketOf(neg.exchange);
  }

  for (const p of parsed) {
    if (used.has(p.idx)) continue;
    const { assetClass, etc } = classifyProduct(p.product);
    const kind = p.qty.gt(0) ? 'buy' : 'sell';
    const op = baseOp({
      broker: 'degiro', kind, datetime: p.dt, assetId: p.isin, assetName: p.product, assetClass, currency: p.priceCur,
      sourceKey: keys.key('dg-tx', p.dt, p.isin, p.qty, p.price, p.orderId),
    });
    op.orderRef = p.orderId || null;
    const settleForeign = p.totalCur !== 'EUR';
    finishTrade(op, {
      qty: p.qty.abs(), price: p.price, grossLocal: p.localValue?.abs() ?? null, grossEur: p.eurValue?.abs() ?? null,
      fee: p.costs.plus(p.autoFx), total: settleForeign || !p.total ? null : kind === 'buy' ? p.total.neg() : p.total, reportedRate: p.rate, rate,
    });
    if (settleForeign) op.settleCurrency = p.totalCur;
    else if (p.priceCur !== 'EUR') {
      // El dinero pasa por la cuenta en esa moneda; el estado de cuenta dice cuándo se cambió a euros.
      op.settleCurrency = p.priceCur === 'GBX' ? 'GBP' : p.priceCur;
      op.feesInEur = true;
    }
    if (!p.orderId) review(op, 'No tiene número de orden: puede ser una operación de la empresa, no una compra o venta tuya.');
    if (etc) review(op, 'Parece un ETC: puede ir en otra casilla. Si lo es, cambia su clase en Ajustes.');
    markets[p.isin] = marketOf(p.exchange);
    ops.push(op);
  }
  return { broker: 'degiro', format: 'Transactions', ops, pendingCosts: [], balances: [], markets, warnings, ignored, rows: rows.length };
}

const RE = {
  fxSettle: /liquidacion transaccion de divisa|fx (transaction )?settlement/,
  splitAdj: /ajuste por split|split adjustment|stock split/,
  lending: /prestamo de valores|securities lending|effectenlening|wertpapierleihe/,
  withholding: /retencion del dividendo|impuesto sobre dividendo|dividend tax|withholding|dividendbelasting|dividendensteuer|quellensteuer/,
  capitalReturn: /retorno de capital|devolucion de capital|capital return|kapitalruckzahlung|kapitalrueckzahlung|prima de emision/,
  dividend: /dividendo|dividend|dividende/,
  fx: /cambio de divisa|fx (credit|debit)|fx (withdrawal|deposit)|valuta (debitering|creditering)|wahrung|cambio divisa/,
  autofx: /autofx/,
  txCost: /costes de transaccion|transaction and|transaction cost|transaction fee|transactiekosten|transaktionskosten/,
  txTax: /transacciones financieras|transaction tax|taxe sur les transactions|stamp duty|\bftt\b|\bitf\b/,
  connectivity: /conectividad|connection fee|connectivity|aansluitingskosten|verbindungskosten/,
  custody: /custodia|custody|bewaarloon/,
  adr: /adr\/gdr|pass-through/,
  interest: /interes|interest|\brente\b|zinsen/,
  trade: /^(compra|venta|buy|sell|koop|verkoop|kauf|verkauf)\s/,
  sweep: /cash sweep|sweep|money market|mercado monetario|cuenta de efectivo|flatex|transferir|overboeking|ubertrag|reserva|processed flatex/,
  deposit: /ingreso|deposito|deposit|storting|einzahlung|ideal|sofort/,
  withdrawal: /retirada|withdrawal|terugstorting|auszahlung/,
};

export function parseDegiroAccount(headers: string[], rawRows: string[][], rate: RateFn): ParsedImport {
  const date = findCol(headers, ['fecha', 'date', 'datum']);
  const time = findCol(headers, ['hora', 'time', 'tijd', 'zeit', 'uhrzeit']);
  const product = findCol(headers, ['producto', 'product', 'produkt']);
  const isin = findCol(headers, ['isin']);
  const desc = findCol(headers, ['descripcion', 'description', 'omschrijving', 'beschreibung']);
  const fxCol = findCol(headers, ['tipo', 'tipo de cambio', 'fx', 'wisselkoers', 'wechselkurs']);
  const orderCol = findColStarts(headers, ['id orden', 'order id', 'order-id', 'auftrags', 'id de orden']);
  const change = findCol(headers, ['variacion', 'change', 'mutatie', 'anderung', 'importe', 'amount']);
  if (date < 0 || desc < 0 || change < 0) throw new Error('DEGIRO Account: faltan columnas (Fecha, Descripción, Variación).');
  const curCol = change;
  const amtCol = change + 1;
  const rows = joinContinuations(rawRows, date);

  const warnings: string[] = [];
  const ignored: Record<string, number> = {};
  const keys = new KeyCounter();
  const ops: Operation[] = [];
  const pendingCosts: PendingCost[] = [];

  interface Row { dt: string; product: string; isin: string; desc: string; raw: string; fx: Decimal | null; cur: string; amt: Decimal; order: string }
  const parsed: Row[] = [];
  for (const r of rows) {
    const amt = num(r[amtCol]);
    if (!amt) { addCount(ignored, 'Filas sin importe'); continue; }
    const raw = (r[desc] ?? '').trim();
    parsed.push({
      dt: dmy(r[date] ?? '', time >= 0 ? r[time] ?? '' : ''), product: (product >= 0 ? r[product] ?? '' : '').trim(), isin: (isin >= 0 ? r[isin] ?? '' : '').trim(),
      desc: norm(raw), raw, fx: fxCol >= 0 ? num(r[fxCol]) : null, cur: (r[curCol] ?? 'EUR').trim() || 'EUR', amt, order: orderCol >= 0 ? (r[orderCol] ?? '').trim() : '',
    });
  }
  parsed.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0));

  const dividends = new Map<string, { dt: string; product: string; isin: string; cur: string; gross: Decimal; tax: Decimal }>();
  const fxGroups = new Map<string, Row[]>();
  let trackedFee = 0;

  for (const row of parsed) {
    const d = row.desc;
    if (RE.autofx.test(d) || RE.trade.test(d) || RE.fxSettle.test(d) || RE.splitAdj.test(d)) { addCount(ignored, 'Ya incluido en Transactions'); continue; }
    if (RE.lending.test(d)) {
      // Remuneración del préstamo de valores: cesión de capitales (DA 18.ª Ley 62/2003).
      const op = baseOp({ broker: 'degiro', kind: 'interest', datetime: row.dt, assetId: 'DEGIRO-LENDING', assetName: 'Préstamo de valores DEGIRO', assetClass: 'other', currency: row.cur, sourceKey: keys.key('dg-lend', row.dt, row.raw, row.amt), note: row.raw });
      finishIncome(op, { grossLocal: row.amt, withheldLocal: ZERO, rate });
      op.settleCurrency = row.cur;
      ops.push(op);
      continue;
    }
    if (RE.txCost.test(d)) {
      if (row.order) { addCount(ignored, 'Ya incluido en Transactions'); continue; }
      trackedFee++;
    }
    if (RE.txTax.test(d)) {
      pendingCosts.push({
        orderRef: row.order || null, assetId: row.isin, assetName: row.product, datetime: row.dt,
        amountEur: toStr(row.cur === 'EUR' ? row.amt.abs() : row.amt.abs().div(rate(row.cur, row.dt.slice(0, 10)) ?? 1), 4), label: row.raw,
        sourceKey: keys.key('dg-itf', row.dt, row.isin, row.amt, row.order),
      });
      continue;
    }
    if (RE.withholding.test(d) || (RE.dividend.test(d) && !RE.capitalReturn.test(d))) {
      const k = `${row.dt.slice(0, 10)}|${row.isin}|${row.cur}`;
      const g = dividends.get(k) ?? { dt: row.dt, product: row.product, isin: row.isin, cur: row.cur, gross: ZERO, tax: ZERO };
      if (RE.withholding.test(d)) g.tax = g.tax.minus(row.amt);
      else g.gross = g.gross.plus(row.amt);
      dividends.set(k, g);
      continue;
    }
    if (RE.capitalReturn.test(d)) {
      const { assetClass } = classifyProduct(row.product);
      const op = baseOp({ broker: 'degiro', kind: 'return_capital', datetime: row.dt, assetId: row.isin, assetName: row.product, assetClass, currency: row.cur, sourceKey: keys.key('dg-rc', row.dt, row.isin, row.amt) });
      finishIncome(op, { grossLocal: row.amt, withheldLocal: ZERO, rate });
      op.settleCurrency = row.cur;
      review(op, 'Devolución de capital: baja el coste de tus acciones. Si venía de beneficios, sería un dividendo.');
      ops.push(op);
      continue;
    }
    if (RE.fx.test(d)) {
      // La orden EUR/USD ya llega desde Transactions. El resto de cambios, de orden o automáticos, mueven de verdad la moneda.
      if (row.order && isFxProduct(row.isin, row.product)) { addCount(ignored, 'Ya incluido en Transactions'); continue; }
      const k = row.order ? `${row.dt}|${row.order}` : row.dt;
      fxGroups.set(k, [...(fxGroups.get(k) ?? []), row]);
      continue;
    }
    if (RE.connectivity.test(d) || RE.custody.test(d) || RE.adr.test(d) || (RE.txCost.test(d) && !row.order)) {
      const isCustody = RE.custody.test(d);
      const fxProduct = isFxProduct(row.isin, row.product);
      const op = baseOp({ broker: 'degiro', kind: 'fee', datetime: row.dt, assetId: fxProduct ? 'DEGIRO' : row.isin || 'DEGIRO', assetName: fxProduct ? 'DEGIRO' : row.product || 'DEGIRO', assetClass: 'other', currency: row.cur, sourceKey: keys.key('dg-fee', row.dt, row.isin, row.raw, row.amt), note: row.raw });
      op.feeClass = isCustody ? 'custody' : 'non_deductible';
      finishCash(op, row.amt.neg(), rate);
      ops.push(op);
      continue;
    }
    if (RE.interest.test(d)) {
      if (row.amt.lt(0)) {
        // Interés por saldo deudor: no es deducible del capital mobiliario (art. 26 LIRPF).
        const debit = baseOp({ broker: 'degiro', kind: 'fee', datetime: row.dt, assetId: 'DEGIRO', assetName: 'DEGIRO', assetClass: 'other', currency: row.cur, sourceKey: keys.key('dg-int', row.dt, row.raw, row.amt), note: 'Interés por saldo negativo' });
        debit.feeClass = 'non_deductible';
        finishCash(debit, row.amt.abs(), rate);
        ops.push(debit);
        continue;
      }
      const op = baseOp({ broker: 'degiro', kind: 'interest', datetime: row.dt, assetId: 'DEGIRO-CASH', assetName: 'Intereses DEGIRO', assetClass: 'other', currency: row.cur, sourceKey: keys.key('dg-int', row.dt, row.raw, row.amt) });
      finishIncome(op, { grossLocal: row.amt, withheldLocal: ZERO, rate });
      op.settleCurrency = row.cur;
      ops.push(op);
      continue;
    }
    if (RE.sweep.test(d)) { addCount(ignored, 'Movimientos internos de efectivo'); continue; }
    if (RE.withdrawal.test(d) || RE.deposit.test(d)) {
      if (row.cur === 'EUR') { addCount(ignored, 'Ingresos y retiradas en euros'); continue; }
      const op = baseOp({ broker: 'degiro', kind: row.amt.gt(0) ? 'deposit' : 'withdrawal', datetime: row.dt, assetId: row.cur, assetName: row.cur, assetClass: 'other', currency: row.cur, sourceKey: keys.key('dg-cash', row.dt, row.raw, row.amt) });
      finishCash(op, row.amt.abs(), rate);
      ops.push(op);
      continue;
    }
    addCount(ignored, 'Conceptos no reconocidos');
    warnings.push(`Concepto sin clasificar del ${row.dt.slice(0, 10)}: «${row.raw}» (${toStr(row.amt)} ${row.cur}). Añádelo a mano si tiene efecto fiscal.`);
  }
  void trackedFee;

  for (const g of dividends.values()) {
    const { assetClass } = classifyProduct(g.product);
    const op = baseOp({
      broker: 'degiro', kind: 'dividend', datetime: g.dt, assetId: g.isin, assetName: g.product, assetClass, currency: g.cur,
      sourceKey: keys.key('dg-div', g.dt.slice(0, 10), g.isin, g.cur),
    });
    finishIncome(op, { grossLocal: g.gross, withheldLocal: g.tax, rate });
    op.settleCurrency = g.cur;
    if (g.gross.lte(0)) review(op, 'Retención o corrección sin dividendo ese día.');
    ops.push(op);
  }

  for (const [groupKey, group] of fxGroups) {
    const dt = (group[0] as Row).dt;
    const sums = new Map<string, Decimal>();
    for (const g of group) sums.set(g.cur, (sums.get(g.cur) ?? ZERO).plus(g.amt));
    const entries = [...sums.entries()].filter(([, v]) => !v.isZero());
    const left = entries.filter(([, v]) => v.lt(0));
    const right = entries.filter(([, v]) => v.gt(0));
    const rateOf = (cur: string) => group.find((g) => g.cur === cur && g.fx?.gt(0))?.fx ?? rate(cur, dt.slice(0, 10));
    const pairs: { from: string; fromAmt: Decimal; to: string; toAmt: Decimal; value: Decimal | null }[] = [];
    if (left.length === 1 && right.length === 1) {
      const [from, fromV] = left[0] as [string, Decimal];
      const [to, toV] = right[0] as [string, Decimal];
      const value = from === 'EUR' ? fromV.abs() : to === 'EUR' ? toV : (() => { const r = rateOf(from); return r ? fromV.abs().div(r) : null; })();
      pairs.push({ from, fromAmt: fromV.abs(), to, toAmt: toV, value });
    } else if (entries.length > 2 && sums.has('EUR')) {
      // Varias monedas cambiadas en el mismo instante: cada una con su tipo.
      for (const [cur, v] of entries) {
        if (cur === 'EUR') continue;
        const r = rateOf(cur);
        const eur = r ? v.abs().div(r).toDecimalPlaces(2) : null;
        if (v.lt(0)) pairs.push({ from: cur, fromAmt: v.abs(), to: 'EUR', toAmt: eur ?? ZERO, value: eur });
        else pairs.push({ from: 'EUR', fromAmt: eur ?? ZERO, to: cur, toAmt: v, value: eur });
      }
    } else {
      warnings.push(`Cambio de moneda del ${dt.slice(0, 10)} sin pareja clara (${group.length} filas). Añádelo a mano si procede.`);
      continue;
    }
    for (const x of pairs) {
      const foreignCur = x.from === 'EUR' ? x.to : x.from;
      const op = baseOp({ broker: 'degiro', kind: 'fx', datetime: dt, assetId: foreignCur, assetName: foreignCur, assetClass: 'other', currency: x.from, sourceKey: keys.key('dg-fx', groupKey, x.from, x.fromAmt, x.to, x.toAmt) });
      op.quantity = toStr(x.fromAmt);
      op.counterAsset = x.to;
      op.counterName = x.to;
      op.counterQuantity = toStr(x.toAmt);
      op.orderRef = (group[0] as Row).order || null;
      if (!x.value) { review(op, 'Sin contravalor en euros.'); ops.push(op); continue; }
      op.grossEur = cents(x.value);
      op.totalEur = op.grossEur;
      op.fxRate = toStr((x.from === 'EUR' ? x.toAmt : x.fromAmt).div(x.value), 10);
      op.fxSource = group.some((g) => g.fx?.gt(0)) ? 'broker' : 'ecb';
      ops.push(op);
    }
  }
  return { broker: 'degiro', format: 'Account', ops, pendingCosts, balances: [], markets: {}, warnings, ignored, rows: rows.length };
}

export { D };
