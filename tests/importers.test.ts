import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { D } from '../shared/decimal.ts';
import { reconcile } from '../shared/reconcile.ts';
import { parseFile } from '../server/importers/index.ts';
import type { RateFn } from '../server/importers/index.ts';
import { krakenAsset } from '../server/importers/kraken.ts';
import { utcToMadrid } from '../server/engine/dates.ts';
import { run } from './helpers.ts';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
const rate: RateFn = (c) => (c === 'USD' ? D('1.08') : c === 'GBP' ? D('0.85') : null);

const assertBalanced = (ops: ReturnType<typeof parseFile>['ops']) => {
  for (const op of ops) {
    if (!op.grossEur && op.reviewReasons?.length) continue;
    const r = reconcile(op);
    expect(r.ok, `${op.kind} ${op.assetName}: ${JSON.stringify(r)}`).toBe(true);
  }
};

describe('DEGIRO', () => {
  it('Transactions en español con moneda en columnas sin nombre', () => {
    const p = parseFile(fx('degiro_transactions_es.csv'), rate);
    expect(p.format).toBe('Transactions');
    const sell = p.ops.find((o) => o.kind === 'sell')!;
    expect(sell).toMatchObject({ assetId: 'US0378331005', currency: 'USD', quantity: '5', unitPrice: '220.5', grossLocal: '1102.50', grossEur: '1013.25', feeEur: '1.00', totalEur: '1012.25', settleCurrency: 'USD', feesInEur: true });
    const buy = p.ops.find((o) => o.kind === 'buy' && o.assetId === 'US0378331005')!;
    expect(buy.totalEur).toBe('1700.85');
    expect(p.ops.find((o) => o.assetId === 'IE00B4L5Y983')!.assetClass).toBe('etf');
    expect(p.markets['US0378331005']).toBe('us');
    expect(p.markets['IE00B4L5Y983']).toBe('eu');
    assertBalanced(p.ops);
  });

  it('detecta un split reflejado como venta y compra sin orden', () => {
    const p = parseFile(fx('degiro_transactions_es.csv'), rate);
    const s = p.ops.find((o) => o.kind === 'split')!;
    expect(s.assetId).toBe('US67066G1040');
    expect(s.quantity).toBe('18');
    expect(s.reviewReasons?.length).toBe(1);
    expect(p.ops.filter((o) => o.assetId === 'US67066G1040')).toHaveLength(1);
  });

  it('formato nuevo con AutoFX y Total EUR', () => {
    const p = parseFile(fx('degiro_transactions_en_new.csv'), rate);
    const op = p.ops[0]!;
    expect(op).toMatchObject({ kind: 'buy', currency: 'USD', grossEur: '1100.00', feeEur: '4.75', totalEur: '1104.75' });
    assertBalanced(p.ops);
    expect(p.markets['US5949181045']).toBe('us');
  });

  it('Account: dividendo con retención, divisa, comisión, interés y aviso de lo desconocido', () => {
    const p = parseFile(fx('degiro_account_es.csv'), rate);
    expect(p.format).toBe('Account');
    const div = p.ops.find((o) => o.kind === 'dividend')!;
    expect(div).toMatchObject({ currency: 'USD', grossLocal: '10.8', grossEur: '10.00', withholdingEur: '1.50', totalEur: '8.50', settleCurrency: 'USD', fxSource: 'ecb' });
    const conv = p.ops.find((o) => o.kind === 'fx')!;
    expect(conv).toMatchObject({ currency: 'USD', quantity: '9.18', counterAsset: 'EUR', counterQuantity: '8.2', grossEur: '8.20' });
    const fee = p.ops.find((o) => o.kind === 'fee')!;
    expect(fee).toMatchObject({ grossEur: '2.50', feeClass: 'non_deductible' });
    expect(p.ops.find((o) => o.kind === 'interest')!.grossEur).toBe('0.35');
    expect(p.pendingCosts).toHaveLength(1);
    expect(p.pendingCosts[0]!.orderRef).toBe('eeee-5555');
    expect(p.warnings.some((w) => w.includes('XYZ'))).toBe(true);
    expect(p.ignored['Ya incluido en Transactions']).toBe(1);
    expect(p.ignored['Movimientos internos de efectivo']).toBe(1);
    assertBalanced(p.ops);
    const r = run(p.ops);
    expect(D(r.disposals.find((d) => d.class === 'fx')!.gainEur).toDecimalPlaces(2).toNumber()).toBe(-0.3);
  });
});

describe('DEGIRO con el formato real de una exportación', () => {
  const t = parseFile(fx('degiro_formato_transactions.csv'), rate);
  const a = parseFile(fx('degiro_formato_account.csv'), rate);

  it('lee los costes aunque «Comisión AutoFX» vaya antes, sin duplicar', () => {
    const eur = t.ops.find((o) => o.assetId === 'ES0000000001')!;
    expect(eur).toMatchObject({ kind: 'sell', grossEur: '2200.00', feeEur: '2.00', totalEur: '2198.00' });
    expect(eur.reviewReasons).toEqual([]);
    const usd = t.ops.find((o) => o.assetId === 'US0000000001')!;
    expect(usd).toMatchObject({ kind: 'buy', grossEur: '500.00', feeEur: '3.50', totalEur: '503.50' });
    expect(usd.reviewReasons).toEqual([]);
    assertBalanced(t.ops);
  });

  it('une al producto el texto partido en otra fila', () => {
    const etf = t.ops.find((o) => o.assetId === 'IE0000000009')!;
    expect(etf.assetName).toBe('XTRACKERS MSCI WORLD UCITS EUR ACCUMULATION ETF');
    expect(etf.assetClass).toBe('etf');
    expect(t.ignored['Filas sin ISIN o sin cantidad']).toBeUndefined();
    expect(a.warnings).toEqual([]);
  });

  it('una orden EUR/USD es un cambio de moneda y su fila contraria, solo la liquidación', () => {
    expect(t.ops.some((o) => o.assetId.startsWith('EURUSD'))).toBe(false);
    const fxOps = t.ops.filter((o) => o.kind === 'fx');
    expect(fxOps).toHaveLength(1);
    expect(fxOps[0]).toMatchObject({ currency: 'USD', quantity: '1650', counterAsset: 'EUR', counterQuantity: '1500', grossEur: '1500.00', feeEur: '12.50', totalEur: '1487.50', assetId: 'USD' });
    expect(t.ignored['Liquidaciones de cambios de divisa']).toBe(1);
    assertBalanced(fxOps);
  });

  it('el split con cambio de ISIN es un canje y anota las fracciones en efectivo', () => {
    const c = t.ops.find((o) => o.kind === 'isin_change')!;
    expect(c).toMatchObject({ assetId: 'US0000000002', quantity: '2000', counterAsset: 'US0000000003', counterQuantity: '100' });
    expect(c.note).toContain('0.4 USD');
  });

  it('el estado de cuenta no avisa de la liquidación ni del ajuste por split', () => {
    expect(a.warnings).toEqual([]);
    // Dos compras, liquidación, dos ajustes por split, dos comisiones y dos cambios de la orden EUR/USD.
    expect(a.ignored['Ya incluido en Transactions']).toBe(9);
  });

  it('el préstamo de valores es renta y el interés negativo no la resta', () => {
    const lend = a.ops.find((o) => o.assetId === 'DEGIRO-LENDING')!;
    expect(lend).toMatchObject({ kind: 'interest', grossEur: '1.25', totalEur: '1.25' });
    const debit = a.ops.find((o) => o.note === 'Interés por saldo negativo')!;
    expect(debit).toMatchObject({ kind: 'fee', feeClass: 'non_deductible', currency: 'USD' });
    expect(a.ops.filter((o) => o.kind === 'interest')).toHaveLength(1);
  });

  it('importa los cambios de cada orden y los automáticos, sin la orden EUR/USD', () => {
    const fxOps = a.ops.filter((o) => o.kind === 'fx');
    assertBalanced(fxOps);
    const ofOrder = fxOps.find((o) => o.orderRef === 'aaaa-2')!;
    expect(ofOrder).toMatchObject({ currency: 'EUR', quantity: '501.5', counterAsset: 'USD', counterQuantity: '600', grossEur: '501.50' });
    expect(fxOps.find((o) => o.quantity === '3000')).toMatchObject({ counterQuantity: '3300' });
    expect(fxOps.find((o) => o.currency === 'USD')).toMatchObject({ quantity: '0.4', counterQuantity: '0.34' });
    expect(fxOps.some((o) => o.quantity === '1650' || o.counterQuantity === '1500')).toBe(false);
  });

  it('una comisión del producto de divisa no crea un activo nuevo', () => {
    const fee = a.ops.find((o) => o.kind === 'fee' && o.grossEur === '10.00')!;
    expect(fee.assetId).toBe('DEGIRO');
  });

  it('la comisión AutoFX no se cuenta dos veces: ni resultado por divisa ni saldo en la moneda', () => {
    const r = run([...t.ops, ...a.ops].filter((o) => o.assetId === 'US0000000001' || o.orderRef === 'aaaa-2'));
    const fx = r.disposals.filter((d) => d.class === 'fx');
    expect(fx).toHaveLength(1);
    // El cambio costó 501,50 €, pero 1,50 € de AutoFX ya están en el coste de la compra (503,50 €).
    expect(Math.abs(Number(fx[0]!.gainEur))).toBeLessThan(0.01);
    expect(r.openLots.find((l) => l.assetId === 'US0000000001')!.costEur).toBe('503.5');
    expect(r.openLots.filter((l) => l.class === 'fx')).toEqual([]);
    expect(r.issues.some((i) => i.code === 'fx_shortfall')).toBe(false);
  });

  it('nada del producto de divisa llega a las ventas de acciones', () => {
    const r = run([...t.ops, ...a.ops]);
    expect(r.disposals.some((d) => d.assetId.startsWith('EURUSD'))).toBe(false);
  });
});

describe('Trade Republic', () => {
  const p = parseFile(fx('trade_republic.csv'), rate);
  it('compras, ventas, plan de ahorro y cripto', () => {
    const buy = p.ops.find((o) => o.sourceKey === 'tr:00000000-0000-4000-8000-000000000003')!;
    expect(buy).toMatchObject({ kind: 'buy', quantity: '10', unitPrice: '50', grossEur: '500.00', feeEur: '1.00', totalEur: '501.00', assetClass: 'stock' });
    const sell = p.ops.find((o) => o.kind === 'sell')!;
    expect(sell).toMatchObject({ quantity: '4', grossEur: '240.00', totalEur: '239.00' });
    const plan = p.ops.find((o) => o.assetId === 'IE0000000002')!;
    expect(plan.assetClass).toBe('etf');
    expect(plan.grossEur).toBe('100.00');
    expect(p.ops.find((o) => o.assetId === 'BTC')!).toMatchObject({ assetClass: 'crypto', totalEur: '41.00' });
    assertBalanced(p.ops);
  });
  it('dividendo bruto en euros con retención', () => {
    const d = p.ops.find((o) => o.kind === 'dividend')!;
    expect(d).toMatchObject({ grossEur: '12.00', withholdingEur: '1.80', totalEur: '10.20' });
    expect(d.reviewReasons).toEqual([]);
    expect(d.spanishTaxEur).toBeNull();
  });
  it('intereses, staking de cripto y hora de España', () => {
    expect(p.ops.find((o) => o.kind === 'staking')!).toMatchObject({ assetId: 'ETH', grossEur: '1.35', unitPrice: '2756.98' });
    const late = p.ops.find((o) => o.sourceKey === 'tr:00000000-0000-4000-8000-000000000040')!;
    expect(late.datetime.slice(0, 10)).toBe('2025-01-01');
    expect(p.ops.filter((o) => o.kind === 'interest')).toHaveLength(2);
  });
  it('anula órdenes canceladas y avisa de lo que no sabe tratar', () => {
    expect(p.ops.some((o) => o.assetId === 'FR0000000001')).toBe(false);
    expect(p.warnings.some((w) => w.includes('anulada'))).toBe(true);
    expect(p.warnings.some((w) => w.includes('SPIN_OFF'))).toBe(true);
    expect(p.ignored['Movimientos de efectivo y tarjeta']).toBe(1);
  });
});

describe('Kraken', () => {
  const p = parseFile(fx('kraken_ledgers.csv'), rate);
  const by = (k: string) => p.ops.find((o) => o.sourceKey?.startsWith('kr-') && o.kind === k)!;
  it('normaliza códigos de activo', () => {
    expect(krakenAsset('XXBT')).toBe('BTC');
    expect(krakenAsset('ETH.F')).toBe('ETH');
    expect(krakenAsset('ETH2.S')).toBe('ETH');
    expect(krakenAsset('ZEUR')).toBe('EUR');
    expect(krakenAsset('DOT')).toBe('DOT');
  });
  it('compra con comisión en euros', () => {
    const b = p.ops.find((o) => o.kind === 'buy' && o.assetId === 'BTC')!;
    expect(b).toMatchObject({ quantity: '0.05', grossEur: '2000.00', feeEur: '5.20', totalEur: '2005.20', unitPrice: '40000' });
  });
  it('compra con comisión en especie: cantidad neta y coste total', () => {
    const b = p.ops.find((o) => o.kind === 'buy' && o.assetId === 'ETH')!;
    expect(b).toMatchObject({ quantity: '0.499', totalEur: '1000.00', feeEur: '2.00', grossEur: '998.00' });
    expect(reconcile(b).ok).toBe(true);
  });
  it('venta y permuta sin valor en euros pendiente', () => {
    const s = p.ops.find((o) => o.kind === 'sell' && o.grossEur)!;
    expect(s).toMatchObject({ assetId: 'BTC', grossEur: '600.00', feeEur: '1.50', totalEur: '598.50' });
    const sw = by('swap');
    expect(sw).toMatchObject({ assetId: 'BTC', quantity: '0.01', counterAsset: 'ETH', counterQuantity: '0.1998', grossEur: null });
  });
  it('compra en USD: paga USD y convierte al BCE', () => {
    const b = p.ops.find((o) => o.assetId === 'SOL')!;
    expect(b).toMatchObject({ kind: 'buy', currency: 'USD', grossLocal: '100.00', grossEur: '92.59', settleCurrency: 'USD', fxSource: 'ecb' });
    expect(reconcile(b).ok).toBe(true);
  });
  it('ignora movimientos internos y clasifica staking, retiradas y airdrop', () => {
    expect(p.ignored['Movimientos internos de staking']).toBe(2);
    expect(p.ignored['Filas pendientes sin txid']).toBe(1);
    expect(p.ignored['Ingresos y retiradas en euros']).toBe(1);
    expect(by('staking')).toMatchObject({ assetId: 'ETH', quantity: '0.001', grossEur: null });
    expect(by('transfer_out')).toMatchObject({ assetId: 'BTC', quantity: '0.01' });
    expect(by('reward')).toMatchObject({ assetId: 'DOT', quantity: '5' });
    expect(p.ops.find((o) => o.note?.includes('retirada'))).toMatchObject({ kind: 'fee', feeClass: 'non_deductible', quantity: '0.0001', grossEur: null });
    expect(p.warnings.some((w) => w.includes('Margen'))).toBe(true);
  });
  it('recoge el saldo final para el cuadre', () => {
    expect(p.balances.find((b) => b.assetId === 'BTC')!.quantity).toBe('0.0199');
    expect(p.balances.find((b) => b.assetId === 'ETH')!.quantity).toBe('0.6998');
    expect(p.balances.find((b) => b.assetId === 'EUR')).toBeUndefined();
  });
});

describe('Fechas', () => {
  it('convierte UTC a hora de España con cambio de horario', () => {
    expect(utcToMadrid('2024-12-31T23:30:00Z')).toBe('2025-01-01T00:30:00');
    expect(utcToMadrid('2025-07-01T10:00:00Z')).toBe('2025-07-01T12:00:00');
  });
});

describe('Formatos no admitidos', () => {
  it('rechaza el trades.csv de Kraken con instrucción clara', () => {
    expect(() => parseFile('txid,ordertxid,pair,time,type\n', rate)).toThrow(/Ledgers/);
  });
  it('rechaza lo que no reconoce', () => {
    expect(() => parseFile('a,b\n1,2\n', rate)).toThrow(/no reconocido/);
  });
});

describe('Trade Republic: formato real', () => {
  const r = parseFile(fx('trade_republic_formato.csv'), rate);
  const byKey = (n: number) => r.ops.find((o) => o.sourceKey === `tr:00000000-0000-4000-9000-${String(n).padStart(12, '0')}`)!;
  it('el prepago de una OPV no avisa y su comisión va a la compra adjudicada', () => {
    expect(r.warnings.filter((w) => /IPO_SUBSCRIPTION/.test(w))).toEqual([]);
    expect(byKey(4)).toMatchObject({ kind: 'buy', grossEur: '500.00', feeEur: '1.00', totalEur: '501.00' });
  });
  it('sin adjudicación, la comisión de la OPV queda como gasto', () => {
    expect(r.ops.find((o) => o.kind === 'fee' && o.assetId === 'US0000000098')).toMatchObject({ grossEur: '1.00', feeClass: 'non_deductible' });
  });
  it('el impuesto de una compra suma al coste sin pedir revisión', () => {
    expect(byKey(6)).toMatchObject({ grossEur: '5000.00', feeEur: '1.00', otherCostsEur: '10.00', totalEur: '5011.00', reviewReasons: [] });
  });
  it('el impuesto de una venta se revisa', () => {
    expect(byKey(8).reviewReasons).toHaveLength(1);
  });
  it('separa lo retenido fuera del 19 % español', () => {
    // 11,00 brutos y 3,69 retenidos: 1,98 fuera y el 19 % de los 9,02 restantes, 1,71 aquí.
    expect(byKey(7)).toMatchObject({ grossEur: '11.00', withholdingEur: '3.69', spanishTaxEur: '1.71', reviewReasons: [] });
  });
  it('los intereses con el 19 % son retención española', () => {
    expect(byKey(1)).toMatchObject({ kind: 'interest', withholdingEur: '0.38', spanishTaxEur: '0.38', reviewReasons: [] });
  });
});

describe('Kraken: formato real', () => {
  const r = parseFile(fx('kraken_formato_ledgers.csv'), rate);
  it('«settled» es una compra', () => {
    const buy = r.ops.find((o) => o.kind === 'buy' && o.assetId === 'BTC')!;
    expect(buy).toMatchObject({ totalEur: '400.00', feeEur: '1.20' });
    expect(buy.quantity).toBe('0.00997');
  });
  it('los movimientos de asignación no cuentan como ingresos y «earn/reward» sí', () => {
    const staking = r.ops.filter((o) => o.kind === 'staking');
    expect(staking).toHaveLength(1);
    expect(staking[0]!.quantity).toBe('0.0001');
    expect(staking[0]!.grossEur).toBeTruthy();
  });
  it('el bono por invitación es un airdrop valorado', () => {
    const bonus = r.ops.filter((o) => o.kind === 'reward');
    expect(bonus).toHaveLength(1);
    expect(bonus[0]!.grossEur).toBeTruthy();
  });
  it('ignora importes inferiores a un céntimo', () => {
    expect(r.ops.some((o) => o.assetId === 'ETHW')).toBe(false);
  });
  it('los costes de margen en cripto se agrupan por mes y resta el saldo', () => {
    const fees = r.ops.filter((o) => o.kind === 'fee' && o.assetId === 'BTC');
    expect(fees).toHaveLength(1);
    expect(fees[0]!.quantity).toBe('0.00003');
  });
  it('el margen en euros se resume por año', () => {
    expect(r.warnings.filter((w) => /margen/i.test(w))).toHaveLength(1);
    expect(r.warnings.find((w) => /margen/i.test(w))).toMatch(/2021.*150[.,]25.*9[.,]75/);
  });
  it('una permuta cripto-cripto se valora con el dato en dólares', () => {
    const swap = r.ops.find((o) => o.kind === 'swap')!;
    expect(swap).toMatchObject({ assetId: 'BTC', counterAsset: 'XLM' });
    expect(swap.grossEur).toBeTruthy();
    expect(swap.reviewReasons).toEqual([]);
  });
});

describe('Coinbase', () => {
  const p = parseFile(fx('coinbase.csv'), rate);
  const byId = (id: string) => p.ops.find((o) => o.sourceKey === `cb:${id}`)!;
  it('salta el texto inicial y detecta el formato', () => {
    expect(p).toMatchObject({ broker: 'coinbase', format: 'Historial de transacciones' });
  });
  it('compra y venta con comisión, en hora de España', () => {
    expect(byId('a1')).toMatchObject({ kind: 'buy', assetId: 'BTC', assetClass: 'crypto', quantity: '0.01', grossEur: '400.00', feeEur: '5.00', totalEur: '405.00' });
    expect(byId('a1').datetime).toBe('2024-01-15T11:30:45');
    expect(byId('a4')).toMatchObject({ kind: 'sell', quantity: '0.005', grossEur: '300.00', feeEur: '3.00', totalEur: '297.00' });
    assertBalanced(p.ops);
  });
  it('una conversión es una permuta valorada', () => {
    expect(byId('a3')).toMatchObject({ kind: 'swap', assetId: 'BTC', quantity: '0.002', counterAsset: 'ETH', counterQuantity: '0.04', grossEur: '120.00' });
  });
  it('comprar pagando con otra cripto también es una permuta', () => {
    expect(byId('a11')).toMatchObject({ kind: 'swap', assetId: 'USDC', quantity: '130.5', counterAsset: 'SOL', counterQuantity: '1', grossEur: '120.00' });
  });
  it('recompensas, envíos y movimientos internos', () => {
    expect(byId('a5')).toMatchObject({ kind: 'staking', grossEur: '3.20', quantity: '0.001' });
    expect(byId('a6')).toMatchObject({ kind: 'reward', grossEur: '1.00' });
    expect(byId('a7')).toMatchObject({ kind: 'transfer_out', quantity: '0.1' });
    expect(byId('a8')).toMatchObject({ kind: 'transfer_in', quantity: '2' });
    expect(p.ignored).toMatchObject({ 'Ingresos y retiradas en euros': 1, 'Movimientos internos de Coinbase': 1 });
  });
  it('avisa de lo que no conoce', () => {
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/Mystery Thing/);
  });
  it('informe antiguo en dólares', () => {
    const old = parseFile(fx('coinbase_old.csv'), rate).ops[0]!;
    expect(old).toMatchObject({ kind: 'buy', currency: 'USD', grossLocal: '400.00', grossEur: '370.37', feeEur: '4.63', settleCurrency: 'USD' });
  });
});

describe('Revolut', () => {
  const crypto = parseFile(fx('revolut_crypto.csv'), rate);
  const stocks = parseFile(fx('revolut_stocks.csv'), rate);
  it('cripto: compra, venta y recompensas', () => {
    expect(crypto).toMatchObject({ broker: 'revolut', format: 'Extracto de cripto' });
    const [buy, sell, staking, reward, send, receive] = crypto.ops;
    expect(buy).toMatchObject({ kind: 'buy', assetId: 'BTC', assetClass: 'crypto', grossEur: '400.00', feeEur: '6.00', totalEur: '406.00', datetime: '2024-01-05T10:00:00' });
    expect(sell).toMatchObject({ kind: 'sell', grossEur: '200.00', feeEur: '3.00', totalEur: '197.00', datetime: '2024-03-05T15:30:00' });
    expect(staking).toMatchObject({ kind: 'staking', grossEur: '3.00' });
    expect(reward).toMatchObject({ kind: 'reward', grossEur: '1.00' });
    expect(send).toMatchObject({ kind: 'transfer_out', quantity: '0.5' });
    expect(receive).toMatchObject({ kind: 'transfer_in', quantity: '2' });
    expect(crypto.ignored).toMatchObject({ 'Movimientos internos de staking': 1 });
  });
  it('acciones: identifica por símbolo y separa la comisión', () => {
    expect(stocks).toMatchObject({ broker: 'revolut', format: 'Extracto de acciones' });
    const buy = stocks.ops.find((o) => o.kind === 'buy' && o.assetId === 'AAPL')!;
    expect(buy).toMatchObject({ quantity: '5', unitPrice: '180', grossLocal: '900.00', settleCurrency: 'USD', fxSource: 'broker' });
    expect(D(buy.fxRate!).toNumber()).toBeCloseTo(1.1, 6);
    expect(D(buy.feeEur).toNumber()).toBeCloseTo(0.91, 2);
    const sell = stocks.ops.find((o) => o.kind === 'sell')!;
    expect(sell).toMatchObject({ quantity: '2', grossLocal: '400.00' });
    expect(D(sell.feeEur).toNumber()).toBeCloseTo(0.91, 2);
    assertBalanced(stocks.ops);
    expect(stocks.markets).toMatchObject({ AAPL: 'us' });
  });
  it('acepta el tipo de cambio en cualquier sentido', () => {
    const buy = stocks.ops.find((o) => o.assetId === 'ORCL')!;
    expect(D(buy.fxRate!).toNumber()).toBeCloseTo(1.1, 6);
  });
  it('aprovecha un ISIN explícito y no asigna mercado estadounidense a un ETF europeo en dólares', () => {
    const csv = 'Date,Ticker,ISIN,Type,Quantity,Price per share,Total Amount,Currency,FX Rate\n2026-01-02T12:00:00,VUAA,IE00BFMXXD54,BUY,2,100,200,USD,1.08\n';
    const parsed = parseFile(csv, rate);
    expect(parsed.ops[0]).toMatchObject({ assetId: 'IE00BFMXXD54', assetClass: 'etf' });
    expect(parsed.markets['IE00BFMXXD54']).toBeUndefined();
  });
  it('el dividendo llega neto y se marca para revisar', () => {
    const d = stocks.ops.find((o) => o.kind === 'dividend')!;
    expect(d).toMatchObject({ assetId: 'AAPL', currency: 'USD', withholdingEur: '0.00' });
    expect(d.reviewReasons?.[0]).toMatch(/neto/);
  });
  it('ingreso en dólares, custodia, split y traspasos', () => {
    expect(stocks.ops.find((o) => o.kind === 'deposit')).toMatchObject({ currency: 'USD', grossLocal: '1500' });
    expect(stocks.ops.find((o) => o.kind === 'fee')).toMatchObject({ feeClass: 'custody', assetName: 'Revolut' });
    expect(stocks.ops.find((o) => o.kind === 'split')).toMatchObject({ assetId: 'AAPL', quantity: '3' });
    expect(stocks.ignored).toMatchObject({ 'Traspasos entre sociedades de Revolut': 1 });
    expect(stocks.warnings.filter((w) => /SOMETHING NEW/.test(w))).toHaveLength(1);
  });
  it('el extracto de la cuenta se rechaza con una explicación', () => {
    expect(() => parseFile('Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nTOPUP,Current,2024-01-01,2024-01-01,x,1,0,EUR,COMPLETED,1\n', rate)).toThrow(/Inversiones o el de Cripto/);
  });
});
