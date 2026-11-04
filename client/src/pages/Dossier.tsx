import { ArrowLeft, Printer } from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { Dossier as DossierData } from '../../../server/dossier.ts';
import { D } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type DossierLot, type Income } from '../../../shared/types.ts';
import { Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dateShort, eur, isinOf, niceName, qty, signed } from '../format.ts';
import { useApi } from '../hooks.ts';

const nz = (v: string | null | undefined) => !D(v).isZero();
const place = (b: string | null) => (b ? BROKER_LABEL[b as Broker] ?? 'Fuera de los brókers' : '—');
const INCOME: Record<Income['type'], string> = {
  dividend: 'Dividendos', interest: 'Intereses', staking: 'Staking', reward: 'Recompensa', capital_excess: 'Devolución de capital', bond: 'Renta fija',
};
const FLAG: Record<NonNullable<DossierLot['flag']>, string> = {
  falta: 'Sin compra: coste 0',
  posterior: 'Coste de una compra posterior',
  coste0: 'Coste 0',
};

function Row({ box, label, value }: { box?: string; label: ReactNode; value: string }) {
  return (
    <tr>
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
    <PageHead title={`Dossier ${year}`} sub="Para revisarlo con tu gestor. Imprímelo o guárdalo en PDF." year>
      <button className="btn" onClick={() => go('renta')}><ArrowLeft size={16} /> Mi Renta</button>
      <button className="btn primary" disabled={!data} onClick={() => window.print()}><Printer size={16} /> Imprimir o PDF</button>
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
  const deferredOut = deferred.filter((t) => fromYear(t) === year).reduce((s, t) => s.plus(D(t.amountEur)), D(0));
  const deferredIn = deferred.filter((t) => fromYear(t) < year).reduce((s, t) => s.plus(D(t.amountEur)), D(0));
  const incomeTotal = (k: 'grossEur' | 'foreignTaxEur' | 'spanishTaxEur') => data.incomes.reduce((s, i) => s.plus(D(i[k])), D(0)).toFixed(2);
  const filedForms = data.foreign.forms.filter((f) => nz(f.valueEur) || f.required || f.filed);

  return (
    <>
      {head}
      <article className="dossier">
        <header className="dossier-cover card">
          <div className="small muted">Ejercicio {year} · Renta {year + 1}</div>
          <h1>{data.profile}</h1>
          <p className="small muted">
            Generado el {dateShort(data.generatedAt.slice(0, 10))} con FIFO Fiscal. Importes en euros. Cada venta se calcula por FIFO dentro de cada activo, con las comisiones incluidas en el coste y en lo cobrado.
          </p>
        </header>

        {issues.length > 0 && (
          <section className="card dossier-warn">
            <h2>Avisos sin resolver</h2>
            <ul>{issues.map((i, n) => <li key={n}>{i.assetName ? `${niceName(i.assetName)}: ` : ''}{i.message}</li>)}</ul>
          </section>
        )}

        <section className="card">
          <h2>Casillas</h2>
          <table className="mini-table dossier-boxes">
            <thead><tr><th>Concepto</th><th>Casilla</th><th className="r">Importe</th></tr></thead>
            <tbody>
              {nz(interest) && <Row box="0027" label={nz(rcm.staking) ? 'Intereses y staking' : 'Intereses'} value={interest} />}
              {nz(dividends) && <Row box="0029" label="Dividendos" value={dividends} />}
              {nz(rcm.bonds) && <Row box="0031" label="Renta fija" value={rcm.bonds} />}
              {nz(rcm.custody) && <Row box="0037" label="Gastos de custodia" value={rcm.custody} />}
              {nz(rcm.grossTotal) && <Row box="0038" label="Rendimiento neto del capital mobiliario" value={rcm.net} />}
              {nz(rcm.spanishTax) && <Row box="0597" label="Retenciones en España" value={rcm.spanishTax} />}
              {rep.sections.map((s) => (
                <Fragment key={s.id}>
                  {nz(s.gainTotal) && <Row box={s.boxes.sumGain} label={`${s.title}: ganancias`} value={s.gainTotal} />}
                  {nz(s.lossComputableTotal) && <Row box={s.boxes.sumLoss} label={`${s.title}: pérdidas que cuentan`} value={s.lossComputableTotal} />}
                  {!D(s.lossTotal).eq(D(s.lossComputableTotal)) && <Row label={`${s.title}: pérdidas obtenidas, antes de aplazar`} value={s.lossTotal} />}
                </Fragment>
              ))}
              {D(rep.rewards).gt(0) && <Row box="0304" label="Airdrops y recompensas, base general" value={rep.rewards} />}
              {nz(rep.doubleTaxDeduction) && <Row box="0588" label="Deducción por doble imposición internacional" value={rep.doubleTaxDeduction} />}
            </tbody>
          </table>
          <table className="mini-table dossier-boxes" style={{ marginTop: 14 }}>
            <tbody>
              <Row label="Saldo de transmisiones" value={rep.savings.gppBalance} />
              <Row label="Saldo de capital mobiliario" value={rep.savings.rcmBalance} />
              {rep.savings.steps.map((st) => <Row key={st.label} label={st.label} value={st.amount} />)}
              <Row label="Base del ahorro, estimada" value={rep.savings.base} />
              <Row label="Cuota del ahorro, estimada" value={rep.savings.tax} />
              <Row label="A pagar tras la deducción y las retenciones, estimado" value={rep.savings.taxAfterCredits} />
            </tbody>
          </table>
          {rep.savings.carryForward.length > 0 && (
            <p className="small" style={{ marginTop: 10 }}>
              Pérdidas para años siguientes: {rep.savings.carryForward.map((c) => `${eur(c.amount)} de ${c.year} (${c.bucket === 'gpp' ? 'transmisiones' : 'capital'}), hasta ${c.expires}`).join(' · ')}.
            </p>
          )}
        </section>

        {data.notes.length > 0 && (
          <section className="card">
            <h2>Criterios y ajustes</h2>
            <ul className="dossier-notes">
              {data.notes.map((n, i) => <li key={i}>{n.date && <span className="faint">{dateShort(n.date)} · </span>}{n.text}</li>)}
            </ul>
          </section>
        )}

        {data.assets.length > 0 && (
          <section className="card flush">
            <div className="card-title"><h2>Ventas por activo</h2></div>
            {data.assets.map((a) => (
              <div className="dossier-asset dossier-scroll" key={a.assetId}>
                <table className="mini-table dossier-sales">
                  <colgroup><col style={{ width: '27%' }} /><col style={{ width: '15%' }} /><col style={{ width: '14%' }} /><col /><col /><col /></colgroup>
                  {/* En papel, el nombre del activo se repite en cada página y nunca queda separado de sus ventas. */}
                  <thead>
                    <tr className="asset-row">
                      <th colSpan={6}>
                        <div className="dossier-asset-head">
                          <div className="main-col">
                            <div className="name">{niceName(a.assetName)}</div>
                            <div className="small muted">{[isinOf(a.assetId), a.section].filter(Boolean).join(' · ')}</div>
                          </div>
                          <div className="end small">
                            <div>Vendido por {eur(a.proceedsEur)} · costó {eur(a.costEur)}</div>
                            <div className="name">{signed(a.gainEur)}</div>
                          </div>
                        </div>
                      </th>
                    </tr>
                    <tr><th>Fecha</th><th>Dónde</th><th className="r">Cantidad</th><th className="r">Vendido por</th><th className="r">Costó</th><th className="r">Resultado</th></tr>
                  </thead>
                  <tbody>
                    {a.sales.map((s, i) => (
                      <Fragment key={i}>
                        <tr className="sale">
                          <td>Venta {dateShort(s.date)}{s.edited && <span className="tag">Corregida</span>}</td>
                          <td>{place(s.broker)}</td>
                          <td className="r">{qty(s.quantity)}</td>
                          <td className="r">{eur(s.proceedsEur)}</td>
                          <td className="r">{eur(s.costEur)}</td>
                          <td className="r">{signed(s.gainEur)}</td>
                        </tr>
                        {s.lots.map((l, j) => (
                          <tr className="lot" key={j}>
                            <td>Compra {l.flag === 'falta' ? '—' : dateShort(l.date)}{l.flag && <span className="tag warn">{FLAG[l.flag]}</span>}{l.edited && <span className="tag">Corregida</span>}</td>
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
                </table>
              </div>
            ))}
          </section>
        )}

        {deferred.length > 0 && (
          <section className="card">
            <h2>Pérdidas aplazadas por recompra</h2>
            <p className="small muted">Ventas con pérdida en las que compraste el mismo valor en los dos meses anteriores o posteriores: la pérdida cuenta cuando vendes lo recomprado. Solo aparecen las que cambian de año; si vuelve a contar dentro de {year}, no cambia nada.</p>
            <table className="mini-table">
              <thead><tr><th>Activo</th><th>Venta</th><th className="r">Pérdida</th><th className="gap">Situación</th></tr></thead>
              <tbody>
                {deferred.map((t) => (
                  <tr key={`${t.assetId}|${t.saleDate}|${t.status}|${t.year}`}>
                    <td>{niceName(t.assetName)}</td>
                    <td>{dateShort(t.saleDate)}</td>
                    <td className="r">{eur(t.amountEur)}</td>
                    <td className="gap">{fromYear(t) < year ? `De ${fromYear(t)}, cuenta en ${year}` : t.status === 'integrated' ? `Pasa a ${t.year}` : t.status === 'blocked' ? 'Sigue aplazada' : `Cuenta si no recompras hasta el ${dateShort(t.windowEnd)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small" style={{ marginTop: 10 }}>
              {[deferredOut.gt(0) && `De ${year} se aplazan ${eur(deferredOut.toFixed(2))}`, deferredIn.gt(0) && `de años anteriores cuentan este año ${eur(deferredIn.toFixed(2))}`].filter(Boolean).join('; ').replace(/^./, (c) => c.toUpperCase())}.
            </p>
          </section>
        )}

        {data.incomes.length > 0 && (
          <section className="card">
            <h2>Dividendos, intereses y recompensas</h2>
            <div className="dossier-scroll">
              <table className="mini-table">
                <thead><tr><th>Activo</th><th>Tipo</th><th>Dónde</th><th className="r">Cobros</th><th className="r">Bruto</th><th className="r">Retenido fuera</th><th className="r">Retenido en España</th></tr></thead>
                <tbody>
                  {data.incomes.map((i) => (
                    <tr key={`${i.assetId}|${i.type}`}>
                      <td>{niceName(i.assetName)}{i.country && <span className="faint small"> · {i.country}</span>}</td>
                      <td>{INCOME[i.type]}</td>
                      <td>{i.brokers.map(place).join(', ')}</td>
                      <td className="r">{i.count}</td>
                      <td className="r">{eur(i.grossEur)}</td>
                      <td className="r">{eur(i.foreignTaxEur)}</td>
                      <td className="r">{eur(i.spanishTaxEur)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4}>Total</td>
                    <td className="r">{eur(incomeTotal('grossEur'))}</td>
                    <td className="r">{eur(incomeTotal('foreignTaxEur'))}</td>
                    <td className="r">{eur(incomeTotal('spanishTaxEur'))}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {rep.doubleTax.length > 0 && (
              <table className="mini-table" style={{ marginTop: 14 }}>
                <thead><tr><th>País</th><th className="r">Bruto</th><th className="r">Retenido</th><th className="r">Convenio</th><th className="r">Deducible</th></tr></thead>
                <tbody>
                  {rep.doubleTax.map((d) => (
                    <tr key={d.country}><td>{d.country}</td><td className="r">{eur(d.gross)}</td><td className="r">{eur(d.withheld)}</td><td className="r">{d.treatyRate} %</td><td className="r">{eur(d.deductible)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        {filedForms.length > 0 && (
          <section className="card">
            <h2>Modelos 720 y 721</h2>
            <table className="mini-table">
              <thead><tr><th>Modelo</th><th className="r">Valor a 31/12</th><th className="r">Costó</th><th>Situación</th></tr></thead>
              <tbody>
                {filedForms.map((f) => (
                  <tr key={f.form}>
                    <td>{f.form}</td>
                    <td className="r">{eur(f.valueEur)}</td>
                    <td className="r">{eur(f.costEur)}</td>
                    <td>{f.filed ? `Presentado por ${eur(f.filed.valueEur)}` : f.required ? 'Hay que presentarlo' : 'No hace falta'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.foreign.forms.some((f) => nz(f.outside.valueEur)) && (
              <p className="small muted" style={{ marginTop: 10 }}>
                Fuera de los brókers había {eur(data.foreign.forms.find((f) => nz(f.outside.valueEur))!.outside.valueEur)} en criptomonedas: no se declaran si estaban en una cartera propia.
              </p>
            )}
          </section>
        )}
      </article>
    </>
  );
}
