import { D, Decimal, cents, isNum, toStr } from './decimal.ts';
import type { EditableField, OpKind, Operation, ReconcileCheck, ReconcileResult } from './types.ts';

type Fix = NonNullable<ReconcileCheck['fix']>[number];

const EQ_TRADE: OpKind[] = ['buy', 'sell'];
const EQ_INCOME: OpKind[] = ['dividend', 'interest', 'return_capital'];
const EQ_VALUED: OpKind[] = ['staking', 'reward'];
const EQ_CASH: OpKind[] = ['fee', 'deposit', 'withdrawal'];
const EQ_QTY: OpKind[] = ['transfer_in', 'transfer_out', 'split', 'isin_change'];

export const taxableFields = (kind: OpKind): EditableField[] => {
  if (EQ_TRADE.includes(kind)) return ['quantity', 'unitPrice', 'grossLocal', 'fxRate', 'grossEur', 'feeEur', 'otherCostsEur', 'totalEur'];
  if (EQ_INCOME.includes(kind)) return ['grossLocal', 'fxRate', 'grossEur', 'withholdingEur', 'feeEur', 'totalEur'];
  if (EQ_VALUED.includes(kind)) return ['quantity', 'unitPrice', 'grossEur', 'totalEur'];
  if (EQ_CASH.includes(kind)) return ['grossLocal', 'fxRate', 'grossEur', 'totalEur'];
  if (kind === 'swap') return ['quantity', 'counterQuantity', 'unitPrice', 'grossEur', 'feeEur', 'totalEur'];
  if (kind === 'fx') return ['quantity', 'counterQuantity', 'fxRate', 'grossEur', 'feeEur', 'totalEur'];
  if (kind === 'isin_change') return ['quantity', 'counterQuantity'];
  return ['quantity'];
};

const fees = (op: Operation): Decimal => D(op.feeEur).plus(D(op.otherCostsEur));

export const expectedTotal = (op: Operation): Decimal => {
  const g = D(op.grossEur);
  if (op.kind === 'buy') return g.plus(fees(op));
  if (op.kind === 'sell' || op.kind === 'swap' || op.kind === 'fx') return g.minus(fees(op));
  if (EQ_INCOME.includes(op.kind)) return g.minus(D(op.withholdingEur)).minus(D(op.feeEur));
  return g;
};

const num = (s: Decimal): string => toStr(s, 8);

export function reconcile(op: Operation, toleranceEur: Decimal.Value = '0.02'): ReconcileResult {
  const tol = D(toleranceEur);
  const checks: ReconcileCheck[] = [];
  const missing: string[] = [];
  const missingFields: string[] = [];
  const need = (field: keyof Operation, label: string) => {
    if (!isNum(op[field])) { missing.push(label); missingFields.push(field); }
  };
  const add = (label: string, expected: Decimal, actual: Decimal, fix: Fix[] = []) => {
    const diff = actual.minus(expected);
    checks.push({
      label, expected: num(expected), actual: num(actual), diff: num(diff),
      ok: diff.abs().lte(tol), field: fix[0]?.field, fix: fix.length ? fix : undefined,
    });
  };
  const kind = op.kind;

  if (EQ_TRADE.includes(kind)) {
    need('quantity', 'Cantidad'); need('unitPrice', 'Precio'); need('grossLocal', 'Importe en divisa');
    need('grossEur', 'Importe en EUR'); need('totalEur', 'Total');
    if (op.currency !== 'EUR') need('fxRate', 'Tipo de cambio');
    if (missing.length === 0) {
      const q = D(op.quantity), gL = D(op.grossLocal), gE = D(op.grossEur);
      add('Cantidad × Precio = Importe', q.times(D(op.unitPrice)), gL, [
        { field: 'grossLocal', value: cents(q.times(D(op.unitPrice))), label: 'Ajustar importe' },
        ...(q.isZero() ? [] : [{ field: 'unitPrice' as const, value: toStr(gL.div(q), 8), label: 'Ajustar precio' }]),
      ]);
      if (op.currency === 'EUR') {
        add('Importe en EUR = Importe', gL, gE, [{ field: 'grossEur', value: cents(gL), label: 'Ajustar importe EUR' }]);
      } else {
        const r = D(op.fxRate);
        if (r.lte(0)) missing.push('Tipo de cambio positivo');
        else add('Importe ÷ Tipo de cambio = Importe EUR', gL.div(r), gE, [
          { field: 'grossEur', value: cents(gL.div(r)), label: 'Ajustar importe EUR' },
          ...(gE.isZero() ? [] : [{ field: 'fxRate' as const, value: toStr(gL.div(gE), 8), label: 'Ajustar tipo' }]),
        ]);
      }
      const sign = kind === 'buy' ? '+' : '−';
      const t = expectedTotal(op);
      const actual = D(op.totalEur);
      const adj = kind === 'buy' ? actual.minus(gE).minus(D(op.otherCostsEur)) : gE.minus(actual).minus(D(op.otherCostsEur));
      add(`Importe EUR ${sign} Comisión ${sign} Otros = Total`, t, actual, [
        { field: 'totalEur', value: cents(t), label: 'Ajustar total' },
        ...(adj.gte(0) ? [{ field: 'feeEur' as const, value: cents(adj), label: 'Ajustar comisión' }] : []),
      ]);
    }
  } else if (EQ_INCOME.includes(kind)) {
    need('grossLocal', 'Importe bruto'); need('grossEur', 'Bruto en EUR'); need('totalEur', 'Neto');
    if (op.currency !== 'EUR') need('fxRate', 'Tipo de cambio');
    if (missing.length === 0) {
      const gL = D(op.grossLocal), gE = D(op.grossEur);
      if (op.currency === 'EUR') {
        add('Bruto en EUR = Bruto', gL, gE, [{ field: 'grossEur', value: cents(gL), label: 'Ajustar bruto EUR' }]);
      } else {
        const r = D(op.fxRate);
        if (r.lte(0)) missing.push('Tipo de cambio positivo');
        else add('Bruto ÷ Tipo de cambio = Bruto EUR', gL.div(r), gE, [
          { field: 'grossEur', value: cents(gL.div(r)), label: 'Ajustar bruto EUR' },
          ...(gE.isZero() ? [] : [{ field: 'fxRate' as const, value: toStr(gL.div(gE), 8), label: 'Ajustar tipo' }]),
        ]);
      }
      const t = expectedTotal(op);
      const actual = D(op.totalEur);
      add('Bruto EUR − Retención − Comisión = Neto', t, actual, [
        { field: 'totalEur', value: cents(t), label: 'Ajustar neto' },
        ...(gE.minus(actual).minus(D(op.feeEur)).gte(0)
          ? [{ field: 'withholdingEur' as const, value: cents(gE.minus(actual).minus(D(op.feeEur))), label: 'Ajustar retención' }] : []),
      ]);
    }
  } else if (EQ_VALUED.includes(kind)) {
    need('quantity', 'Cantidad'); need('unitPrice', 'Precio EUR'); need('grossEur', 'Valor EUR'); need('totalEur', 'Total');
    if (missing.length === 0) {
      const v = D(op.quantity).times(D(op.unitPrice));
      add('Cantidad × Precio = Valor EUR', v, D(op.grossEur), [{ field: 'grossEur', value: cents(v), label: 'Ajustar valor' }]);
      add('Valor EUR = Total', D(op.grossEur), D(op.totalEur), [{ field: 'totalEur', value: cents(D(op.grossEur)), label: 'Ajustar total' }]);
    }
  } else if (kind === 'fee' && op.assetClass === 'crypto' && !isNum(op.grossLocal) && !isNum(op.grossEur) && !isNum(op.totalEur)) {
    // Las unidades de una comisión de red bastan para cuadrar el saldo; no exige valor fiscal.
    need('quantity', 'Cantidad');
  } else if (EQ_CASH.includes(kind)) {
    if (kind === 'fee' && op.assetClass === 'crypto') need('quantity', 'Cantidad');
    need('grossLocal', 'Importe'); need('grossEur', 'Importe en EUR'); need('totalEur', 'Total');
    if (op.currency !== 'EUR') need('fxRate', 'Tipo de cambio');
    if (missing.length === 0) {
      const gL = D(op.grossLocal), gE = D(op.grossEur);
      const expected = op.currency === 'EUR' ? gL : D(op.fxRate).lte(0) ? gE : gL.div(D(op.fxRate));
      add('Importe convertido = Importe EUR', expected, gE, [{ field: 'grossEur', value: cents(expected), label: 'Ajustar importe EUR' }]);
      add('Importe EUR = Total', gE, D(op.totalEur), [{ field: 'totalEur', value: cents(gE), label: 'Ajustar total' }]);
    }
  } else if (kind === 'swap') {
    need('quantity', 'Cantidad entregada'); need('counterQuantity', 'Cantidad recibida');
    need('unitPrice', 'Precio EUR de lo entregado'); need('grossEur', 'Valor de mercado EUR'); need('totalEur', 'Valor de transmisión');
    if (missing.length === 0) {
      const v = D(op.quantity).times(D(op.unitPrice));
      add('Cantidad × Precio = Valor de mercado', v, D(op.grossEur), [
        { field: 'grossEur', value: cents(v), label: 'Ajustar valor' },
        ...(D(op.quantity).isZero() ? [] : [{ field: 'unitPrice' as const, value: toStr(D(op.grossEur).div(D(op.quantity)), 8), label: 'Ajustar precio' }]),
      ]);
      const t = expectedTotal(op);
      add('Valor − Comisión = Valor de transmisión', t, D(op.totalEur), [{ field: 'totalEur', value: cents(t), label: 'Ajustar total' }]);
    }
  } else if (kind === 'fx') {
    need('quantity', 'Importe entregado'); need('counterQuantity', 'Importe recibido'); need('grossEur', 'Contravalor EUR'); need('totalEur', 'Total');
    if (missing.length === 0) {
      const given = D(op.quantity), recv = D(op.counterQuantity), gE = D(op.grossEur);
      const expected = op.currency === 'EUR' ? given : op.counterAsset === 'EUR' ? recv : D(op.fxRate).gt(0) ? given.div(D(op.fxRate)) : gE;
      add('Contravalor en EUR', expected, gE, [{ field: 'grossEur', value: cents(expected), label: 'Ajustar contravalor' }]);
      const t = expectedTotal(op);
      add('Contravalor − Comisión = Total', t, D(op.totalEur), [{ field: 'totalEur', value: cents(t), label: 'Ajustar total' }]);
    }
  } else if (EQ_QTY.includes(kind)) {
    need('quantity', 'Cantidad');
    if (kind === 'isin_change') need('counterQuantity', 'Cantidad nueva');
  }

  return { ok: missing.length === 0 && checks.every((c) => c.ok), checks, missing, missingFields };
}

/**
 * Propaga una edición para que la operación siga cuadrando.
 * `onTotal` decide qué absorbe un cambio del total.
 */
export function applyEdit(op: Operation, field: EditableField, value: string, onTotal: 'gross' | 'fee' | 'auto' = 'gross'): Operation {
  if (onTotal === 'auto') {
    // Un total algo distinto suele ser la comisión; si no puede serlo, cambia el importe.
    const fee = op.kind === 'buy'
      ? D(value).minus(D(op.grossEur)).minus(D(op.otherCostsEur))
      : D(op.grossEur).minus(D(value)).minus(D(op.otherCostsEur));
    onTotal = fee.gte(0) && isNum(op.grossEur) ? 'fee' : 'gross';
  }
  const next: Operation = { ...op, [field]: value };
  const kind = op.kind;
  const v = (k: keyof Operation) => D(next[k] as string);
  const has = (k: keyof Operation) => isNum(next[k]);
  const eur = next.currency === 'EUR';

  const fromGrossLocal = () => {
    if (eur) next.grossEur = cents(v('grossLocal'));
    else if (has('fxRate') && v('fxRate').gt(0)) next.grossEur = cents(v('grossLocal').div(v('fxRate')));
  };
  const toTotal = () => { if (has('grossEur')) next.totalEur = cents(expectedTotal(next)); };

  if (EQ_TRADE.includes(kind)) {
    if (field === 'quantity' || field === 'unitPrice') {
      if (has('quantity') && has('unitPrice')) { next.grossLocal = cents(v('quantity').times(v('unitPrice'))); fromGrossLocal(); toTotal(); }
    } else if (field === 'grossLocal') {
      if (has('quantity') && !v('quantity').isZero()) next.unitPrice = toStr(v('grossLocal').div(v('quantity')), 8);
      fromGrossLocal(); toTotal();
    } else if (field === 'fxRate') {
      fromGrossLocal(); toTotal(); next.fxSource = 'manual';
    } else if (field === 'grossEur') {
      if (eur) {
        next.grossLocal = value;
        if (has('quantity') && !v('quantity').isZero()) next.unitPrice = toStr(v('grossEur').div(v('quantity')), 8);
      } else if (has('grossLocal') && !v('grossEur').isZero()) {
        next.fxRate = toStr(v('grossLocal').div(v('grossEur')), 8);
        next.fxSource = 'manual';
      }
      toTotal();
    } else if (field === 'feeEur' || field === 'otherCostsEur') {
      toTotal();
    } else if (field === 'totalEur') {
      if (onTotal === 'fee' && has('grossEur')) {
        const f = kind === 'buy'
          ? v('totalEur').minus(v('grossEur')).minus(v('otherCostsEur'))
          : v('grossEur').minus(v('totalEur')).minus(v('otherCostsEur'));
        next.feeEur = cents(f);
      } else {
        const g = kind === 'buy' ? v('totalEur').minus(fees(next)) : v('totalEur').plus(fees(next));
        return applyEdit({ ...next, grossEur: cents(g) }, 'grossEur', cents(g));
      }
    }
  } else if (EQ_INCOME.includes(kind)) {
    if (field === 'grossLocal' || field === 'fxRate') {
      fromGrossLocal(); toTotal();
      if (field === 'fxRate') next.fxSource = 'manual';
    } else if (field === 'grossEur') {
      if (eur) next.grossLocal = value;
      else if (has('grossLocal') && !v('grossEur').isZero()) { next.fxRate = toStr(v('grossLocal').div(v('grossEur')), 8); next.fxSource = 'manual'; }
      toTotal();
    } else if (field === 'withholdingEur' || field === 'feeEur') {
      toTotal();
    } else if (field === 'totalEur' && has('grossEur')) {
      next.withholdingEur = cents(v('grossEur').minus(v('totalEur')).minus(v('feeEur')));
    }
  } else if (EQ_VALUED.includes(kind)) {
    if ((field === 'quantity' || field === 'unitPrice') && has('quantity') && has('unitPrice')) {
      next.grossEur = cents(v('quantity').times(v('unitPrice')));
      next.totalEur = next.grossEur;
    } else if (field === 'grossEur' || field === 'totalEur') {
      next.grossEur = value; next.totalEur = value;
      if (has('quantity') && !v('quantity').isZero()) next.unitPrice = toStr(D(value).div(v('quantity')), 8);
    }
  } else if (EQ_CASH.includes(kind)) {
    if (field === 'grossLocal' || field === 'fxRate') {
      fromGrossLocal(); next.totalEur = next.grossEur;
    } else if (field === 'grossEur' || field === 'totalEur') {
      next.grossEur = value; next.totalEur = value;
      if (eur) next.grossLocal = value;
      else if (has('grossLocal') && !D(value).isZero()) next.fxRate = toStr(v('grossLocal').div(D(value)), 8);
    }
  } else if (kind === 'swap') {
    if (field === 'quantity' || field === 'unitPrice') {
      if (has('quantity') && has('unitPrice')) { next.grossEur = cents(v('quantity').times(v('unitPrice'))); toTotal(); }
    } else if (field === 'grossEur') {
      if (has('quantity') && !v('quantity').isZero()) next.unitPrice = toStr(v('grossEur').div(v('quantity')), 8);
      toTotal();
    } else if (field === 'feeEur') {
      toTotal();
    } else if (field === 'totalEur') {
      const g = v('totalEur').plus(v('feeEur'));
      next.grossEur = cents(g);
      if (has('quantity') && !v('quantity').isZero()) next.unitPrice = toStr(g.div(v('quantity')), 8);
    }
  } else if (kind === 'fx') {
    if (field === 'quantity' && next.currency === 'EUR') next.grossEur = cents(v('quantity'));
    if (field === 'counterQuantity' && next.counterAsset === 'EUR') next.grossEur = cents(v('counterQuantity'));
    if (field === 'quantity' || field === 'counterQuantity') {
      const foreign = next.currency === 'EUR' ? v('counterQuantity') : v('quantity');
      if (has('grossEur') && !v('grossEur').isZero()) next.fxRate = toStr(foreign.div(v('grossEur')), 8);
    }
    if (field === 'fxRate' && next.currency !== 'EUR' && next.counterAsset !== 'EUR' && v('fxRate').gt(0)) {
      next.grossEur = cents(v('quantity').div(v('fxRate')));
    }
    if (field === 'grossEur' || field === 'feeEur' || field === 'quantity' || field === 'counterQuantity' || field === 'fxRate') toTotal();
    if (field === 'totalEur') next.feeEur = cents(v('grossEur').minus(v('totalEur')));
  }
  return next;
}
