import { AlertCircle, Check, ChevronRight, FileSpreadsheet, FileText, Printer } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { FormEntry, FormSection, YearReport } from '../../../server/engine/report.ts';
import { D } from '../../../shared/decimal.ts';
import { BlockingBuys, groupLosses } from '../components/DeferredLoss.tsx';
import { BROKER_LABEL, type Broker, type ForeignFiling, type ForeignForm, type ForeignFormReport, type ForeignReport } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Callout, CopyValue, Disclosure, Empty, Help, Loading, NumField, PageHead } from '../components/ui.tsx';
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
        <button className="btn" onClick={() => go('dossier')}><FileText size={16} /> Dossier</button>
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

      <Foreign year={year} />
      {rep.yearEnd.length > 0 && <YearEnd rep={rep} year={year} />}
    </>
  );
}

function YearEnd({ rep, year }: { rep: YearReport; year: number }) {
  return (
    <Disclosure card flush title={<span className="inline">Lo que tenías el 31 de diciembre de {year} <Help text={HELP.posicion} /></span>}>
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

const FORM_COPY: Record<ForeignForm, { title: string; what: string }> = {
  '720': { title: 'Modelo 720', what: 'Acciones, ETF y fondos en brókers extranjeros' },
  '721': { title: 'Modelo 721', what: 'Criptomonedas en exchanges extranjeros' },
};
const PLACE = (b: string) => BROKER_LABEL[b as Broker] ?? 'Fuera de los brókers';

function Foreign({ year }: { year: number }) {
  const { tick, changed, state: { settings } } = useApp();
  const { data } = useApi<ForeignReport>(`/foreign/${year}`, `${year}-${tick}`);
  if (!data) return null;
  const shown = data.forms.filter((f) => D(f.valueEur).gt(0) || D(f.outside.valueEur).gt(0) || f.closures.length > 0 || f.lastFiled || f.filed);
  if (shown.length === 0) return null;
  const filings = settings.foreignFilings ?? [];
  const save = async (list: ForeignFiling[]) => {
    await api('/settings', { method: 'PUT', body: { foreignFilings: list } });
    changed('Guardado');
  };
  return (
    <div className="card foreign">
      <h2 className="inline">Modelos 720 y 721 <Help text={HELP.extranjero} /></h2>
      <p className="small muted">Cuenta el valor a 31 de diciembre, no lo que te costó. Solo los presentan los residentes fiscales en España, del 1 de enero al 31 de marzo de {year + 1}.</p>
      {data.estimated && <p className="small muted">El año no ha terminado: es una estimación con los precios de hoy.</p>}
      {shown.map((f) => <ForeignRow key={f.form} f={f} year={year} estimated={data.estimated} filings={filings} save={save} />)}
    </div>
  );
}

function ForeignRow({ f, year, estimated, filings, save }: { f: ForeignFormReport; year: number; estimated: boolean; filings: ForeignFiling[]; save: (list: ForeignFiling[]) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const copy = FORM_COPY[f.form];
  const unpriced = f.holdings.filter((h) => h.priced === 'cost');
  const status = f.filed ? <span className="tag gain">Presentado</span>
    : f.required ? <span className="tag warn">{estimated ? 'Si sigue así, toca' : 'Obligatorio'}</span>
      : <span className="tag">{estimated ? 'De momento, no' : 'No hace falta'}</span>;
  const reasons = [
    f.reasons.includes('over50k') && 'Pasa de 50.000 € y no consta que lo hayas presentado antes.',
    f.reasons.includes('increase') && f.lastFiled && `Ha subido ${eur(f.increaseEur)} desde el de ${f.lastFiled.year}: más de 20.000 €.`,
    f.reasons.includes('closures') && `Has cerrado ${f.closures.length === 1 ? 'una posición que declaraste' : `${f.closures.length} posiciones que declaraste`}: también se informa.`,
    !f.required && f.lastFiled && `Desde el de ${f.lastFiled.year} ha cambiado ${signed(f.increaseEur)} y no has cerrado nada declarado.`,
    !f.required && !f.lastFiled && 'No llega a 50.000 €.',
  ].filter(Boolean).join(' ');
  const record = async (value: string | null) => {
    const rest = filings.filter((x) => !(x.form === f.form && x.year === year));
    try {
      await save(value === null ? rest : [...rest, { form: f.form, year, valueEur: D(value).toFixed(2) }]);
      setEditing(null);
      setError('');
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <div className="foreign-form">
      <div className="foreign-head">
        <div className="main-col">
          <div className="title">{copy.title} {status}</div>
          <div className="sub">{copy.what}</div>
        </div>
        <div className="end">
          <div className="amount">{eur(f.valueEur)}</div>
          <div className="sub">costó {eur(f.costEur)}</div>
        </div>
      </div>
      <p className="small">{reasons}</p>
      {unpriced.length > 0 && <p className="small muted">Sin precio a 31 de diciembre para {unpriced.map((h) => niceName(h.assetName)).join(', ')}: se cuenta lo que costó.</p>}
      {D(f.outside.valueEur).gt(0) && (
        <Callout tone="info">
          Además tenías {eur(f.outside.valueEur)} en criptomonedas fuera de los brókers. Si estaban en una cartera tuya, no se declaran; si estaban en otro exchange extranjero, súmalas.
        </Callout>
      )}
      {(f.holdings.length > 0 || f.closures.length > 0 || f.outside.holdings.length > 0) && (
        <Disclosure flush title={`Detalle · ${[...f.holdings, ...f.outside.holdings].length} posiciones${f.closures.length ? ` · ${f.closures.length} cerradas` : ''}`}>
          <table className="mini-table">
            <thead><tr><th>Activo</th><th className="wide-only">Dónde</th><th className="r">Cantidad</th><th className="r">Valor</th></tr></thead>
            <tbody>
              {[...f.holdings, ...f.outside.holdings].map((h) => (
                <tr key={`${h.broker}|${h.assetId}`}>
                  <td>{niceName(h.assetName)}{isinOf(h.assetId) && <span className="faint small"> · {h.assetId}</span>}<div className="faint small narrow-only">{PLACE(h.broker)}</div></td>
                  <td className="wide-only">{PLACE(h.broker)}</td>
                  <td className="r">{qty(h.quantity)}</td>
                  <td className="r">{eur(h.valueEur)}{h.priced === 'cost' && <div className="faint small">coste</div>}</td>
                </tr>
              ))}
              {f.closures.map((c) => (
                <tr key={`cerrada|${c.broker}|${c.assetId}`}>
                  <td>{niceName(c.assetName)} <span className="tag">Cerrada en {year}</span></td>
                  <td className="wide-only">{PLACE(c.broker)}</td>
                  <td className="r">{qty(c.quantity)}</td>
                  <td className="r">—</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Disclosure>
      )}
      {!estimated && (
        <div className="foreign-filed">
          {f.filed && editing === null && (
            <>
              <span className="small muted">Anotado como presentado por {eur(f.filed.valueEur)}.</span>
              <button className="btn small" onClick={() => setEditing(f.filed!.valueEur)}>Cambiar</button>
              <button className="btn small" onClick={() => void record(null)}>Quitar</button>
            </>
          )}
          {!f.filed && editing === null && (
            <button className="btn small" onClick={() => setEditing(f.valueEur)}>Lo presenté</button>
          )}
          {editing !== null && (
            <>
              <NumField label="Valor que declaraste" value={editing} onChange={setEditing} />
              <button className="btn small primary" disabled={!editing || D(editing).lt(0)} onClick={() => void record(editing)}>Guardar</button>
              <button className="btn small" onClick={() => setEditing(null)}>Cancelar</button>
            </>
          )}
          {error && <span className="small loss">{error}</span>}
        </div>
      )}
    </div>
  );
}
