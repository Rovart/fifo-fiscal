import ExcelJS from 'exceljs';
import { D } from '../shared/decimal.ts';
import { BROKER_LABEL, CLASS_LABEL, KIND_LABEL } from '../shared/types.ts';
import { isNeutralFx } from './engine/report.ts';
import { allOps } from './db.ts';
import { assetsMap, calculationOps, engine, report, withAssetMeta } from './service.ts';

const EUR = '#,##0.00 "€"';
const num = (s: string | null | undefined) => (s === null || s === undefined || s === '' ? null : D(s).toNumber());

function style(ws: ExcelJS.Worksheet, moneyCols: number[] = []) {
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F3A5F' } };
  head.alignment = { vertical: 'middle', wrapText: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
  for (const c of moneyCols) ws.getColumn(c).numFmt = EUR;
}

export async function exportYear(year: number): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'FIFO Fiscal';
  const rep = report(year);
  const res = engine();

  const sum = wb.addWorksheet('Resumen');
  sum.columns = [{ header: `Ejercicio ${year}`, key: 'a', width: 62 }, { header: 'Importe', key: 'b', width: 16, style: { numFmt: EUR } }, { header: 'Casilla', key: 'c', width: 12 }];
  const add = (a: string, b: string | null, c = '') => sum.addRow({ a, b: num(b), c });
  add('Intereses de cuentas y activos financieros', rep.rcm.interest, '0027');
  add('Rendimientos de staking', rep.rcm.staking, '0027');
  add('Dividendos', rep.rcm.dividends, '0029');
  add('Exceso de devolución de capital sobre el coste', rep.rcm.capitalExcess, '0029');
  add('Transmisión o amortización de renta fija', rep.rcm.bonds, '0031');
  add('Gastos de administración y depósito', rep.rcm.custody, '0037');
  add('Rendimiento neto del capital mobiliario', rep.rcm.net, '0038');
  add('Retenciones españolas sobre capital mobiliario', rep.rcm.spanishTax, '0597');
  add('Airdrops y recompensas (base general)', rep.rewards, '0304');
  sum.addRow({});
  for (const s of rep.sections) {
    add(`${s.title}: ganancias`, s.gainTotal);
    add(`${s.title}: pérdidas obtenidas`, s.lossTotal);
    add(`${s.title}: pérdidas computables`, s.lossComputableTotal);
  }
  sum.addRow({});
  add('Pérdidas diferidas por recompra generadas', rep.deferred.generated);
  add('Pérdidas diferidas de años anteriores integradas', rep.deferred.released);
  add('Pérdidas diferidas pendientes a fin de ejercicio', rep.deferred.pendingEnd);
  sum.addRow({});
  add('Saldo de transmisiones', rep.savings.gppBalance);
  add('Saldo de capital mobiliario', rep.savings.rcmBalance);
  for (const st of rep.savings.steps) add(st.label, st.amount);
  add('Base liquidable del ahorro (estimada)', rep.savings.base);
  add('Cuota estimada del ahorro', rep.savings.tax);
  add('Deducción por doble imposición internacional', rep.doubleTaxDeduction, '0588');
  sum.getRow(1).font = { bold: true };

  const form = wb.addWorksheet('Renta Web');
  form.columns = [
    { header: 'Bloque', key: 'sec', width: 38 }, { header: 'Denominación', key: 'name', width: 34 }, { header: 'ISIN o activo', key: 'id', width: 16 }, { header: 'Clave', key: 'clave', width: 7 },
    { header: 'Valor de transmisión', key: 't', width: 15 }, { header: 'Valor de adquisición', key: 'a', width: 15 }, { header: 'Ganancia', key: 'g', width: 13 },
    { header: 'Pérdida obtenida', key: 'lo', width: 13 }, { header: 'Pérdida computable', key: 'lc', width: 13 }, { header: 'Casillas (transm./adq.)', key: 'box', width: 16 }, { header: 'Nota', key: 'note', width: 60 },
  ];
  for (const s of rep.sections) {
    for (const e of s.entries) {
      form.addRow({
        sec: s.title, name: e.name, id: e.assetId.replace('FX:', ''), clave: e.clave ?? '', t: num(e.transmission), a: num(e.acquisition), g: num(e.gain), lo: num(e.lossObtained),
        lc: num(e.lossComputable), box: `${s.boxes.transmission} / ${s.boxes.acquisition}`, note: e.note ?? '',
      });
    }
  }
  style(form, [5, 6, 7, 8, 9]);

  const det = wb.addWorksheet('Transmisiones FIFO');
  det.columns = [
    { header: 'Fecha venta', key: 'd', width: 12 }, { header: 'Activo', key: 'n', width: 32 }, { header: 'ISIN o activo', key: 'id', width: 16 }, { header: 'Clase', key: 'c', width: 9 }, { header: 'Bróker venta', key: 'b', width: 14 },
    { header: 'Fecha compra', key: 'ad', width: 12 }, { header: 'Cantidad', key: 'q', width: 14 }, { header: 'Valor transmisión', key: 'p', width: 14 }, { header: 'Valor adquisición', key: 'cost', width: 14 }, { header: 'Resultado', key: 'g', width: 13 }, { header: 'Aviso', key: 'w', width: 26 },
  ];
  for (const d of res.disposals.filter((x) => x.year === year && !isNeutralFx(x))) {
    for (const m of d.matches) {
      det.addRow({
        d: d.date, n: d.assetName, id: d.assetId.replace('FX:', ''), c: CLASS_LABEL[d.class], b: BROKER_LABEL[d.broker], ad: m.acqDate.slice(0, 10), q: num(m.quantity),
        p: num(m.proceedsEur), cost: num(m.costEur), g: num(m.gainEur), w: m.missing ? 'Sin compra registrada' : d.incomplete ? 'Sin valor en euros' : d.derived ? 'Efecto divisa separado' : '',
      });
    }
  }
  style(det, [8, 9, 10]);

  const def = wb.addWorksheet('Pérdidas diferidas');
  def.columns = [
    { header: 'Activo', key: 'n', width: 32 }, { header: 'Venta con pérdida', key: 'o', width: 14 }, { header: 'Cantidad', key: 'q', width: 12 }, { header: 'Pérdida', key: 'a', width: 13 },
    { header: 'Estado', key: 's', width: 18 }, { header: 'Ejercicio de integración', key: 'y', width: 12 }, { header: 'Compra que la bloquea', key: 'b', width: 14 }, { header: 'ISIN o activo', key: 'id', width: 16 },
  ];
  for (const t of rep.deferred.tranches) {
    def.addRow({
      n: t.assetName, o: t.originDate, q: num(t.quantity), a: num(t.amountEur), s: t.status === 'blocked' ? 'Diferida' : t.status === 'pending_window' ? 'Ventana abierta' : 'Integrada',
      y: t.status === 'blocked' ? '' : t.year, b: t.blockerDate?.slice(0, 10) ?? '', id: t.assetId,
    });
  }
  style(def, [4]);

  const inc = wb.addWorksheet('Dividendos e intereses');
  inc.columns = [
    { header: 'Fecha', key: 'd', width: 12 }, { header: 'Tipo', key: 't', width: 14 }, { header: 'Activo', key: 'n', width: 34 }, { header: 'Bróker', key: 'b', width: 14 }, { header: 'País', key: 'c', width: 6 },
    { header: 'Bruto', key: 'g', width: 12 }, { header: 'Retención extranjera', key: 'f', width: 12 }, { header: 'Retención española', key: 's', width: 12 }, { header: 'Neto', key: 'net', width: 12 },
  ];
  for (const i of res.incomes.filter((x) => x.year === year)) {
    inc.addRow({ d: i.date, t: i.type, n: i.assetName, b: BROKER_LABEL[i.broker], c: i.country, g: num(i.grossEur), f: num(i.foreignTaxEur), s: num(i.spanishTaxEur), net: num(i.netEur) });
  }
  style(inc, [6, 7, 8, 9]);

  const dbl = wb.addWorksheet('Doble imposición');
  dbl.columns = [
    { header: 'País', key: 'c', width: 8 }, { header: 'Bruto', key: 'g', width: 13 }, { header: 'Retenido', key: 'w', width: 13 }, { header: 'Tipo de convenio %', key: 't', width: 10 },
    { header: 'Deducible', key: 'd', width: 13 }, { header: 'Exceso a reclamar en origen', key: 'e', width: 16 },
  ];
  for (const x of rep.doubleTax) dbl.addRow({ c: x.country, g: num(x.gross), w: num(x.withheld), t: num(x.treatyRate), d: num(x.deductible), e: num(x.excess) });
  style(dbl, [2, 3, 5, 6]);

  const pos = wb.addWorksheet(`Posición 31-12-${year}`);
  pos.columns = [
    { header: 'Activo', key: 'n', width: 34 }, { header: 'ISIN o activo', key: 'id', width: 16 }, { header: 'Clase', key: 'c', width: 9 }, { header: 'Cantidad', key: 'q', width: 16 }, { header: 'Coste FIFO', key: 'cost', width: 14 }, { header: 'Reparto por bróker', key: 'b', width: 44 },
  ];
  for (const p of rep.yearEnd) {
    pos.addRow({
      n: p.assetName, id: p.assetId.replace('FX:', ''), c: CLASS_LABEL[p.class as keyof typeof CLASS_LABEL], q: num(p.quantity), cost: num(p.costEur),
      b: Object.entries(p.byBroker).map(([k, v]) => `${k}: ${v}`).join(' · '),
    });
  }
  style(pos, [5]);

  const opsSheet = wb.addWorksheet('Operaciones');
  opsSheet.columns = [
    { header: 'Fecha y hora', key: 'd', width: 19 }, { header: 'Bróker', key: 'b', width: 14 }, { header: 'Tipo', key: 'k', width: 16 }, { header: 'Activo', key: 'n', width: 32 }, { header: 'ISIN o activo', key: 'id', width: 16 },
    { header: 'Cantidad', key: 'q', width: 14 }, { header: 'Precio', key: 'p', width: 13 }, { header: 'Divisa', key: 'c', width: 7 }, { header: 'Importe divisa', key: 'gl', width: 13 }, { header: 'Tipo de cambio', key: 'fx', width: 11 },
    { header: 'Importe EUR', key: 'ge', width: 13 }, { header: 'Comisión', key: 'fee', width: 10 }, { header: 'Otros gastos', key: 'other', width: 10 }, { header: 'Retención', key: 'wh', width: 10 }, { header: 'Total EUR', key: 't', width: 13 }, { header: 'Editada', key: 'e', width: 8 }, { header: 'Cálculo FIFO', key: 'fifo', width: 20 },
  ];
  const calculated = new Map(calculationOps().map((o) => [o.id, o]));
  for (const o of withAssetMeta(allOps(), assetsMap()).filter((x) => x.datetime.startsWith(String(year)))) {
    opsSheet.addRow({
      d: o.datetime.replace('T', ' '), b: BROKER_LABEL[o.broker], k: KIND_LABEL[o.kind], n: o.assetName, id: o.assetId, q: num(o.quantity), p: num(o.unitPrice), c: o.currency, gl: num(o.grossLocal), fx: num(o.fxRate),
      ge: num(o.grossEur), fee: num(o.feeEur), other: num(o.otherCostsEur), wh: num(o.withholdingEur), t: num(o.totalEur), e: o.edited ? 'Sí' : '', fifo: !calculated.has(o.id) ? 'Fuera del FIFO' : calculated.get(o.id)?.fifoLeg ? 'Recorte parcial' : 'Incluida',
    });
  }
  style(opsSheet, [11, 12, 13, 14, 15]);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
