import { CheckCircle2, CircleAlert, CircleDashed, CircleDollarSign, Plus, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { D, parseLocaleNumber } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type Issue, type Operation } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Callout, Disclosure, Empty, Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dateShort, niceName, plain, qty } from '../format.ts';
import { useApi } from '../hooks.ts';

interface PositionRow { broker: string; assetId: string; assetName: string; class: string; computed: string; declared: string | null; diff: string | null; ok: boolean | null }
interface Checks {
  issues: Issue[];
  otherYears: { year: number; count: number }[];
  summary: { errors: number; warnings: number; infos: number; operations: number; edited: number; missingValues: number };
  positions: PositionRow[];
}

const PREVIEW = 4;

function MissingPrices({ count }: { count: number }) {
  const { changed, state: { profileId } } = useApp();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [failed, setFailed] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let done = 0, remaining = 1;
      const bad: string[] = [];
      while (remaining > 0) {
        const r = await api<{ done: number; failed: string[]; remaining: number }>('/prices/resolve', { method: 'POST', profileId });
        done += r.done;
        bad.push(...r.failed);
        remaining = r.remaining;
        setProgress(`${done} de ${count}`);
        if (r.done === 0) break;
      }
      setFailed([...new Set(bad)]);
      changed(done === 1 ? '1 precio encontrado' : `${done} precios encontrados`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
      setProgress('');
    }
  };
  return (
    <div className="item act">
      <div className="avatar loss"><CircleDollarSign size={18} /></div>
      <div className="main-col">
        <div className="strong">{count === 1 ? '1 movimiento de cripto sin precio' : `${count} movimientos de cripto sin precio`}</div>
        <div className="small muted">
          {error ?? (failed.length ? `No encontrado: ${failed.slice(0, 4).join(', ')}. Escríbelo a mano.` : 'Lo buscamos en Kraken. Solo se envía la moneda y la fecha.')}
        </div>
      </div>
      <button className="btn primary" disabled={busy} onClick={() => void run()}>
        {busy ? (progress || 'Buscando…') : <><Search size={15} /> Buscar precios</>}
      </button>
    </div>
  );
}

function MissingLots({ issues }: { issues: Issue[] }) {
  const { openEditor } = useApp();
  const byAsset = useMemo(() => {
    const m = new Map<string, { name: string; assetId: string; qty: ReturnType<typeof D>; first: string; opId?: string; count: number }>();
    for (const i of issues) {
      const k = i.assetId ?? '';
      const e = m.get(k) ?? { name: i.assetName ?? k, assetId: k, qty: D(0), first: i.date ?? '', opId: i.opId, count: 0 };
      e.qty = e.qty.plus(D(i.quantity));
      e.count++;
      if ((i.date ?? '') < e.first) e.first = i.date ?? '';
      m.set(k, e);
    }
    return [...m.values()];
  }, [issues]);
  const addBuy = async (e: (typeof byAsset)[number]) => {
    const sale = e.opId ? await api<Operation>(`/operations/${e.opId}`) : null;
    openEditor(null, {
      kind: 'buy', assetId: e.assetId, assetName: e.name, assetClass: sale?.assetClass ?? 'stock', quantity: e.qty.toFixed(), broker: sale?.broker ?? 'manual', currency: 'EUR', fxRate: '1',
      datetime: `${e.first}T00:00:00`,
    });
  };
  return (
    <>
      {byAsset.map((e) => (
        <div className="item act" key={e.assetId}>
          <div className="avatar loss"><CircleAlert size={18} /></div>
          <div className="main-col">
            <div className="strong">{niceName(e.name)}: faltan compras</div>
            <div className="small muted">Has vendido {qty(e.qty.toFixed())} más de lo que consta.</div>
          </div>
          <button className="btn" onClick={() => void addBuy(e)}><Plus size={15} /> Añadir compra</button>
        </div>
      ))}
    </>
  );
}

function FixList({ issues }: { issues: Issue[] }) {
  const { openEditor } = useApp();
  return (
    <>
      {issues.map((i) => (
        <div className="item act" key={`${i.opId}${i.code}`}>
          <div className="avatar loss"><CircleAlert size={18} /></div>
          <div className="main-col">
            <div className="strong">{niceName(i.assetName)}</div>
            <div className="small muted">{i.message} {i.date && `(${dateShort(i.date)})`}</div>
          </div>
          <button className="btn" onClick={() => { if (i.opId) void api<Operation>(`/operations/${i.opId}`).then((o) => openEditor(o)); }}>Corregir</button>
        </div>
      ))}
    </>
  );
}

function ReasonGroup({ reason, issues }: { reason: string; issues: Issue[] }) {
  const { changed, openEditor } = useApp();
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const title = reason.startsWith('Revolut no da el ISIN.') ? 'ISIN de los valores de Revolut'
    : reason.startsWith('Revolut da el dividendo ya neto.') ? 'Dividendos de Revolut: bruto y retención' : reason;
  const shown = all ? issues : issues.slice(0, PREVIEW);
  const confirm = async (ids: string[]) => {
    setBusy(true);
    setError('');
    try {
      await api('/review/confirm', { method: 'POST', body: { ids, reason } });
      changed(ids.length === 1 ? 'Marcado como revisado' : `${ids.length} marcados como revisados`);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <div className="card flush">
      <div className="next" style={{ alignItems: 'flex-start' }}>
        <div className="avatar warn"><CircleDashed size={18} /></div>
        <div className="body">
          <div className="strong">{title}</div>
          <div className="small muted">{issues.length === 1 ? '1 movimiento' : `${issues.length} movimientos`}</div>
          {title !== reason && <div className="small muted">{reason.startsWith('Revolut no da el ISIN.') ? 'Añade su ISIN en Ajustes si también los tienes en otro bróker.' : 'Comprueba el bruto y la retención con el informe anual.'}</div>}
        </div>
        {issues.length > 1 && <button className="btn" disabled={busy} onClick={() => void confirm(issues.map((i) => i.opId as string))}>Todos bien</button>}
      </div>
      {error && <div className="upload-detail small loss" role="alert">{error}</div>}
      <div className="list" style={{ borderTop: '1px solid var(--hairline)' }}>
        {shown.map((i) => (
          <div className="item" key={i.opId}>
            <div className="main-col">
              <div className="title">{niceName(i.assetName)}</div>
              <div className="sub">{dateShort(i.date)}</div>
            </div>
            <button className="btn quiet small" onClick={() => void api<Operation>(`/operations/${i.opId}`).then((o) => openEditor(o))}>Ver</button>
            <button className="btn small" disabled={busy} onClick={() => void confirm([i.opId as string])}>Está bien</button>
          </div>
        ))}
      </div>
      {issues.length > PREVIEW && !all && <div className="more"><button className="link" onClick={() => setAll(true)}>Ver los {issues.length}</button></div>}
    </div>
  );
}

function BalanceRow({ p, onSaved }: { p: PositionRow; onSaved: () => void }) {
  const [text, setText] = useState(plain(p.declared));
  useEffect(() => setText(plain(p.declared)), [p.declared]);
  const save = async () => {
    const parsed = text.trim() === '' ? null : parseLocaleNumber(text);
    if (text.trim() !== '' && parsed === null) return;
    if ((parsed ?? null) === (p.declared === null ? null : D(p.declared).toFixed())) return;
    await api('/balances', { method: 'PUT', body: { broker: p.broker, assetId: p.assetId, quantity: parsed } });
    onSaved();
  };
  return (
    <tr>
      <td>{niceName(p.assetName)}<div className="small muted">{BROKER_LABEL[p.broker as Broker] ?? p.broker}</div></td>
      <td className="r">{qty(p.computed)}</td>
      <td className="r">
        <input className="input" style={{ width: 120, minHeight: 32, padding: '4px 8px', textAlign: 'right' }} inputMode="decimal" placeholder="—" aria-label={`Saldo real de ${p.assetName}`} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void save()} />
      </td>
      <td className="r" style={{ width: 90 }}>
        {p.ok === true && <span className="tag gain">Coincide</span>}
        {p.ok === false && <span className="tag loss">{qty(p.diff)}</span>}
      </td>
    </tr>
  );
}

export function Review() {
  const { tick, go, changed, year, setYear } = useApp();
  const { data } = useApi<Checks>(`/checks?year=${year}`, `${tick}`);

  const groups = useMemo(() => {
    const issues = data?.issues ?? [];
    const reasons = new Map<string, Issue[]>();
    for (const i of issues) {
      if (i.code !== 'needs_review' || !i.reason) continue;
      reasons.set(i.reason, [...(reasons.get(i.reason) ?? []), i]);
    }
    return {
      valuation: issues.filter((i) => i.code === 'missing_valuation'),
      lots: issues.filter((i) => i.code === 'missing_lots'),
      fix: issues.filter((i) => i.severity === 'error' && !['missing_valuation', 'missing_lots'].includes(i.code)),
      reasons: [...reasons.entries()].sort((a, b) => b[1].length - a[1].length),
      infos: issues.filter((i) => i.severity === 'info'),
    };
  }, [data]);

  if (!data) return <><PageHead title="Revisar" year /><Loading /></>;
  if (data.summary.operations === 0) {
    return (
      <>
        <PageHead title="Revisar" />
        <div className="card"><Empty icon={CircleDashed} title="Aún no hay nada que revisar"><button className="btn primary" onClick={() => go('upload')}>Subir mis extractos</button></Empty></div>
      </>
    );
  }
  const hasErrors = groups.valuation.length + groups.lots.length + groups.fix.length > 0;
  const clean = !hasErrors && groups.reasons.length === 0;
  const mismatches = data.positions.filter((p) => p.ok === false).length;

  return (
    <>
      <PageHead title={`Revisar ${year}`} year sub={clean ? undefined : hasErrors ? 'Empieza por lo de arriba: cambia tus resultados.' : 'Mira cada grupo y confirma si está bien.'} />
      {clean && (
        <div className="card">
          <Empty icon={CheckCircle2} tone="gain" title={`${year} está en orden`}>
            <button className="btn primary" onClick={() => go('renta')}>Ir a Mi Renta</button>
          </Empty>
        </div>
      )}
      {hasErrors && (
        <div className="card flush">
          <div className="card-title"><h2>Para resolver</h2></div>
          <div className="list">
            {groups.valuation.length > 0 && <MissingPrices count={groups.valuation.length} />}
            <MissingLots issues={groups.lots} />
            <FixList issues={groups.fix} />
          </div>
        </div>
      )}
      {groups.reasons.length > 0 && (
        <>
          {hasErrors && <h2 style={{ marginTop: 8 }}>Para comprobar</h2>}
          {groups.reasons.map(([reason, list]) => <ReasonGroup key={reason} reason={reason} issues={list} />)}
        </>
      )}
      {data.positions.length > 0 && (
        <Disclosure
          card
          title="Comparar con el saldo de tu bróker"
          meta={mismatches > 0 ? <span className="tag loss">{mismatches === 1 ? '1 no coincide' : `${mismatches} no coinciden`}</span> : undefined}
        >
          <table className="mini-table">
            <thead><tr><th>Activo</th><th className="r">Calculado</th><th className="r">Tu saldo real</th><th /></tr></thead>
            <tbody>{data.positions.map((p) => <BalanceRow key={`${p.broker}${p.assetId}`} p={p} onSaved={() => changed()} />)}</tbody>
          </table>
        </Disclosure>
      )}
      {groups.infos.length > 0 && (
        <Disclosure card title={`Para tu información (${groups.infos.length})`}>
          <div className="stack" style={{ gap: 10 }}>
            {groups.infos.slice(0, 30).map((i, n) => (
              <div className="small" key={n}>
                {i.assetName && <strong>{niceName(i.assetName)}{i.date ? ` (${dateShort(i.date)})` : ''}: </strong>}
                <span className="muted">{i.message}</span>
              </div>
            ))}
          </div>
        </Disclosure>
      )}
      {data.otherYears.length > 0 && (
        <div className="chips small muted">
          Otros años con avisos:
          {data.otherYears.map((o) => <button key={o.year} className="chip" onClick={() => setYear(o.year)}>{o.year} ({o.count})</button>)}
        </div>
      )}
      <Callout tone="info">¿Falta algo que no aparece aquí? <button className="link" onClick={() => go('movements')}>Añádelo en Movimientos</button>.</Callout>
    </>
  );
}
