import { AlertCircle, Check, ChevronRight, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { FormEntry, FormSection, YearReport } from '../../../server/engine/report.ts';
import { D } from '../../../shared/decimal.ts';
import { BlockingBuys, groupLosses } from '../components/DeferredLoss.tsx';
import { Callout, CopyValue, Disclosure, Empty, Help, Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, isinOf, niceName, qty, signClass, signed } from '../format.ts';
import { useApi } from '../hooks.ts';

const nz = (v: string | null | undefined) => !D(v).isZero();

function BoxRow({ box, label, value, text }: { box?: string; label: ReactNode; value: string; text?: boolean }) {
  return (
    <div className="box-row">
      {box && <span className="box-no" title="Casilla">{box}</span>}
      <span className="lbl">{label}</span>
      <CopyValue value={value} text={text} display={text ? value : undefined} />
    </div>
  );
}

function Acc({ title, hint, right, done, open, onToggle, children }: { title: string; hint?: string; right?: ReactNode; done?: boolean; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <div className="acc">
      <button className="acc-head" aria-expanded={open} onClick={onToggle}>
        <div className={`avatar ${done ? 'gain' : ''}`} style={{ width: 28, height: 28 }}>{done ? <Check size={15} strokeWidth={3} /> : <ChevronRight size={15} className={`chevron ${open ? 'open' : ''}`} />}</div>
        <div className="main-col">
          <div className="t">{title}</div>
          {hint && <div className="s">{hint}</div>}
        </div>
        {right}
      </button>
      <div className="acc-body" hidden={!open}>{children}</div>
    </div>
  );
}

function Entry({ id, title, box, doneSet, toggle, children }: { id: string; title: ReactNode; box?: string; doneSet: Set<string>; toggle: (id: string) => void; children: ReactNode }) {
  const done = doneSet.has(id);
  return (
    <div className={`entry ${done ? 'done' : ''}`}>
      <div className="entry-head">
        <button className={`tick ${done ? 'on' : ''}`} role="checkbox" aria-checked={done} aria-label="Marcar como copiado" title="Marcar como copiado" onClick={() => toggle(id)}><Check size={14} strokeWidth={3} /></button>
        <div className="name">{title}{box && <span className="box-no" title="Casilla">{box}</span>}</div>
      </div>
      {children}
    </div>
  );
}

const SECTION_COPY: Record<FormSection['id'], { title: string; hint: string; unit: [string, string] }> = {
  stock: { title: 'Acciones', hint: 'Apartado F2 · una entrada por empresa', unit: ['empresa', 'empresas'] },
  etf: { title: 'ETF', hint: 'Apartado F2 · una entrada por ETF', unit: ['ETF', 'ETF'] },
  crypto: { title: 'Criptomonedas', hint: 'Apartado F2 · una entrada por moneda', unit: ['moneda', 'monedas'] },
  fx: { title: 'Cambios de moneda', hint: 'Apartado F2 · otros elementos, clave 4', unit: ['moneda', 'monedas'] },
  other: { title: 'Otros valores', hint: 'Apartado F2 · otros elementos', unit: ['valor', 'valores'] },
};

function SectionEntries({ s, doneSet, toggle }: { s: FormSection; doneSet: Set<string>; toggle: (id: string) => void }) {
  const b = s.boxes;
  const withResultBoxes = s.id === 'stock' || s.id === 'etf' || s.id === 'crypto';
  return (
    <>
      {s.entries.map((e: FormEntry, i: number) => {
        const id = `${s.id}|${e.assetId}|${i}`;
        const name = niceName(e.name);
        const net = D(e.gain).minus(D(e.lossObtained)).toFixed(2);
        const onlyLoss = !nz(e.transmission) && !nz(e.acquisition);
        return (
          <Entry key={id} id={id} doneSet={doneSet} toggle={toggle} box={b.name} title={<CopyValue value={name} display={name} text />}>
            {s.id === 'crypto' && e.clave && (
              <BoxRow box={b.clave} label={<span className="inline">Tipo de cambio <Help text="F: la vendiste por dinero. N: la cambiaste por otra criptomoneda." /></span>} value={e.clave} text />
            )}
            {!onlyLoss && <BoxRow box={b.transmission} label="Vendido por" value={e.transmission} />}
            {!onlyLoss && <BoxRow box={b.acquisition} label="Te costó" value={e.acquisition} />}
            {withResultBoxes && nz(e.gain) && <BoxRow box={b.gain} label="Ganancia" value={e.gain} />}
            {withResultBoxes && nz(e.lossObtained) && <BoxRow box={b.lossObtained} label="Pérdida" value={e.lossObtained} />}
            {withResultBoxes && (nz(e.lossObtained) || onlyLoss) && <BoxRow box={b.lossComputable} label={<span className="inline">Pérdida que cuenta {e.note && !onlyLoss && <Help text={HELP.aplazada} />}</span>} value={e.lossComputable} />}
            {!withResultBoxes && <div className="box-row"><span className="lbl">Resultado</span><span className={`num strong ${signClass(net)}`}>{signed(net)}</span></div>}
            {e.note && <div className="small warn-text" style={{ marginTop: 4 }}>{e.note}</div>}
          </Entry>
        );
      })}
      {s.id === 'fx' && <p className="small muted">Las fechas que pide Renta Web están en el Excel, en «Transmisiones FIFO».</p>}
    </>
  );
}

const doneKey = (year: number, profileId: string) => profileId === 'default' ? `renta-hecho-${year}` : `renta-hecho-${profileId}-${year}`;
const loadDone = (year: number, profileId: string): Set<string> => {
  try {
    return new Set(JSON.parse(localStorage.getItem(doneKey(year, profileId)) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
};

export function Renta() {
  const { year, tick, go, state: { profileId } } = useApp();
  const { data: rep } = useApi<YearReport>(`/report/${year}`, `${year}-${tick}`);
  // undefined: se abre solo lo siguiente por copiar. null: el usuario lo ha cerrado todo.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [doneSet, setDoneSet] = useState<Set<string>>(() => loadDone(year, profileId));
  useEffect(() => { setDoneSet(loadDone(year, profileId)); setPicked(undefined); }, [year, profileId]);

  const toggle = (id: string) => {
    setDoneSet((old) => {
      const n = new Set(old);
      if (n.has(id)) n.delete(id); else n.add(id);
      try { localStorage.setItem(doneKey(year, profileId), JSON.stringify([...n])); } catch { /* sin almacenamiento, solo dura esta visita */ }
      return n;
    });
  };
  if (!rep) return <><PageHead title={`Mi Renta ${year}`} /><Loading /></>;

  const rcm = rep.rcm;
  const interestTotal = D(rcm.interest).plus(D(rcm.staking)).toFixed(2);
  const dividendTotal = D(rcm.dividends).plus(D(rcm.capitalExcess)).toFixed(2);
  const hasRcm = nz(rcm.grossTotal) || nz(rcm.custody);
  const hasRewards = D(rep.rewards).gt(0);
  const hasDouble = rep.doubleTax.length > 0;
  const nothing = !hasRcm && rep.sections.length === 0 && !hasRewards;

  const allIds = [
    ...(hasRcm ? ['rcm'] : []),
    ...rep.sections.flatMap((s) => s.entries.map((e, i) => `${s.id}|${e.assetId}|${i}`)),
    ...(hasRewards ? ['rewards'] : []),
    ...(hasDouble ? ['double'] : []),
  ];
  const doneCount = allIds.filter((id) => doneSet.has(id)).length;
  const errors = rep.issues.filter((i) => i.severity === 'error').length;
  const sectionDone = (s: FormSection) => s.entries.every((e, i) => doneSet.has(`${s.id}|${e.assetId}|${i}`));
  const firstPending = [
    ...(hasRcm && !doneSet.has('rcm') ? ['rcm'] : []),
    ...rep.sections.filter((s) => !sectionDone(s)).map((s) => s.id as string),
    ...(hasRewards && !doneSet.has('rewards') ? ['rewards'] : []),
    ...(hasDouble && !doneSet.has('double') ? ['double'] : []),
  ][0] ?? null;
  const open = picked === undefined ? firstPending : picked;
  const acc = (id: string) => ({ open: open === id, onToggle: () => setPicked(open === id ? null : id) });

  return (
    <>
      <PageHead title={`Mi Renta ${year}`} sub={`Se presenta en ${year + 1}.`} year>
        <a className="btn" href={`/api/export/${year}?profile=${encodeURIComponent(profileId)}`}><FileSpreadsheet size={16} /> Excel</a>
        <button className="btn icon" onClick={() => window.print()} aria-label="Imprimir o guardar en PDF" title="Imprimir o guardar en PDF"><Printer size={16} /></button>
      </PageHead>

      {errors > 0 && (
        <Callout tone="error" icon={AlertCircle} title="Aún no copies estos datos" action={<button className="btn small" onClick={() => go('review')}>Revisar</button>}>
          {errors === 1 ? 'Falta 1 cosa por resolver y las cifras pueden cambiar.' : `Faltan ${errors} cosas por resolver y las cifras pueden cambiar.`}
        </Callout>
      )}

      {nothing ? (
        <div className="card"><Empty icon={FileText} title={`Nada que declarar en ${year}`}>No hay ventas, dividendos ni intereses este año.</Empty></div>
      ) : (
        <>
          <div className="stat-grid">
            <div className="stat-card">
              <div className="l">A pagar, aproximado <Help text={HELP.apagar} /></div>
              <div className="v">{eur(rep.savings.taxAfterCredits)}</div>
            </div>
            <div className="stat-card">
              <div className="l">Copiado a Renta Web</div>
              <div className="v">{doneCount} de {allIds.length}</div>
              <div className="progress no-print" style={{ marginTop: 8 }}><div style={{ transform: `scaleX(${allIds.length ? doneCount / allIds.length : 0})` }} /></div>
            </div>
          </div>

          <div className="stack" style={{ gap: 10 }}>
            {hasRcm && (
              <Acc title="Dividendos e intereses" hint="Apartado B" done={doneSet.has('rcm')} right={<span className="num strong">{eur(rcm.net)}</span>} {...acc('rcm')}>
                <Entry id="rcm" title="Capital mobiliario" doneSet={doneSet} toggle={toggle}>
                  {nz(interestTotal) && <BoxRow box="0027" label={nz(rcm.staking) ? 'Intereses y staking' : 'Intereses'} value={interestTotal} />}
                  {nz(dividendTotal) && <BoxRow box="0029" label="Dividendos" value={dividendTotal} />}
                  {nz(rcm.bonds) && <BoxRow box="0031" label="Renta fija" value={rcm.bonds} />}
                  {nz(rcm.custody) && <BoxRow box="0037" label="Gastos de custodia" value={rcm.custody} />}
                  {nz(rcm.spanishTax) && <BoxRow box="0597" label={<span className="inline">Retenciones en España <Help text={HELP.retencion} /></span>} value={rcm.spanishTax} />}
                </Entry>
              </Acc>
            )}

            {rep.sections.map((s) => {
              const c = SECTION_COPY[s.id];
              const n = new Set(s.entries.map((e) => e.assetId)).size;
              const net = D(s.gainTotal).minus(D(s.lossComputableTotal)).toFixed(2);
              return (
                <Acc key={s.id} title={c.title} hint={`${c.hint} · ${n} ${n === 1 ? c.unit[0] : c.unit[1]}`} done={sectionDone(s)} right={<span className={`num strong ${signClass(net)}`}>{signed(net)}</span>} {...acc(s.id)}>
                  <SectionEntries s={s} doneSet={doneSet} toggle={toggle} />
                </Acc>
              );
            })}

            {hasRewards && (
              <Acc title="Regalos y airdrops" hint="Apartado F1" done={doneSet.has('rewards')} right={<span className="num strong">{eur(rep.rewards)}</span>} {...acc('rewards')}>
                <Entry id="rewards" title="Otras ganancias" doneSet={doneSet} toggle={toggle}>
                  <BoxRow box="0304" label="Importe" value={rep.rewards} />
                </Entry>
              </Acc>
            )}

            {hasDouble && (
              <Acc title="Lo que te retuvieron fuera" hint="Te lo descuentas de lo que pagas" done={doneSet.has('double')} right={<span className="num strong">{eur(rep.doubleTaxDeduction)}</span>} {...acc('double')}>
                <Entry id="double" title={<span className="inline">Doble imposición <Help text={HELP.dobleImposicion} /></span>} doneSet={doneSet} toggle={toggle}>
                  <BoxRow box="0588" label="Deducción" value={rep.doubleTaxDeduction} />
                </Entry>
                <table className="mini-table">
                  <thead><tr><th>País</th><th className="r">Retenido</th><th className="r">Se descuenta</th></tr></thead>
                  <tbody>
                    {rep.doubleTax.map((x) => (
                      <tr key={x.country}>
                        <td>{x.country}</td><td className="r">{eur(x.withheld)}</td><td className="r">{eur(x.deductible)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rep.doubleTax.some((x) => nz(x.excess)) && (
                  <p className="small muted inline">
                    {eur(rep.doubleTax.reduce((s, x) => s.plus(D(x.excess)), D(0)).toFixed(2))} no se pueden descontar aquí <Help text={HELP.exceso} />
                  </p>
                )}
              </Acc>
            )}
          </div>

          <h2 style={{ marginTop: 8 }}>Para saber más</h2>
          {rep.deferred.tranches.length > 0 && (
            <Disclosure card flush title={<span className="inline">Pérdidas aplazadas <Help text={HELP.aplazada} /></span>} meta={<span className="num strong">{eur(rep.deferred.pendingEnd)}</span>}>
              <div className="list">
                {groupLosses(rep.deferred.tranches).map((g) => (
                  <div className="item" key={g.key}>
                    <div className="main-col">
                      <div className="title">{niceName(g.assetName)}</div>
                      <div className="small muted">Vendido el {dateShort(g.originDate)}{isinOf(g.assetId) ? ` · ${g.assetId}` : ''}</div>
                      {g.status === 'blocked' && <BlockingBuys group={g} />}
                      {g.status === 'integrated' && <div className="small muted">Ya cuenta en {g.year}.</div>}
                      {g.status === 'pending_window' && <div className="small muted">Se aplaza si compras antes del {dateShort(g.windowEnd)}.</div>}
                    </div>
                    <div className="end"><div className="amount">{eur(g.amount.toFixed(2))}</div></div>
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
          <Disclosure card title="Cómo se calcula lo que pagas">
            <div className="kv">
              <span>Ventas</span><span className={`num ${signClass(rep.savings.gppBalance)}`}>{signed(rep.savings.gppBalance)}</span>
              <span>Dividendos e intereses</span><span className={`num ${signClass(rep.savings.rcmBalance)}`}>{signed(rep.savings.rcmBalance)}</span>
              {rep.savings.steps.map((st, i) => (
                <span key={i} style={{ display: 'contents' }}><span className="small muted">{st.label}</span><span className="num small">{eur(st.amount)}</span></span>
              ))}
              <span className="total">Base del ahorro</span><span className="num total">{eur(rep.savings.base)}</span>
            </div>
            <table className="mini-table" style={{ marginTop: 14 }}>
              <thead><tr><th>Tramo</th><th className="r">Tipo</th><th className="r">Base</th><th className="r">Impuesto</th></tr></thead>
              <tbody>
                {rep.savings.brackets.filter((b) => Number(b.base) > 0).map((b) => (
                  <tr key={b.from}><td className="muted">{b.to ? `Hasta ${eur(b.to)}` : `Más de ${eur(b.from)}`}</td><td className="r">{b.rate} %</td><td className="r">{eur(b.base)}</td><td className="r">{eur(b.tax)}</td></tr>
                ))}
              </tbody>
            </table>
            <div className="kv" style={{ marginTop: 12 }}>
              <span>Impuesto</span><span className="num">{eur(rep.savings.tax)}</span>
              {nz(rep.doubleTaxDeduction) && <><span className="muted">Retenido fuera</span><span className="num">−{eur(rep.doubleTaxDeduction)}</span></>}
              {nz(rcm.spanishTax) && <><span className="muted">Retenido en España</span><span className="num">−{eur(rcm.spanishTax)}</span></>}
              <span className="total">A pagar, aproximado</span><span className="num total">{eur(rep.savings.taxAfterCredits)}</span>
            </div>
            {rep.savings.carryForward.length > 0 && (
              <p className="small muted" style={{ marginTop: 12 }}>
                Pérdidas para otros años: {rep.savings.carryForward.map((c) => `${eur(c.amount)} de ${c.year}, hasta ${c.expires}`).join(' · ')}.
              </p>
            )}
            <p className="small faint" style={{ marginTop: 12 }}>Escala general. Navarra y País Vasco tienen la suya.</p>
          </Disclosure>
        </>
      )}

      {rep.yearEnd.length > 0 && <YearEnd rep={rep} year={year} />}
    </>
  );
}

function YearEnd({ rep, year }: { rep: YearReport; year: number }) {
  // Solo cuenta la parte depositada en esos brókers: un resto en el exchange no arrastra
  // lo que está en una cartera propia, que no va al 721.
  const cost = (brokers: string[], classes: string[]) => rep.yearEnd
    .filter((p) => classes.includes(p.class) && D(p.quantity).gt(0))
    .reduce((s, p) => {
      const there = Object.entries(p.byBroker).filter(([b, q]) => brokers.includes(b) && D(q).gt(0)).reduce((t, [, q]) => t.plus(D(q)), D(0));
      return s.plus(D(p.costEur).times(there.gt(p.quantity) ? 1 : there.div(D(p.quantity))));
    }, D(0));
  const secCost = cost(['degiro', 'trade_republic', 'revolut'], ['stock', 'etf', 'fund', 'bond']);
  const cryptoCost = cost(['kraken', 'trade_republic', 'revolut', 'coinbase'], ['crypto']);
  const high = secCost.gt(50000) || cryptoCost.gt(50000);
  const forms = [secCost.gt(50000) && '720', cryptoCost.gt(50000) && '721'].filter(Boolean).join(' y ');
  return (
    <Disclosure card flush title={<span className="inline">Lo que tenías el 31 de diciembre de {year} <Help text={HELP.posicion} /></span>} meta={high ? <span className="tag warn">Revisa {forms}</span> : undefined}>
      {high && <div style={{ padding: '0 22px 12px' }}><Callout tone="warn">Te costó más de 50.000 € en el extranjero. Comprueba si debes presentar el modelo {forms}.</Callout></div>}
      <div className="list">
        {rep.yearEnd.map((p) => (
          <div className="item" key={p.assetId}>
            <div className="main-col"><div className="title">{niceName(p.assetName)}</div></div>
            <div className="end">
              <div className="amount">{qty(p.quantity)}</div>
              <div className="sub">costó {eur(p.costEur)}</div>
            </div>
          </div>
        ))}
      </div>
    </Disclosure>
  );
}
