import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CLASS_LABEL, type Asset, type AssetClass, type Market, type Settings as SettingsT } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Disclosure, Help, NumField, PageHead, Segmented } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dateShort, isinOf, niceName } from '../format.ts';
import { HELP } from '../glossary.ts';
import { applyTheme, loadTheme, type Theme } from '../theme.ts';

const MARKET_LABEL: Record<Market, string> = { eu: 'Europa', us: 'EE. UU.', other: 'Otro' };

function FifoStart() {
  const { changed } = useApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const recalculate = async () => {
    setBusy(true); setMessage('');
    try {
      const result = await api<{ verified: boolean; excluded: number }>('/fifo/recalculate', { method: 'POST' });
      setMessage(result.verified ? `FIFO actualizado · ${result.excluded === 1 ? '1 movimiento antiguo' : `${result.excluded} movimientos antiguos`} fuera del cálculo.` : 'No se ha podido comprobar un corte seguro. Se conserva el historial.');
      changed();
    } catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="card fifo-recalculate" aria-busy={busy}>
    <button className="btn" aria-describedby="fifo-recalculate-help" disabled={busy} onClick={() => void recalculate()}><RefreshCw size={15} className={busy ? 'spin' : ''} />{busy ? 'Comprobando…' : 'Recalcular FIFO'}</button>
    <p id="fifo-recalculate-help" className="small muted">Revisa los ciclos cerrados y conserva solo el historial que aún afecta al cálculo.</p>
    {message && <div className="small fifo-recalculate-status" role="status">{message}</div>}
  </div>;
}

/** Revolut identifica por símbolo: con el ISIN, sus movimientos entran en el mismo FIFO que los de otros brókers. */
function IsinField({ assetId }: { assetId: string }) {
  const { changed } = useApp();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await api(`/assets/${encodeURIComponent(assetId)}/isin`, { method: 'POST', body: { isin: value } });
      changed('ISIN guardado');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };
  return (
    <form className="isin-field" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <input className="input" placeholder="ISIN" aria-label={`ISIN de ${assetId}`} value={value} onChange={(e) => { setValue(e.target.value); setError(null); }} />
      <button className="btn small" disabled={!value.trim()}>Guardar</button>
      {error && <span className="small loss">{error}</span>}
    </form>
  );
}

export function Settings() {
  const { state, changed } = useApp();
  const [s, setS] = useState<SettingsT>(state.settings);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [q, setQ] = useState('');
  const [rateMsg, setRateMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const first = useRef(true);

  // Se guarda solo: un botón de guardar es una cosa más que recordar.
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => {
      const { fifoAutoStart: _auto, fifoStartDates: _dates, fifoConfirmedClosures: _closures, ...criteria } = s;
      void api('/settings', { method: 'PUT', body: criteria }).then(() => { setSaveError(''); changed('Guardado'); }).catch((e: Error) => setSaveError(e.message));
    }, 500);
    return () => clearTimeout(t);
  }, [s]); // eslint-disable-line

  const saveAsset = async (a: Asset) => {
    await api(`/assets/${encodeURIComponent(a.id)}`, { method: 'PUT', body: a });
    changed('Guardado');
  };
  const refresh = async () => {
    setBusy(true);
    setRateMsg(null);
    try {
      const r = await api<{ latest: string }>('/rates/refresh', { method: 'POST' });
      setRateMsg(`Actualizados hasta el ${dateShort(r.latest)}.`);
      changed();
    } catch (e) {
      setRateMsg(`No se pudo actualizar: ${e instanceof ApiError ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const assets = state.assets
    .filter((a) => a.class !== 'other' || a.id.length === 12)
    .filter((a) => !q || `${a.name} ${a.id}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHead title="Ajustes" />
      {saveError && <p className="small loss" role="alert">{saveError}</p>}
      <div className="card flush">
        <div className="list">
          <div className="item">
            <div className="main-col"><div className="strong">Apariencia</div></div>
            <Segmented label="Apariencia" value={theme} onChange={(t) => { setTheme(t); applyTheme(t); }} options={[{ id: 'auto', label: 'Automática' }, { id: 'light', label: 'Clara' }, { id: 'dark', label: 'Oscura' }]} />
          </div>
          <div className="item">
            <div className="main-col">
              <div className="strong">Cambio de moneda oficial</div>
              <div className="small muted">{rateMsg ?? `Actualizado hasta el ${dateShort(state.latestRate)}`}</div>
            </div>
            <button className="btn" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /> {busy ? 'Actualizando…' : 'Actualizar'}</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row-between">
          <div>
            <h2>Pérdidas de años anteriores</h2>
            <div className="small muted" style={{ marginTop: 2 }}>Las que te quedaron por compensar en tu última Renta.</div>
          </div>
          <label className="field" style={{ width: 170 }}>
            <span className="inline">Última Renta presentada <Help text="Desde ese año solo cuentan las pérdidas que escribas aquí. Los años ya presentados no se recalculan, aunque les falten datos." /></span>
            <select className="input" value={s.lastFiledYear ?? ''} onChange={(e) => setS({ ...s, lastFiledYear: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Sin indicar</option>
              {[...state.years].reverse().map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button className="btn small" onClick={() => setS({ ...s, openingLosses: [...s.openingLosses, { year: Number(state.today.slice(0, 4)) - 1, bucket: 'gpp', amount: '' }] })}><Plus size={14} /> Añadir</button>
        </div>
        {s.openingLosses.map((o, i) => {
          const upd = (patch: Partial<typeof o>) => { const n = [...s.openingLosses]; n[i] = { ...o, ...patch }; setS({ ...s, openingLosses: n }); };
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '90px minmax(140px, 1fr) minmax(110px, 1fr) 36px', gap: 10, alignItems: 'end', marginTop: 12 }}>
              <label className="field"><span>Año</span><input className="input" type="number" value={o.year} onChange={(e) => upd({ year: Number(e.target.value) })} /></label>
              <label className="field"><span>De</span>
                <select className="input" value={o.bucket} onChange={(e) => upd({ bucket: e.target.value as 'gpp' | 'rcm' })}>
                  <option value="gpp">Ventas</option>
                  <option value="rcm">Dividendos e intereses</option>
                </select>
              </label>
              <NumField label="Importe (€)" value={o.amount} onChange={(v) => upd({ amount: v })} />
              <button className="btn quiet icon" aria-label="Quitar" onClick={() => setS({ ...s, openingLosses: s.openingLosses.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
            </div>
          );
        })}
      </div>

      <Disclosure card title={`Mis activos (${assets.length})`} flush>
        <div style={{ padding: '0 22px 10px' }}>
          <input className="input" placeholder="Buscar" aria-label="Buscar activo" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="list">
          {assets.map((a) => (
            <div className="item" key={a.id} style={{ flexWrap: 'wrap' }}>
              <div className="main-col" style={{ minWidth: 180 }}>
                <div className="title">{niceName(a.name)}</div>
                <div className="sub">{a.id}{a.ticker ? ` · ${a.ticker}` : ''}</div>
              </div>
              {a.class !== 'crypto' && a.class !== 'other' && !isinOf(a.id) && <IsinField assetId={a.id} />}
              <select className="input" style={{ width: 'auto' }} value={a.class} aria-label={`Tipo de ${a.name}`} onChange={(e) => void saveAsset({ ...a, class: e.target.value as AssetClass })}>
                {(['stock', 'etf', 'fund', 'crypto', 'bond', 'other'] as const).map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
              </select>
              {a.class !== 'crypto' && (
                <select className="input" style={{ width: 'auto' }} value={a.market} aria-label={`Mercado de ${a.name}`} onChange={(e) => void saveAsset({ ...a, market: e.target.value as Market, marketByUser: true })}>
                  {(Object.keys(MARKET_LABEL) as Market[]).map((m) => <option key={m} value={m}>{MARKET_LABEL[m]}</option>)}
                </select>
              )}
            </div>
          ))}
          {assets.length === 0 && <div className="item muted small">Aparecerán al subir tus extractos.</div>}
        </div>
      </Disclosure>

      <FifoStart />

      <Disclosure card title="Criterios fiscales (avanzado)">
        <div className="stack">
          <label className="field">
            <span className="inline">Plazo de recompra en valores de EE. UU. <Help text={HELP.aplazada} /></span>
            <select className="input" value={s.washMonths.us} onChange={(e) => setS({ ...s, washMonths: { ...s.washMonths, us: Number(e.target.value) } })}>
              <option value={2}>2 meses</option>
              <option value={12}>1 año, lo más prudente</option>
            </select>
          </label>
          <label className="field">
            <span>Plazo de recompra en otros mercados no europeos</span>
            <select className="input" value={s.washMonths.other} onChange={(e) => setS({ ...s, washMonths: { ...s.washMonths, other: Number(e.target.value) } })}>
              <option value={12}>1 año</option>
              <option value={2}>2 meses</option>
            </select>
          </label>
          <label className="field">
            <span className="inline">Cambio de moneda en compras y ventas <Help text="El oficial es el del Banco Central Europeo de ese día. El real es el que aplicó tu bróker." /></span>
            <select className="input" value={s.fxSource} onChange={(e) => setS({ ...s, fxSource: e.target.value as SettingsT['fxSource'] })}>
              <option value="broker">El real de cada operación</option>
              <option value="ecb">Siempre el oficial</option>
            </select>
          </label>
          <label className="field">
            <span className="inline">Efecto de la moneda en las ventas <Help text="Con conversión al momento, el total es el mismo. Solo cambia en qué casillas aparece (consultas V0282-22 y V0152-26)." /></span>
            <select className="input" value={s.fxMethod} onChange={(e) => setS({ ...s, fxMethod: e.target.value as SettingsT['fxMethod'] })}>
              <option value="eur">Junto con la venta</option>
              <option value="split">En una línea aparte</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={s.fxTracking} onChange={(e) => setS({ ...s, fxTracking: e.target.checked })} />
            Calcular ganancias de saldos en moneda extranjera
          </label>
          <div className="form-grid">
            <NumField label="Margen de redondeo (€)" value={s.toleranceEur} onChange={(v) => setS({ ...s, toleranceEur: v })} />
            <NumField label="Tipo de convenio (%)" value={s.treatyDefault} onChange={(v) => setS({ ...s, treatyDefault: v })} />
          </div>
        </div>
      </Disclosure>
      <p className="small faint">Tus datos están en <code>{state.dbPath}</code>.</p>
    </>
  );
}
