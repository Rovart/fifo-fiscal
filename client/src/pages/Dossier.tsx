import { ArrowLeft, Printer } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { Dossier as DossierData } from '../../../server/dossier.ts';
import { D } from '../../../shared/decimal.ts';
import type { FormSection } from '../../../server/engine/report.ts';
import { BROKER_LABEL, type Broker, type DossierLot, type Income } from '../../../shared/types.ts';
import { Help, Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, isinOf, niceName, qty, signClass, signed } from '../format.ts';
import { useApi } from '../hooks.ts';

const nz = (v: string | null | undefined) => !D(v).isZero();
const place = (b: string | null) => (b ? BROKER_LABEL[b as Broker] ?? 'Cartera propia' : '—');
const INCOME: Record<Income['type'], string> = {
  dividend: 'Dividendo', interest: 'Interés', staking: 'Staking', reward: 'Recompensa', capital_excess: 'Devolución de capital', bond: 'Renta fija',
};
const FLAG: Record<NonNullable<DossierLot['flag']>, string> = { falta: 'Sin compra', posterior: 'Compra posterior', coste0: 'Coste 0' };
const SECTION: Record<FormSection['id'], string> = { stock: 'Acciones', etf: 'ETF y fondos', crypto: 'Criptomonedas', fx: 'Divisas', other: 'Otros valores' };

function Row({ box, label, value, strong }: { box?: string; label: ReactNode; value: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'strong' : undefined}>
      <td>{label}</td>
      <td className="faint">{box ?? ''}</td>
      <td className="r">{eur(value)}</td>
    </tr>
  );
}

/** Documento para revisar el ejercicio con un gestor: se imprime o se guarda en PDF desde el navegador. */
export function Dossier() {
  const { year, tick, go } = useApp();
  const { data } = useApi<DossierData>(`/dossier/${year}`, `${year}-${tick}`);
  const head = (
    <PageHead title={`Dossier ${year}`} year>
      <button className="btn" onClick={() => go('renta')}><ArrowLeft size={16} /> Mi Renta</button>
      <button className="btn primary" disabled={!data} onClick={() => window.print()}><Printer size={16} /> PDF</button>
    </PageHead>
  );
  if (!data) return <>{head}<Loading /></>;
  const { report: rep } = data;
  const rcm = rep.rcm;
  const interest = D(rcm.interest).plus(D(rcm.staking)).toFixed(2);
  const dividends = D(rcm.dividends).plus(D(rcm.capitalExcess)).toFixed(2);
  const issues = rep.issues.filter((i) => i.severity !== 'info');
  const deferred = data.deferred;
  const fromYear = (t: { saleDate: string }) => Number(t.saleDate.slice(0, 4));
  const total = (xs: string[]) => xs.reduce((s, x) => s.plus(D(x)), D(0)).toFixed(2);
  const deferredOut = total(deferred.filter((t) => fromYear(t) === year).map((t) => t.amountEur));
  const deferredIn = total(deferred.filter((t) => fromYear(t) < year).map((t) => t.amountEur));
  const forms = data.foreign.forms.filter((f) => nz(f.valueEur) || f.required || f.filed);
  const outside = data.foreign.forms.find((f) => nz(f.outside.valueEur))?.outside.valueEur;
  const sectionId = new Map(rep.sections.map((s) => [s.title, s.id]));
  const bySection = rep.sections.map((s) => ({ id: s.id, assets: data.assets.filter((a) => a.section === s.title) })).filter((s) => s.assets.length > 0);
  const loose = data.assets.filter((a) => !sectionId.has(a.section));
  if (loose.length) bySection.push({ id: 'other', assets: loose });

  return (
    <>
      {head}
      <article className="dossier">
        <header className="dossier-cover card">
          <h1>{data.profile}</h1>
          <div className="small muted">Ejercicio {year} · {dateShort(data.generatedAt.slice(0, 10))}</div>
        </header>

        {issues.length > 0 && (
          <section className="card dossier-warn">
            <h2>Pendiente de revisar</h2>
            <ul>{issues.map((i, n) => <li key={n}>{i.assetName ? `${niceName(i.assetName)}: ` : ''}{i.message}</li>)}</ul>
          </section>
        )}

        <section className="card">
          <h2>Casillas</h2>
          <table className="mini-table dossier-boxes">
            <tbody>
              {nz(interest) && <Row box="0027" label={nz(rcm.staking) ? 'Intereses y staking' : 'Intereses'} value={interest} />}
              {nz(dividends) && <Row box="0029" label="Dividendos" value={dividends} />}
              {nz(rcm.bonds) && <Row box="0031" label="Renta fija" value={rcm.bonds} />}
              {nz(rcm.custody) && <Row box="0037" label="Gastos de custodia" value={rcm.custody} />}
              {nz(rcm.grossTotal) && <Row box="0038" label="Rendimiento neto" value={rcm.net} />}
              {nz(rcm.spanishTax) && <Row box="0597" label="Retenciones en España" value={rcm.spanishTax} />}
              {rep.sections.map((s) => (
                <Fragment key={s.id}>
                  {nz(s.gainTotal) && <Row box={s.boxes.sumGain} label={`${SECTION[s.id]} · ganancias`} value={s.gainTotal} />}
                  {nz(s.lossComputableTotal) && <Row box={s.boxes.sumLoss} label={`${SECTION[s.id]} · pérdidas`} value={s.lossComputableTotal} />}
                </Fragment>
              ))}
              {D(rep.rewards).gt(0) && <Row box="0304" label="Recompensas y airdrops" value={rep.rewards} />}
              {nz(rep.doubleTaxDeduction) && <Row box="0588" label="Deducción por doble imposición" value={rep.doubleTaxDeduction} />}
            </tbody>
          </table>
          <table className="mini-table dossier-boxes dossier-totals">
            <tbody>
              <Row label="Saldo de ventas" value={rep.savings.gppBalance} />
              <Row label="Saldo de rentas" value={rep.savings.rcmBalance} />
              {rep.savings.steps.map((st) => <Row key={st.label} label={st.label} value={st.amount} />)}
              <Row label="Base del ahorro" value={rep.savings.base} />
              <Row label="Cuota estimada" value={rep.savings.tax} />
              <Row label="A pagar, estimado" value={rep.savings.taxAfterCredits} strong />
            </tbody>
          </table>
          {rep.savings.carryForward.length > 0 && (
            <p className="small muted">Pérdidas pendientes: {rep.savings.carryForward.map((c) => `${eur(c.amount)} de ${c.year}, hasta ${c.expires}`).join(' · ')}</p>
          )}
        </section>

        {data.notes.length > 0 && (
          <section className="card">
            <h2>Ajustes aplicados</h2>
            <ul className="dossier-notes">
              {data.notes.map((n, i) => <li key={i}>{n.date && <span className="faint">{dateShort(n.date)} · </span>}{n.text}</li>)}
            </ul>
          </section>
        )}

        {bySection.map((sec) => (
          <section className="card flush dossier-section" key={sec.id}>
            <div className="card-title"><h2>{SECTION[sec.id as FormSection['id']]}</h2></div>
            {sec.assets.map((a) => (
              <div className="dossier-asset dossier-scroll" key={a.assetId}>
                <table className="mini-table dossier-sales">
                  <colgroup><col style={{ width: '22%' }} /><col style={{ width: '18%' }} /><col style={{ width: '14%' }} /><col /><col /><col /></colgroup>
                  {/* En papel, el nombre del activo se repite en cada página y nunca queda separado de sus ventas. */}
                  <thead>
                    <tr className="asset-row">
                      <th colSpan={6}>
                        <div className="dossier-asset-head">
                          <div className="main-col">
                            <div className="name">{niceName(a.assetName)}</div>
                            {isinOf(a.assetId) && <div className="small muted">{a.assetId}</div>}
                          </div>
                          <div className={`name ${signClass(a.gainEur)}`}>{signed(a.gainEur)}</div>
                        </div>
                      </th>
                    </tr>
                    <tr><th>Fecha</th><th>Bróker</th><th className="r">Cantidad</th><th className="r">Venta</th><th className="r">Coste</th><th className="r">Resultado</th></tr>
                  </thead>
                  <tbody>
                    {a.sales.map((s, i) => (
                      <Fragment key={i}>
                        <tr className="sale">
                          <td>{dateShort(s.date)}{s.edited && <span className="tag">Corregida</span>}</td>
                          <td>{place(s.broker)}</td>
                          <td className="r">{qty(s.quantity)}</td>
                          <td className="r">{eur(s.proceedsEur)}</td>
                          <td className="r">{eur(s.costEur)}</td>
                          <td className="r">{signed(s.gainEur)}</td>
                        </tr>
                        {s.lots.map((l, j) => (
                          <tr className="lot" key={j}>
                            <td>compra {l.flag === 'falta' ? '' : dateShort(l.date)}{l.flag && <span className="tag warn">{FLAG[l.flag]}</span>}{l.edited && <span className="tag">Corregida</span>}</td>
                            <td>{place(l.broker)}</td>
                            <td className="r">{qty(l.quantity)}</td>
                            <td />
                            <td className="r">{eur(l.costEur)}</td>
                            <td />
                          </tr>
                        ))}
                      </Fragment>
                    ))}
                  </tbody>
                  {a.sales.length > 1 && (
                    <tfoot>
                      <tr><td colSpan={3}>Total</td><td className="r">{eur(a.proceedsEur)}</td><td className="r">{eur(a.costEur)}</td><td className="r">{signed(a.gainEur)}</td></tr>
                    </tfoot>
                  )}
                </table>
              </div>
            ))}
          </section>
        ))}

        {deferred.length > 0 && (
          <section className="card">
            <h2 className="inline">Pérdidas aplazadas <Help text={HELP.aplazada} /></h2>
            <table className="mini-table">
              <thead><tr><th>Activo</th><th>Venta</th><th className="r">Pérdida</th><th>Estado</th></tr></thead>
              <tbody>
                {deferred.map((t) => (
                  <tr key={`${t.assetId}|${t.saleDate}|${t.status}|${t.year}`}>
                    <td>{niceName(t.assetName)}</td>
                    <td>{dateShort(t.saleDate)}</td>
                    <td className="r">{eur(t.amountEur)}</td>
                    <td>{fromYear(t) < year ? `De ${fromYear(t)}, cuenta ahora` : t.status === 'integrated' ? `Cuenta en ${t.year}` : t.status === 'blocked' ? 'Aplazada' : `Hasta el ${dateShort(t.windowEnd)}`}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {nz(deferredOut) && <tr><td colSpan={2}>Se aplaza</td><td className="r">{eur(deferredOut)}</td><td /></tr>}
                {nz(deferredIn) && <tr><td colSpan={2}>Cuenta este año</td><td className="r">{eur(deferredIn)}</td><td /></tr>}
              </tfoot>
            </table>
          </section>
        )}

        {data.incomes.length > 0 && (
          <section className="card">
            <h2>Rentas</h2>
            <div className="dossier-scroll">
              <table className="mini-table dossier-incomes">
                <thead><tr><th>Activo</th><th>Tipo</th><th className="r">Cobros</th><th className="r">Bruto</th><th className="r">Ret. origen</th><th className="r">Ret. España</th></tr></thead>
                <tbody>
                  {data.incomes.map((i) => (
                    <tr key={`${i.assetId}|${i.type}`}>
                      <td>{niceName(i.assetName)}<div className="small faint">{i.brokers.map(place).join(', ')}</div></td>
                      <td>{INCOME[i.type]}</td>
                      <td className="r">{i.count}</td>
                      <td className="r">{eur(i.grossEur)}</td>
                      <td className="r">{nz(i.foreignTaxEur) ? eur(i.foreignTaxEur) : '—'}</td>
                      <td className="r">{nz(i.spanishTaxEur) ? eur(i.spanishTaxEur) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3}>Total</td>
                    <td className="r">{eur(total(data.incomes.map((i) => i.grossEur)))}</td>
                    <td className="r">{eur(total(data.incomes.map((i) => i.foreignTaxEur)))}</td>
                    <td className="r">{eur(total(data.incomes.map((i) => i.spanishTaxEur)))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {rep.doubleTax.length > 0 && (
              <>
                <h3>Doble imposición</h3>
                <table className="mini-table">
                  <thead><tr><th>País</th><th className="r">Retenido</th><th className="r">Deducible</th></tr></thead>
                  <tbody>
                    {rep.doubleTax.map((d) => <tr key={d.country}><td>{d.country}</td><td className="r">{eur(d.withheld)}</td><td className="r">{eur(d.deductible)}</td></tr>)}
                  </tbody>
                </table>
              </>
            )}
          </section>
        )}

        {forms.length > 0 && (
          <section className="card">
            <h2>Modelos 720 y 721</h2>
            <table className="mini-table">
              <thead><tr><th>Modelo</th><th className="r">Valor a 31/12</th><th>Estado</th></tr></thead>
              <tbody>
                {forms.map((f) => (
                  <tr key={f.form}>
                    <td>{f.form}</td>
                    <td className="r">{eur(f.valueEur)}</td>
                    <td>{f.filed ? <span className="tag gain">Presentado</span> : f.required ? <span className="tag warn">Obligatorio</span> : <span className="tag">No hace falta</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {outside && <p className="small muted">Cripto en carteras propias: {eur(outside)}. No se declara.</p>}
          </section>
        )}
      </article>
    </>
  );
}
