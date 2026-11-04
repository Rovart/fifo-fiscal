import { RefreshCw, TrendingUp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { D, ZERO } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type IncomeGroup, type PerformanceData, type PerformanceYear } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { DivergingBars, StackBar, ValueChart, YearColumns } from '../components/charts.tsx';
import { Callout, Disclosure, Empty, Help, LoadError, Loading, PageHead, Segmented } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { eur, monthShort, niceName, percent, signClass, signed } from '../format.ts';
import { HELP } from '../glossary.ts';
import { useApi } from '../hooks.ts';

const CLASS_GROUPS: { key: string; label: string; classes: string[]; color: string }[] = [
  { key: 'stock', label: 'Acciones', classes: ['stock'], color: 'var(--series-1)' },
  { key: 'etf', label: 'ETF y fondos', classes: ['etf', 'fund'], color: 'var(--series-2)' },
  { key: 'crypto', label: 'Criptomonedas', classes: ['crypto'], color: 'var(--series-3)' },
  { key: 'other', label: 'Otros', classes: ['bond', 'other'], color: 'var(--series-4)' },
];
const PLACE_COLOR: Record<string, string> = {
  degiro: 'var(--series-1)', trade_republic: 'var(--series-2)', kraken: 'var(--series-3)', revolut: 'var(--series-4)', coinbase: 'var(--series-5)',
};
const placeName = (b: string) => (b === 'externo' ? 'Fuera de los brókers' : BROKER_LABEL[b as Broker] ?? b);

const sum = (rows: PerformanceYear[], key: 'realizedEur' | 'incomeEur' | 'feesEur' | 'unrealizedChangeEur' | 'resultEur' | 'unknownCostProceedsEur') =>
  rows.reduce((s, r) => s.plus(D(r[key])), ZERO);
const INCOME_LABEL: Record<IncomeGroup, string> = { dividends: 'Dividendos', interest: 'Intereses', staking: 'Staking', rewards: 'Recompensas', other: 'Otros' };
const incomeParts = (rows: PerformanceYear[]) => (Object.keys(INCOME_LABEL) as IncomeGroup[])
  .map((k) => ({ label: INCOME_LABEL[k], value: rows.reduce((s, r) => s.plus(D(r.incomeByType?.[k] ?? 0)), ZERO) }))
  .filter((p) => !p.value.isZero());

function Ranking({ title, rows }: { title: string; rows: { key: string; name: string; value: number }[] }) {
  return (
    <div className="rank">
      <h3>{title}</h3>
      {rows.length === 0 && <div className="small faint">Nada en este periodo.</div>}
      {rows.map((r) => (
        <div className="rank-row" key={r.key}>
          <span className="rank-name" title={r.name}>{r.name}</span>
          <span className={`num strong ${signClass(r.value.toFixed(2))}`}>{signed(r.value.toFixed(2))}</span>
        </div>
      ))}
    </div>
  );
}

export function Performance() {
  const { tick, changed, toast } = useApp();
  const { data, error: loadError, reload } = useApi<PerformanceData>('/performance', `${tick}`);
  const [period, setPeriod] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const r = await api<{ assets: number }>('/performance/refresh', { method: 'POST' });
      reload();
      toast(`Precios de ${r.assets} activos actualizados`);
      changed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  const view = useMemo(() => {
    if (!data) return null;
    const years = data.years.filter((y) => D(y.resultEur).abs().gt(0) || D(y.valueEndEur).gt(0) || D(y.unknownCostProceedsEur).gt(0));
    const thisYear = data.years[data.years.length - 1]?.year ?? 0;
    const rows = period === null ? years : years.filter((y) => y.year === period);
    const closeYear = period ?? thisYear;
    const months = period === null ? data.months.filter((m) => D(m.valueEur).gt(0) || D(m.costEur).gt(0)) : data.months.filter((m) => m.month === `${period - 1}-12` || m.month.startsWith(`${period}-`));
    const yearOfAsset = (a: PerformanceData['assets'][number]) => a.years[closeYear];
    const open = data.assets
      .filter((a) => a.class !== 'fx' && D(yearOfAsset(a)?.valueEndEur ?? 0).gt(0))
      .map((a) => ({ key: a.assetId, name: niceName(a.assetName), value: Number(yearOfAsset(a)?.unrealizedEndEur ?? 0), tip: `Vale ${eur(yearOfAsset(a)?.valueEndEur)}` }))
      .sort((a, b) => a.value - b.value);
    const results = data.assets
      .map((a) => ({
        key: a.assetId, name: niceName(a.assetName),
        value: (period === null ? Object.values(a.years) : [a.years[period]]).reduce((s, y) => s + Number(y?.resultEur ?? 0), 0),
      }))
      .filter((r) => Math.abs(r.value) >= 0.5);
    const classes = CLASS_GROUPS.map((g) => ({
      key: g.key, label: g.label, color: g.color,
      value: data.assets.filter((a) => g.classes.includes(a.class)).reduce((s, a) => s + Number(yearOfAsset(a)?.valueEndEur ?? 0), 0),
    }));
    return {
      years, rows, closeYear, thisYear, months, open, classes,
      best: results.filter((r) => r.value > 0).sort((a, b) => b.value - a.value).slice(0, 5),
      worst: results.filter((r) => r.value < 0).sort((a, b) => a.value - b.value).slice(0, 5),
      result: sum(rows, 'resultEur'),
      realized: sum(rows, 'realizedEur'),
      income: sum(rows, 'incomeEur'),
      incomeParts: incomeParts(rows),
      fees: sum(rows, 'feesEur'),
      change: sum(rows, 'unrealizedChangeEur'),
      unknown: sum(rows, 'unknownCostProceedsEur'),
      returnPct: period === null ? data.totalReturnPct : rows[0]?.returnPct ?? null,
      tax: period === null ? null : rows[0]?.taxEur ?? null,
    };
  }, [data, period]);

  if (!data || !view) return <><PageHead title="Desempeño" />{loadError ? <LoadError onRetry={reload} /> : <Loading />}</>;
  const button = (
    <button className={`btn ${data.hasHistory ? '' : 'primary'}`} disabled={refreshing} onClick={() => void refresh()}>
      <RefreshCw size={15} /> {refreshing ? 'Buscando…' : data.hasHistory ? 'Actualizar precios' : 'Cargar precios'}
    </button>
  );
  if (!data.hasHistory) {
    return (
      <>
        <PageHead title="Desempeño" />
        {error && <Callout tone="error">No se han podido obtener los precios: {error}</Callout>}
        <div className="card">
          <Empty icon={TrendingUp} title="Faltan los precios de cada mes">
            <p className="small muted" style={{ marginBottom: 12 }}>Se piden a Yahoo. Solo se envían ISIN y símbolos, nunca tus cantidades.</p>
            {button}
          </Empty>
        </div>
      </>
    );
  }

  const gained = view.result.gte(0);
  const when = period === null
    ? `desde ${monthShort(view.months[0]?.month ?? '')}`
    : period === view.thisYear ? `en ${period}, hasta hoy` : `en ${period}`;
  const afterTax = view.tax ? view.result.minus(D(view.tax)) : null;
  const updated = data.fetchedAt ? ` Precios del ${new Date(data.fetchedAt).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}.` : '';
  const closing = period === null || period === view.thisYear ? 'Si vendieras hoy' : `A 31 de diciembre de ${period}`;
  const openTotal = view.open.reduce((s, r) => s + r.value, 0);
  const unpriced = period === null ? data.missingPrices.now : data.missingPrices.byYear[period] ?? [];

  return (
    <>
      <PageHead title="Desempeño" sub={`Antes de impuestos.${updated}`}>{button}</PageHead>
      {error && <Callout tone="error">No se han podido obtener los precios: {error}</Callout>}
      {unpriced.length > 0 && (
        <Callout tone="warn" title={<span className="inline">{unpriced.length === 1 ? `${niceName(unpriced[0])} sin precio` : `${unpriced.length} activos sin precio`}{period === null ? ' hoy' : ` en ${period}`}: cuenta{unpriced.length === 1 ? '' : 'n'} a su coste {unpriced.length > 1 && <Help text={unpriced.map(niceName).join(', ')} />}</span>} />
      )}

      <div className="perf-filter">
        <Segmented<string>
          label="Periodo"
          value={period === null ? 'all' : String(period)}
          onChange={(v) => setPeriod(v === 'all' ? null : Number(v))}
          options={[{ id: 'all', label: 'Todo' }, ...[...view.years].reverse().map((y) => ({ id: String(y.year), label: String(y.year) }))]}
        />
      </div>

      <div className="card flush perf-hero">
        <div className="hero">
          <div>
            <div className="hero-label">{gained ? 'Has ganado' : 'Has perdido'} {when}</div>
            <div className={`hero-value ${signClass(view.result.toFixed(2))}`}>{eur(view.result.abs().toFixed(2))}</div>
          </div>
          {view.returnPct !== null && (
            <div className="hero-side">
              <div className="hero-label">Rentabilidad <Help text={HELP.rentabilidad} /></div>
              <div className={`val ${signClass(view.returnPct)}`}>{percent(view.returnPct)}</div>
            </div>
          )}
        </div>
        <div className="stats">
          <div className="stat"><div className="l">Lo vendido <Help text={HELP.loVendido} /></div><div className="v">{signed(view.realized.toFixed(2))}</div></div>
          <div className="stat"><div className="l">Sin vender <Help text={HELP.sinVender} /></div><div className="v">{signed(view.change.toFixed(2))}</div></div>
          <div className="stat"><div className="l">Dividendos, intereses y recompensas <Help text={HELP.rentas} /></div><div className="v">{signed(view.income.toFixed(2))}</div></div>
          <div className="stat"><div className="l">Gastos</div><div className="v">{signed(view.fees.neg().toFixed(2))}</div></div>
          {afterTax && <div className="stat"><div className="l">Tras el IRPF estimado</div><div className={`v ${signClass(afterTax.toFixed(2))}`}>{signed(afterTax.toFixed(2))}</div></div>}
        </div>
        {view.incomeParts.length > 1 && <p className="small faint perf-note">{view.incomeParts.map((p) => `${p.label} ${eur(p.value.toFixed(2))}`).join(' · ')}</p>}
        {view.unknown.gt(0) && <p className="small faint perf-note">No cuentan {eur(view.unknown.toFixed(2))} vendidos sin coste conocido.</p>}
      </div>

      <div className="card flush">
        <div className="card-title"><h2>Cada año</h2></div>
        <YearColumns
          selected={period}
          onSelect={(y) => setPeriod(period === y ? null : y)}
          years={view.years.map((y) => ({
            year: y.year,
            result: Number(y.resultEur),
            rows: [
              { label: 'Resultado', value: signed(y.resultEur) },
              { label: 'Lo vendido', value: signed(y.realizedEur) },
              { label: 'Sin vender', value: signed(y.unrealizedChangeEur) },
              { label: 'Dividendos, intereses y recompensas', value: signed(y.incomeEur) },
              { label: 'Gastos', value: signed(D(y.feesEur).neg().toFixed(2)) },
            ],
          }))}
        />
        <Disclosure title={<span className="small">Ver los datos</span>}>
          <div className="table-scroll">
            <table className="mini-table">
              <thead><tr><th>Año</th><th className="r">Lo vendido</th><th className="r">Sin vender</th><th className="r">Rentas</th><th className="r">Gastos</th><th className="r">Resultado</th><th className="r">%</th></tr></thead>
              <tbody>
                {view.years.map((y) => (
                  <tr key={y.year}>
                    <td>{y.year}</td>
                    <td className="r">{signed(y.realizedEur)}</td>
                    <td className="r">{signed(y.unrealizedChangeEur)}</td>
                    <td className="r">{signed(y.incomeEur)}</td>
                    <td className="r">{signed(D(y.feesEur).neg().toFixed(2))}</td>
                    <td className={`r strong ${signClass(y.resultEur)}`}>{signed(y.resultEur)}</td>
                    <td className="r">{y.returnPct === null ? '—' : percent(y.returnPct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Disclosure>
      </div>

      <div className="card flush">
        <div className="card-title">
          <h2>Cuánto vale y cuánto te costó</h2>
          <div className="chart-legend small">
            <span><i className="key value" /> Vale</span>
            <span><i className="key cost" /> Te costó</span>
          </div>
        </div>
        <ValueChart points={view.months.map((m) => ({ month: m.month, value: Number(m.valueEur), cost: Number(m.costEur) }))} />
      </div>

      <div className="card flush">
        <div className="card-title">
          <h2>{closing}</h2>
          <span className={`num strong ${signClass(openTotal.toFixed(2))}`}>{signed(openTotal.toFixed(2))}</span>
        </div>
        {view.open.length > 0 ? <DivergingBars rows={view.open} /> : <div className="item muted small">No tenías nada en cartera.</div>}
      </div>

      <div className="card">
        <h2>Lo que mejor y peor te ha ido</h2>
        <div className="rank-grid">
          <Ranking title="Mejor" rows={view.best} />
          <Ranking title="Peor" rows={view.worst} />
        </div>
      </div>

      <div className="card">
        <h2>Dónde está tu dinero</h2>
        <div className="stack-group">
          <div>
            <h3>Por tipo</h3>
            <StackBar segments={view.classes} />
          </div>
          {(period === null || period === view.thisYear) && (
            <div>
              <h3>Por sitio</h3>
              <StackBar segments={data.places.map((p) => ({ key: p.broker, label: placeName(p.broker), value: Number(p.valueEur), color: PLACE_COLOR[p.broker] ?? 'var(--ink-3)' }))} />
            </div>
          )}
        </div>
      </div>
    </>
  );
}
