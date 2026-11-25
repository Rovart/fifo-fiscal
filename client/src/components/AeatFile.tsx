import { Check, ChevronRight, CircleAlert, CircleCheck, Download, FileCode2, Info, Landmark, Pencil } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { D } from '../../../shared/decimal.ts';
import { BROKER_LABEL, REGIONS, fullName, type Broker, type Custodian, type CustodianIdType, type Declarant, type ForeignFormReport } from '../../../shared/types.ts';
import { api, ApiError, getProfileId } from '../api.ts';
import { useApp } from '../context.ts';
import { useApi } from '../hooks.ts';
import { dateShort } from '../format.ts';
import { HELP } from '../glossary.ts';
import { CopyValue } from './ui.tsx';

/*
 * Presentar en Hacienda: ficheros del 720 y el 721 y XML de Renta.
 * Panel propio (clases .hz): cabecera con estado y acción principal, y una lista de lo que hace falta.
 */

const ID_LABEL: Record<CustodianIdType, string> = {
  nif: 'NIF español', '02': 'NIF-IVA', '03': 'Pasaporte', '04': 'Identificación del país de residencia', '05': 'Certificado de residencia', '06': 'Otro documento',
};
const CIVIL: Record<string, string> = { '1': 'Soltero o soltera', '2': 'Casado o casada', '3': 'Viudo o viuda', '4': 'Separado o divorciado' };
const EMPTY: Declarant = { nif: '', surnames: '', firstName: '', phone: '', birthDate: '', sex: '', civilStatus: '', region: '' };
/** Lo que falta del declarante, tal como lo dice el servidor. */
const DECLARANT_MISSING = new Set(['tu NIF', 'tus apellidos y nombre', 'un teléfono de 9 cifras', 'tu fecha de nacimiento', 'tu sexo', 'tu estado civil', 'tu comunidad autónoma']);

const label = (b: string) => BROKER_LABEL[b as Broker] ?? b;
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : String(e));
const pendingText = (items: string[]) => `Falta ${items.join(', ')}`;

/** Descarga un fichero de la API con la cuenta activa y explica el error si no se puede generar. */
async function downloadFile(path: string, filename: string) {
  const res = await fetch(`/api${path}`, { headers: { 'X-Fifo-Profile': getProfileId() } });
  if (!res.ok) throw new ApiError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Error ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Icono de información: la explicación aparece al pasar o pulsar, sin ocupar la pantalla. */
function InfoTip({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ left: Math.max(8, Math.min(window.innerWidth - 288, r.left + r.width / 2 - 140)), top: r.bottom + 8 });
  };
  const hide = () => setPos(null);
  return (
    <>
      <button ref={ref} type="button" className="hz-info" aria-label={text} onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (pos) hide(); else show(); }}>
        <Info size={15} strokeWidth={2} />
      </button>
      {pos && createPortal(<div className="tooltip" role="tooltip" style={{ left: pos.left, top: pos.top, width: 280 }}>{text}</div>, document.body)}
    </>
  );
}

function Panel({ icon, title, badge, info, missing, action, children, standalone }: {
  icon: ReactNode; title: string; badge?: ReactNode; info: string; missing: number; action: ReactNode; children: ReactNode; standalone?: boolean;
}) {
  return (
    <section className={`hz ${standalone ? 'hz-standalone' : ''}`}>
      <header className="hz-head">
        <div className="hz-icon" aria-hidden>{icon}</div>
        <div className="hz-titles">
          <div className="hz-title">{title}{badge}<InfoTip text={info} /></div>
          <div className={`hz-status ${missing ? '' : 'ready'}`}>{missing ? `${missing} ${missing === 1 ? 'dato pendiente' : 'datos pendientes'}` : 'Listo para descargar'}</div>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Fila de la lista: estado, qué es, su valor y, si se puede, edición en el sitio o un enlace. */
function CheckRow({ ok, label: name, value, open, onToggle, nav, children }: {
  ok: boolean; label: string; value: ReactNode; open?: boolean; onToggle?: () => void; nav?: boolean; children?: ReactNode;
}) {
  const inner = (
    <>
      {ok ? <CircleCheck size={18} className="hz-ok" /> : <CircleAlert size={18} className="hz-warn" />}
      <span className="hz-row-text">
        <span className="hz-row-label">{name}</span>
        <span className={`hz-row-value ${ok ? '' : 'pending'}`}>{value}</span>
      </span>
      {onToggle && (nav ? <ChevronRight size={16} className="hz-row-edit" aria-hidden /> : <Pencil size={15} className="hz-row-edit" aria-hidden />)}
    </>
  );
  return (
    <div className={`hz-row ${open ? 'open' : ''}`}>
      {onToggle
        ? <button type="button" className="hz-row-head" aria-expanded={nav ? undefined : !!open} onClick={onToggle}>{inner}</button>
        : <div className="hz-row-head static">{inner}</div>}
      {open && <div className="hz-row-body">{children}</div>}
    </div>
  );
}

function FormActions({ ready = true, onSave, onCancel, error }: { ready?: boolean; onSave: () => void; onCancel?: () => void; error: string }) {
  return (
    <div className="hz-actions">
      <button type="button" className="hz-btn sm" disabled={!ready} onClick={onSave}>Guardar</button>
      {onCancel && <button type="button" className="hz-btn sm ghost" onClick={onCancel}>Cancelar</button>}
      {error && <span className="hz-error" role="alert">{error}</span>}
    </div>
  );
}

/** Datos de quien declara. El 720 y el 721 piden teléfono; la Renta, los datos personales. */
function DeclarantForm({ initial, renta, onDone }: { initial: Declarant | null | undefined; renta?: boolean; onDone: () => void }) {
  const { changed } = useApp();
  const [d, setD] = useState<Declarant>({ ...EMPTY, ...initial });
  const [error, setError] = useState('');
  const set = (patch: Partial<Declarant>) => setD({ ...d, ...patch });
  const save = async () => {
    try {
      await api('/settings', { method: 'PUT', body: { declarant: { ...d, phone: d.phone.replace(/\D/g, '') } } });
      changed('Guardado');
      onDone();
    } catch (e) { setError(errorText(e)); }
  };
  const ready = !!(d.nif.trim() && d.surnames.trim() && d.firstName.trim() && (renta ? d.birthDate && d.sex && d.civilStatus && d.region : d.phone.trim()));
  return (
    <>
      <div className="form-grid">
        <label className="field"><span>NIF</span><input className="input" autoComplete="off" value={d.nif} onChange={(e) => set({ nif: e.target.value })} /></label>
        <label className="field"><span>Apellidos</span><input className="input" value={d.surnames} onChange={(e) => set({ surnames: e.target.value })} /></label>
        <label className="field"><span>Nombre</span><input className="input" value={d.firstName} onChange={(e) => set({ firstName: e.target.value })} /></label>
        {!renta && <label className="field"><span>Teléfono</span><input className="input" inputMode="tel" placeholder="9 cifras" value={d.phone} onChange={(e) => set({ phone: e.target.value })} /></label>}
        {renta && (
          <>
            <label className="field"><span>Fecha de nacimiento</span><input className="input" type="date" value={d.birthDate ?? ''} onChange={(e) => set({ birthDate: e.target.value })} /></label>
            <label className="field"><span>Sexo</span>
              <select className="input" value={d.sex ?? ''} onChange={(e) => set({ sex: e.target.value as Declarant['sex'] })}>
                <option value="">—</option><option value="M">Mujer</option><option value="H">Hombre</option>
              </select>
            </label>
            <label className="field"><span>Estado civil a 31 de diciembre</span>
              <select className="input" value={d.civilStatus ?? ''} onChange={(e) => set({ civilStatus: e.target.value as Declarant['civilStatus'] })}>
                <option value="">—</option>{Object.entries(CIVIL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
            <label className="field"><span>Comunidad autónoma</span>
              <select className="input" value={d.region ?? ''} onChange={(e) => set({ region: e.target.value })}>
                <option value="">—</option>{Object.entries(REGIONS).sort(([, a], [, b]) => a.localeCompare(b, 'es')).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </>
        )}
      </div>
      <FormActions ready={ready} onSave={() => void save()} onCancel={initial ? onDone : undefined} error={error} />
    </>
  );
}

function EntityForm({ form, broker, initial, onDone }: { form: '720' | '721'; broker: string; initial: Custodian; onDone: () => void }) {
  const { changed, state: { settings } } = useApp();
  const [c, setC] = useState<Custodian>(initial);
  const [error, setError] = useState('');
  const save = async () => {
    try {
      const value = form === '720' ? { country: c.country.toUpperCase() } : { ...c, country: c.country.toUpperCase(), id: c.id.trim(), web: c.web.trim() };
      await api('/settings', { method: 'PUT', body: { custodians: { ...settings.custodians, [`${form}|${broker}`]: value } } });
      changed('Guardado');
      onDone();
    } catch (e) { setError(errorText(e)); }
  };
  const country = (
    <label className="field">
      <span>{form === '720' ? 'País donde están depositados' : 'País'}</span>
      <input className="input" maxLength={2} placeholder="IE" value={c.country} onChange={(e) => setC({ ...c, country: e.target.value.toUpperCase() })} />
    </label>
  );
  return (
    <>
      {form === '720' ? <div className="form-grid">{country}</div> : (
        <div className="form-grid">
          <label className="field"><span>Entidad que custodia</span><input className="input" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} /></label>
          {country}
          <label className="field"><span>Tipo de identificación</span>
            <select className="input" value={c.idType} onChange={(e) => setC({ ...c, idType: e.target.value as CustodianIdType })}>
              {Object.entries(ID_LABEL).map(([id, text]) => <option key={id} value={id}>{text}</option>)}
            </select>
          </label>
          <label className="field"><span>Número</span><input className="input" maxLength={20} value={c.id} onChange={(e) => setC({ ...c, id: e.target.value })} /></label>
          <label className="field"><span>Web</span><input className="input" maxLength={50} placeholder="www…" value={c.web} onChange={(e) => setC({ ...c, web: e.target.value })} /></label>
        </div>
      )}
      <FormActions onSave={() => void save()} onCancel={onDone} error={error} />
    </>
  );
}

/** Datos del 721 tal como los pide el formulario web, moneda a moneda: punto decimal y seis decimales. */
function FormRecords({ f }: { f: ForeignFormReport }) {
  const [open, setOpen] = useState(false);
  const rows = [
    ...(f.onlyClosures ? [] : f.holdings.map((h) => ({ ...h, quantity: h.quantity, origin: h.origin ?? 'A', date: null as string | null }))),
    ...f.closures.map((c) => ({ ...c, quantity: c.endQuantity ?? c.quantity, valueEur: c.valueEur ?? '0', origin: 'C' as const, date: c.date ?? null })),
  ].filter((r) => D(r.quantity).toDecimalPlaces(6).gt(0));
  const six = (v: ReturnType<typeof D>) => v.toDecimalPlaces(6).toFixed();
  const copy = (v: string) => <CopyValue value={v} display={v} text />;
  return (
    <div className={`hz-more ${open ? 'open' : ''}`}>
      <div className="hz-more-head">
        <button type="button" className="hz-more-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <ChevronRight size={16} className="hz-chev" /> Sin certificado: formulario web
        </button>
        <InfoTip text={HELP.formulario721} />
      </div>
      {open && (
        <div className="hz-table-wrap">
          <table className="hz-table">
            <thead><tr><th>Moneda</th><th className="r">Número</th><th className="r">Valor</th><th className="r">Saldo</th><th><span className="hz-th-info">Origen <InfoTip text={HELP.origen721} /></span></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.broker}|${r.assetId}`}>
                  <td><div className="hz-coin">{r.assetId}</div><div className="hz-coin-sub">{label(r.broker)}{r.date ? ` · ${dateShort(r.date)}` : ''}</div></td>
                  <td className="r">{copy(six(D(r.quantity)))}</td>
                  <td className="r">{copy(six(D(r.valueEur).div(D(r.quantity))))}</td>
                  <td className="r">{copy(D(r.valueEur).toFixed(2))}</td>
                  <td><span className="hz-origin">{r.origin}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DownloadButton({ disabled, onClick, busy, children }: { disabled: boolean; onClick: () => void; busy: boolean; children: ReactNode }) {
  return <button type="button" className="hz-btn" disabled={disabled || busy} onClick={onClick}><Download size={16} />{busy ? 'Generando…' : children}</button>;
}

/** Descarga del fichero del 720 o del mensaje del 721 para la sede de la AEAT. */
export function AeatFile({ f, year }: { f: ForeignFormReport; year: number }) {
  const { state: { settings } } = useApp();
  const [editing, setEditing] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const missing = f.missing ?? [];
  if (missing.includes('algo que declarar') || missing.includes('que termine el año')) return null;
  const who = settings.declarant;
  const toggle = (id: string) => setEditing(editing === id ? null : id);
  const whoMissing = missing.filter((m) => DECLARANT_MISSING.has(m));
  const download = async () => {
    setBusy(true); setError('');
    try { await downloadFile(`/aeat/${f.form}/${year}`, f.form === '720' ? `modelo-720-${year}.txt` : `modelo-721-${year}.xml`); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };

  return (
    <Panel
      icon={<Landmark size={19} />} title={`Modelo ${f.form} para Hacienda`} info={f.form === '720' ? HELP.fichero720 : HELP.fichero721} missing={missing.length}
      badge={f.onlyClosures ? <span className="hz-badge neutral">Solo cierres <InfoTip text={HELP.soloCierres} /></span> : undefined}
      action={<DownloadButton disabled={missing.length > 0} busy={busy} onClick={() => void download()}>{f.form === '720' ? 'Descargar .txt' : 'Descargar .xml'}</DownloadButton>}
    >
      {error && <p className="hz-error hz-error-block" role="alert">{error}</p>}
      <div className="hz-list">
        <CheckRow ok={!whoMissing.length && !!who} label="Declarante" value={who && !whoMissing.length ? `${fullName(who)} · ${who.nif}` : pendingText(whoMissing)}
          open={editing === 'declarant'} onToggle={() => toggle('declarant')}>
          <DeclarantForm initial={who} onDone={() => setEditing(null)} />
        </CheckRow>
        {(f.entities ?? []).map(({ broker, custodian: c }) => {
          const id = `${f.form}|${broker}`;
          const own = missing.filter((m) => m.includes(label(broker)));
          const value = own.length ? pendingText(own) : f.form === '720' ? `Depositado en ${c.country}` : `${c.name} · ${c.id}`;
          return (
            <CheckRow key={id} ok={!own.length} label={label(broker)} value={value} open={editing === id} onToggle={() => toggle(id)}>
              <EntityForm form={f.form} broker={broker} initial={c} onDone={() => setEditing(null)} />
            </CheckRow>
          );
        })}
      </div>
      {f.form === '721' && <FormRecords f={f} />}
    </Panel>
  );
}

interface RentaCheck { missing: string[]; parts: string[]; notes: { title: string; detail: string }[] }

/** XML con las inversiones para «Presentación mediante fichero» de Renta: se importa y se completa allí. */
export function RentaFile({ year }: { year: number }) {
  const { tick, go, state: { settings } } = useApp();
  const { data } = useApi<RentaCheck>(`/aeat/100/${year}/check`, `${year}-${tick}`);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // El XML solo existe para la Renta 2025: en otros años la tarjeta no aporta nada.
  if (!data || data.parts.length === 0 || data.missing.some((m) => m.startsWith('el diseño'))) return null;
  const who = settings.declarant;
  const whoMissing = data.missing.filter((m) => DECLARANT_MISSING.has(m));
  const review = data.missing.includes('resolver lo pendiente en Revisar');
  const download = async () => {
    setBusy(true); setError('');
    try { await downloadFile(`/aeat/100/${year}`, `renta-${year}-inversiones.xml`); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  };
  return (
    <Panel
      standalone icon={<FileCode2 size={19} />} title="Importar en Renta Web" badge={<span className="hz-badge">Beta</span>} info={HELP.rentaXml} missing={data.missing.length}
      action={<DownloadButton disabled={data.missing.length > 0} busy={busy} onClick={() => void download()}>Descargar XML</DownloadButton>}
    >
      {error && <p className="hz-error hz-error-block" role="alert">{error}</p>}
      <div className="hz-chips">{data.parts.map((p) => <span key={p} className="hz-chip"><Check size={13} strokeWidth={2.5} />{p}</span>)}</div>
      <div className="hz-list">
        <CheckRow ok={!whoMissing.length && !!who} label="Declarante" value={who && !whoMissing.length ? `${fullName(who)} · ${who.nif}` : pendingText(whoMissing)}
          open={editing} onToggle={() => setEditing(!editing)}>
          <DeclarantForm initial={who} renta onDone={() => setEditing(false)} />
        </CheckRow>
        {review && <CheckRow ok={false} label="Revisar" value="Hay datos por resolver" nav onToggle={() => go('review')} />}
        {data.notes.map((n) => <CheckRow key={n.title} ok={false} label="Completar en Renta Web" value={<span className="hz-inline">{n.title}<InfoTip text={n.detail} /></span>} />)}
      </div>
    </Panel>
  );
}
