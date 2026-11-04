import { D, ZERO, cents } from '../shared/decimal.ts';
import type { DossierAsset, DossierIncome, DossierLot, DossierNote, ForeignReport } from '../shared/types.ts';
import { allOps, currentProfileId, getSettings, listProfiles } from './db.ts';
import { isNeutralFx, type YearReport } from './engine/report.ts';
import { foreignReport } from './foreign.ts';
import { engine, report } from './service.ts';

export interface Dossier {
  year: number; profile: string; generatedAt: string; report: YearReport; assets: DossierAsset[]; incomes: DossierIncome[];
  notes: DossierNote[]; foreign: ForeignReport;
}

const day = (s: string) => s.slice(0, 10);
const sum = (xs: string[]) => cents(xs.reduce((s, x) => s.plus(D(x)), ZERO));

/** Todo lo que un gestor necesita para revisar el ejercicio: casillas, cada venta con sus compras y las decisiones tomadas. */
export function dossier(year: number): Dossier {
  const res = engine();
  const rep = report(year);
  const settings = getSettings();
  const ops = new Map(allOps().map((o) => [o.id, o]));
  const sectionOf = new Map(rep.sections.flatMap((s) => s.entries.map((e) => [e.assetId, s.title] as const)));

  const byAsset = new Map<string, DossierAsset>();
  for (const d of res.disposals.filter((x) => x.year === year && !isNeutralFx(x)).sort((a, b) => a.date.localeCompare(b.date))) {
    const asset = byAsset.get(d.assetId) ?? { assetId: d.assetId, assetName: d.assetName, section: sectionOf.get(d.assetId) ?? '', proceedsEur: '0', costEur: '0', gainEur: '0', sales: [] };
    const lots: DossierLot[] = d.matches.map((m) => ({
      date: day(m.acqDate), broker: m.broker ?? null, quantity: m.quantity, costEur: cents(D(m.costEur)),
      flag: m.missing || m.lotId === 'FALTA' ? 'falta' : m.lotId === 'COMPRA-POSTERIOR' ? 'posterior' : D(m.costEur).isZero() ? 'coste0' : null,
      edited: !!(m.acqOpId && ops.get(m.acqOpId)?.edited),
    }));
    asset.sales.push({
      date: day(d.date), broker: d.broker, quantity: d.quantity, proceedsEur: cents(D(d.proceedsEur)), costEur: cents(D(d.costEur)), gainEur: cents(D(d.gainEur)),
      edited: !!ops.get(d.opId)?.edited, lots,
    });
    byAsset.set(d.assetId, asset);
  }
  const order = rep.sections.map((s) => s.title);
  const assets = [...byAsset.values()].map((a) => ({
    ...a, proceedsEur: sum(a.sales.map((s) => s.proceedsEur)), costEur: sum(a.sales.map((s) => s.costEur)), gainEur: sum(a.sales.map((s) => s.gainEur)),
  })).sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || a.assetName.localeCompare(b.assetName));

  const groups = new Map<string, DossierIncome>();
  for (const i of res.incomes.filter((x) => x.year === year)) {
    const key = `${i.assetId}|${i.type}|${i.broker}`;
    const g = groups.get(key) ?? { assetId: i.assetId, assetName: i.assetName, type: i.type, broker: i.broker, country: i.country, count: 0, grossEur: '0', foreignTaxEur: '0', spanishTaxEur: '0', netEur: '0' };
    g.count++;
    g.grossEur = cents(D(g.grossEur).plus(D(i.grossEur)));
    g.foreignTaxEur = cents(D(g.foreignTaxEur).plus(D(i.foreignTaxEur)));
    g.spanishTaxEur = cents(D(g.spanishTaxEur).plus(D(i.spanishTaxEur)));
    g.netEur = cents(D(g.netEur).plus(D(i.netEur)));
    groups.set(key, g);
  }
  const incomes = [...groups.values()].sort((a, b) => a.type.localeCompare(b.type) || D(b.grossEur).cmp(D(a.grossEur)));

  const name = (id: string) => (id === 'CRYPTO:*' ? 'Todas las criptomonedas' : id === '*' ? 'Todo' : res.positions.find((p) => p.assetId === id)?.assetName ?? byAsset.get(id)?.assetName ?? id);
  const notes: DossierNote[] = [];
  const cover = settings.shortfallCover;
  if (cover && cover.from.slice(0, 4) <= String(year) && cover.to.slice(0, 4) >= String(year)) {
    notes.push({ date: null, text: `Las ventas de criptomonedas sin compra previa entre el ${cover.from} y el ${cover.to} toman el coste de las compras siguientes, como el informe de CoinTracking con el que se declaró ese periodo.` });
  }
  for (const [id, start] of Object.entries(settings.fifoStartDates ?? {})) {
    if (start.slice(0, 4) <= String(year)) notes.push({ date: start, text: `${name(id)}: el FIFO empieza aquí; lo anterior se declaró en su momento y no se arrastra.` });
  }
  for (const [id, c] of Object.entries(settings.fifoConfirmedClosures ?? {})) {
    const end = new Date(Date.UTC(Number(c.month.slice(0, 4)), Number(c.month.slice(5, 7)), 0)).toISOString().slice(0, 10);
    if (c.month.slice(0, 4) === String(year)) notes.push({ date: end, text: `${name(id)}: saldo cero confirmado a fin de mes. ${c.note}` });
  }
  const resets = (res.inventoryResets ?? []).filter((r) => r.date.slice(0, 4) === String(year) && D(r.quantityBefore).gt(0));
  for (const r of resets.filter((x) => D(x.costEurBefore).gte(1))) {
    notes.push({ date: r.date, text: `${name(r.assetId)}: se da por cerrado un resto de ${D(r.quantityBefore).toFixed()} con coste ${cents(D(r.costEurBefore))} €, sin efecto fiscal. ${r.note}`.trim() });
  }
  const dust = resets.filter((x) => D(x.costEurBefore).lt(1)).length;
  if (dust) notes.push({ date: null, text: `${dust === 1 ? 'Un resto mínimo' : `${dust} restos mínimos`}, de menos de 1 € de coste, se ${dust === 1 ? 'da' : 'dan'} por ${dust === 1 ? 'cerrado' : 'cerrados'} tras su último movimiento.` });
  const lots = assets.flatMap((a) => a.sales.flatMap((s) => s.lots));
  const free = lots.filter((l) => l.flag === 'coste0').length;
  if (free) notes.push({ date: null, text: `${free === 1 ? 'Una compra se toma' : `${free} compras se toman`} con coste 0: regalos, airdrops o datos antiguos de CoinTracking sin precio.` });
  const missing = lots.filter((l) => l.flag === 'falta').length;
  if (missing) notes.push({ date: null, text: `${missing === 1 ? 'Una venta tiene' : `${missing} ventas tienen`} una parte sin compra que la respalde: esa parte va con coste 0.` });
  const edited = [...new Set(assets.flatMap((a) => a.sales.filter((s) => s.edited || s.lots.some((l) => l.edited)).map(() => a.assetId)))].length;
  if (edited) notes.push({ date: null, text: `Hay operaciones corregidas a mano en ${edited === 1 ? 'un activo' : `${edited} activos`}; van marcadas en el detalle.` });
  notes.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

  const profile = listProfiles().find((p) => p.id === currentProfileId())?.name ?? '';
  return { year, profile, generatedAt: new Date().toISOString(), report: rep, assets, incomes, notes, foreign: foreignReport(year) };
}
