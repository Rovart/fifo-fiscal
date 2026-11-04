import { AlertCircle, ArrowRight, CheckCircle2, CircleDashed, FileClock, ShieldCheck, Upload as UploadIcon } from 'lucide-react';
import type { FormSection, YearReport } from '../../../server/engine/report.ts';
import { D, Decimal } from '../../../shared/decimal.ts';
import { BROKER_LABEL, CLASS_LABEL, type AssetClass, type BrokerFreshness, type YearEndReview } from '../../../shared/types.ts';
import { Callout, Help, Loading, YearPicker } from '../components/ui.tsx';
import { DivergingBars } from '../components/charts.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, niceName, signClass, signed } from '../format.ts';
import { useApi } from '../hooks.ts';

function Welcome() {
  const { go } = useApp();
  return (
    <>
      <div className="welcome">
        <h1>Lo que debes declarar de tus inversiones, sin complicaciones</h1>
        <p>Sube los extractos de tus brókers. Nosotros hacemos los cálculos.</p>
        <button className="btn primary" onClick={() => go('upload')}><UploadIcon size={16} /> Subir mis extractos</button>
      </div>
      <div className="steps">
        {[
          ['Sube tus extractos', 'Se descargan en un minuto desde cada bróker.'],
          ['Revisa lo que falte', 'Te decimos qué comprobar, una cosa cada vez.'],
          ['Copia en Renta Web', 'Cada importe, con su casilla, a un clic.'],
        ].map(([t, d], i) => (
          <div className="step" key={t}>
            <span className="step-dot">{i + 1}</span>
            <div className="t">{t}</div>
            <div className="d">{d}</div>
          </div>
        ))}
      </div>
      <div className="inline small faint" style={{ justifyContent: 'center' }}><ShieldCheck size={15} /> Tus datos no salen de este ordenador.</div>
    </>
  );
}

function NextStep() {
  const { state, go, year } = useApp();
  const { errors, warnings } = state.counts.byYear[year] ?? { errors: 0, warnings: 0 };
  if (errors > 0) {
    return (
      <div className="card next">
        <div className="avatar loss"><AlertCircle size={18} /></div>
        <div className="body">
          <div className="t">{errors === 1 ? 'Falta 1 cosa por resolver' : `Faltan ${errors} cosas por resolver`}</div>
          <div className="small muted">Hasta entonces, estas cifras pueden cambiar.</div>
        </div>
        <button className="btn primary" onClick={() => go('review')}>Resolver <ArrowRight size={16} /></button>
      </div>
    );
  }
  if (warnings > 0) {
    return (
      <div className="card next">
        <div className="avatar warn"><CircleDashed size={18} /></div>
        <div className="body">
          <div className="t">{warnings === 1 ? 'Queda 1 cosa por comprobar' : `Quedan ${warnings} cosas por comprobar`}</div>
          <div className="small muted">Solo tienes que confirmar que están bien.</div>
        </div>
        <button className="btn primary" onClick={() => go('review')}>Comprobar <ArrowRight size={16} /></button>
      </div>
    );
  }
  return (
    <div className="card next">
      <div className="avatar gain"><CheckCircle2 size={18} /></div>
      <div className="body">
        <div className="t">Todo en orden</div>
        <div className="small muted">Ya puedes pasar los datos de {year} a Renta Web.</div>
      </div>
      <button className="btn primary" onClick={() => go('renta')}>Ir a Mi Renta <ArrowRight size={16} /></button>
    </div>
  );
}

const daysAgo = (date: string, today: string) => Math.round((Date.parse(today) - Date.parse(date)) / 86400000);

/** Hasta cuándo llegan los datos de cada bróker en el año en curso. */
function Freshness({ items }: { items: BrokerFreshness[] }) {
  const { state, go } = useApp();
  return (
    <div className="card flush">
      <div className="card-title row-between">
        <h2>Tus extractos</h2>
        <button className="btn small" onClick={() => go('upload')}><UploadIcon size={14} /> Subir</button>
      </div>
      <div className="list">
        {items.map((i) => (
          <div className="item" key={i.broker}>
            <div className="main-col">
              <div className="title">{BROKER_LABEL[i.broker]}</div>
              <div className="sub">Último movimiento: {dateShort(i.lastOpAt.slice(0, 10))}</div>
            </div>
            <div className="end">
              {i.stale ? <span className="tag warn">Hace {daysAgo(i.upTo, state.today)} días</span> : <div className="small muted">Al día hasta el {dateShort(i.upTo)}</div>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StaleWarning({ items }: { items: BrokerFreshness[] }) {
  const { go, year } = useApp();
  const stale = items.filter((i) => i.stale);
  if (stale.length === 0) return null;
  const names = stale.map((i) => BROKER_LABEL[i.broker]);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
  return (
    <Callout tone="warn" icon={FileClock} title={`${list}: datos de hace más de un mes`} action={<button className="btn small" onClick={() => go('upload')}>Subir</button>}>
      Sube {stale.length === 1 ? 'un extracto nuevo' : 'extractos nuevos'} para que {year} esté completo.
    </Callout>
  );
}

const TOP_LOSSES = 5;

/** Del 1 de octubre al 31 de diciembre: pérdidas sin realizar que compensarían lo ganado este año. */
function YearEndCard() {
  const { tick, go, state } = useApp();
  const { data } = useApi<YearEndReview>('/year-end', `${tick}`);
  if (!data || D(data.gppBalanceEur).lte(0) || data.losses.length === 0) return null;
  const left = daysAgo(state.today, `${data.year}-12-31`);
  const shown = data.losses.slice(0, TOP_LOSSES);
  return (
    <div className="card flush">
      <div className="card-title" style={{ display: 'block' }}>
        <h2>Antes del 31 de diciembre</h2>
        <div className="small muted" style={{ marginTop: 2 }}>{left === 0 ? 'Hoy es el último día' : `Quedan ${left} días`} para que una venta cuente en la Renta de {data.year}.</div>
      </div>
      <div className="stats">
        <div className="stat"><div className="l">Ganado con ventas</div><div className="v gain">{signed(data.gppBalanceEur)}</div></div>
        <div className="stat"><div className="l">Pérdidas sin vender</div><div className="v loss">{eur(D(data.latentLossEur).abs().toFixed(2))}</div></div>
        {D(data.savingEur).gt(0) && <div className="stat"><div className="l inline">Ahorro posible en la cuota <Help text={HELP.cierre} /></div><div className="v">{eur(data.savingEur)}</div></div>}
      </div>
      <div className="list">
        {shown.map((l) => (
          <div className="item" key={l.assetId}>
            <div className="main-col">
              <div className="title">{niceName(l.assetName)}</div>
              <div className="sub">{CLASS_LABEL[l.class as AssetClass] ?? l.class} · vale {eur(l.valueEur)}, costó {eur(l.costEur)}</div>
            </div>
            <div className="end">
              <div className="amount loss">{signed(l.latentEur)}</div>
              {l.recentBuy && <span className="tag warn">Se aplazaría</span>}
            </div>
          </div>
        ))}
      </div>
      <div className="card-foot">
        <p className="small muted">
          {data.losses.length > TOP_LOSSES ? `Y ${data.losses.length - TOP_LOSSES} más. ` : ''}En acciones, ETF y fondos, si compras el mismo valor en los dos meses antes o después de vender, la pérdida se aplaza; en criptomonedas no. Precios del {dateShort(data.quotesAt?.slice(0, 10))}.
        </p>
        <button className="btn small" onClick={() => go('whatif')}>Simularlo <ArrowRight size={14} /></button>
      </div>
    </div>
  );
}

const MAX_BARS = 7;

/** Resultado de ventas por activo, con el cero como referencia. El total coincide con «Ventas». */
function WhereBars({ sections }: { sections: FormSection[] }) {
  const byAsset = new Map<string, { name: string; value: Decimal; t: Decimal; a: Decimal }>();
  for (const s of sections) {
    for (const e of s.entries) {
      const cur = byAsset.get(e.assetId) ?? { name: niceName(e.name), value: D(0), t: D(0), a: D(0) };
      cur.value = cur.value.plus(D(e.gain)).minus(D(e.lossComputable));
      cur.t = cur.t.plus(D(e.transmission));
      cur.a = cur.a.plus(D(e.acquisition));
      byAsset.set(e.assetId, cur);
    }
  }
  let rows = [...byAsset.values()].filter((r) => !r.value.isZero()).sort((a, b) => b.value.minus(a.value).toNumber());
  if (rows.length === 0) return null;
  if (rows.length > MAX_BARS) {
    const byMag = [...rows].sort((a, b) => b.value.abs().minus(a.value.abs()).toNumber());
    const keep = byMag.slice(0, MAX_BARS - 1);
    const rest = byMag.slice(MAX_BARS - 1);
    const other = rest.reduce((s, r) => ({ name: `Otros (${rest.length})`, value: s.value.plus(r.value), t: s.t.plus(r.t), a: s.a.plus(r.a) }), { name: '', value: D(0), t: D(0), a: D(0) });
    rows = [...keep.sort((a, b) => b.value.minus(a.value).toNumber()), other];
  }
  return (
    <div className="card flush">
      <div className="card-title"><h2>Dónde has ganado y perdido</h2></div>
      <DivergingBars rows={rows.map((r) => ({ key: r.name, name: r.name, value: r.value.toNumber(), tip: `Vendido por ${eur(r.t.toFixed(2))} · Costó ${eur(r.a.toFixed(2))}` }))} />
    </div>
  );
}

export function Home() {
  const { state, year, tick, go } = useApp();
  const { data: rep } = useApi<YearReport>(state.counts.operations ? `/report/${year}` : null, `${tick}`);
  const current = year === Number(state.today.slice(0, 4));
  const { data: fresh } = useApi<{ items: BrokerFreshness[] }>(state.counts.operations && current ? '/freshness' : null, `${tick}`);
  const closing = current && state.today.slice(5, 7) >= '10';
  if (state.counts.operations === 0) return <Welcome />;
  if (!rep) return <Loading />;
  const sales = rep.savings.gppBalance;
  const income = rep.savings.rcmBalance;
  const total = D(sales).plus(D(income)).toFixed(2);
  const nothing = rep.sections.length === 0 && D(income).isZero();
  return (
    <>
      <div className="page-head">
        <h1>Tu {year}</h1>
        <div className="actions"><YearPicker /></div>
      </div>
      <div className="card flush">
        <div className="hero">
          <div>
            <div className="hero-label">{D(total).lt(0) ? 'Has perdido' : 'Has ganado'} <Help text={HELP.resultado} /></div>
            <div className={`hero-value ${signClass(total)}`}>{eur(D(total).abs().toFixed(2))}</div>
          </div>
          <div className="hero-side">
            <div className="hero-label">A pagar, aproximado <Help text={HELP.apagar} /></div>
            <div className="val">{eur(rep.savings.taxAfterCredits)}</div>
          </div>
        </div>
        <div className="stats">
          <button className="stat" onClick={() => go('results')}>
            <div className="l">Ventas</div>
            <div className={`v ${signClass(sales)}`}>{signed(sales)}</div>
          </button>
          <button className="stat" onClick={() => go('results')}>
            <div className="l">Dividendos e intereses</div>
            <div className={`v ${signClass(income)}`}>{signed(income)}</div>
          </button>
          {D(rep.rewards).gt(0) && (
            <div className="stat">
              <div className="l">Regalos y airdrops</div>
              <div className="v">{signed(rep.rewards)}</div>
            </div>
          )}
        </div>
      </div>
      <NextStep />
      {current && fresh && <StaleWarning items={fresh.items} />}
      {nothing && <Callout tone="info">No hay ventas ni rentas en {year}.</Callout>}
      {closing && <YearEndCard />}
      <WhereBars sections={rep.sections} />
      {D(rep.deferred.pendingEnd).gt(0) && (
        <Callout tone="info" title={<span className="inline">{eur(rep.deferred.pendingEnd)} de pérdidas aplazadas <Help text={HELP.aplazada} /></span>}>
          Cuentan cuando vendas lo que compraste cerca de esas ventas.
        </Callout>
      )}
      {rep.savings.carryForward.length > 0 && (
        <Callout tone="info" title="Pérdidas que puedes usar en otros años">
          {rep.savings.carryForward.map((c) => `${eur(c.amount)} de ${c.year}, hasta ${c.expires}`).join(' · ')}
        </Callout>
      )}
      {current && fresh && fresh.items.length > 0 && <Freshness items={fresh.items} />}
    </>
  );
}
