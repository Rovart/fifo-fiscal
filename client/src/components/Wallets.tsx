import { ArrowRight, ExternalLink, Loader2, MoreHorizontal, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { Operation } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../context.ts';
import { dateShort, eur } from '../format.ts';
import { useApi } from '../hooks.ts';
import { Dialog, Menu } from './ui.tsx';

interface Wallet { id: string; address: string; at: string; ignored: Record<string, number>; swaps: Operation[] }
interface Synced { importId: string; added: number; found: number }

/** Cantidad legible: los 18 decimales de la cadena no caben en una fila. */
const amount = (v: string | null | undefined) => Number(v).toLocaleString('es-ES', { maximumFractionDigits: Number(v) >= 1000 ? 2 : Number(v) >= 1 ? 4 : 8 });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const countSwaps = (n: number) => `${n} ${n === 1 ? 'permuta' : 'permutas'}`;
const found = (r: Synced) => r.added ? `${countSwaps(r.added)} ${r.added === 1 ? 'nueva' : 'nuevas'}` : r.found ? 'Sin permutas nuevas' : 'No hay permutas en este wallet';
const SHOWN = 20;

/** Pide la dirección pública y busca las permutas del wallet. */
export function WalletDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const { changed, state } = useApp();
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const value = address.trim();
    if (busy) return;
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) { setError('Empieza por 0x y tiene 42 caracteres.'); return; }
    setBusy(true);
    setError('');
    try {
      const r = await api<Synced>('/wallets', { method: 'POST', body: { address: value }, profileId: state.profileId });
      onAdded(r.importId);
      onClose();
      changed(found(r));
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Wallet de Ethereum" onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className={`wallet-form ${busy ? 'busy' : ''}`}>
          <input className="input" autoFocus placeholder="0x…" aria-label="Dirección pública del wallet" autoComplete="off" spellCheck={false} value={address} readOnly={busy} onChange={(e) => { setAddress(e.target.value); setError(''); }} />
        </div>
        <p className={`small ${error ? 'loss' : 'muted'}`} role={error ? 'alert' : undefined} style={{ marginTop: 8 }}>{error || 'Solo se consulta la dirección pública, en Blockscout.'}</p>
        <div className="dialog-actions"><button type="button" className="btn quiet" disabled={busy} onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !address.trim()}>{busy ? <><Loader2 size={16} className="spin" /> Buscando…</> : 'Buscar permutas'}</button></div>
      </form>
    </Dialog>
  );
}

/** Una fila por wallet: al abrirla, cada permuta detectada se marca o desmarca para que cuente. */
export function WalletRows({ locked, isOpen, toggle, onRemove, onError }: { locked: boolean; isOpen: (key: string) => boolean; toggle: (key: string) => void; onRemove: (wallet: { id: string; name: string }) => void; onError: (message: string) => void }) {
  const { tick, changed, openEditor, state } = useApp();
  const { data } = useApi<Wallet[]>('/wallets', tick);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // La marca responde al instante; el FIFO se recalcula después.
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  useEffect(() => setMarks({}), [data]);
  const request = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body, profileId: state.profileId });

  const refresh = async (w: Wallet) => {
    setSyncing(w.id);
    onError('');
    try { changed(found(await request<Synced>('/wallets', { address: w.address }))); }
    catch (e) { onError((e as Error).message); }
    finally { setSyncing(null); }
  };
  const include = async (ids: string[], included: boolean) => {
    setMarks((old) => ({ ...old, ...Object.fromEntries(ids.map((id) => [id, included])) }));
    onError('');
    try {
      await request('/wallets/swaps', { ids, included });
      changed();
    } catch (e) { setMarks({}); onError((e as Error).message); }
  };

  return <>{(data ?? []).map((w) => {
    const key = `wallet:${w.id}`, open = isOpen(key);
    const on = (s: Operation) => marks[s.id] ?? !s.deleted;
    const included = w.swaps.filter(on).length;
    const all = included === w.swaps.length;
    const shown = expanded.has(w.id) ? w.swaps : w.swaps.slice(0, SHOWN);
    const skipped = Object.entries(w.ignored);
    return <div className="source wallet" key={w.id}>
      <div className="exchange-head">
        <button className="exchange-toggle" aria-expanded={open} aria-controls={`wallet-${w.id}`} onClick={() => toggle(key)}>
          <span className="exchange-avatar broker-ethereum" aria-hidden="true">Ξ</span>
          <span className="main-col"><span className="exchange-title" title={w.address}>Wallet {short(w.address)}</span><span className="sub">{syncing === w.id ? 'Actualizando…' : !w.swaps.length ? 'Sin permutas' : all ? countSwaps(w.swaps.length) : `${included} de ${countSwaps(w.swaps.length)}`}</span></span>
          <span className={`exchange-chevron ${open ? 'expanded' : ''}`}><ArrowRight size={16} /></span>
        </button>
        <Menu className="btn quiet icon" ariaLabel={`Acciones del wallet ${short(w.address)}`} label={<MoreHorizontal size={18} />} disabled={locked || !!syncing} items={[
          { label: 'Actualizar', icon: RefreshCw, onSelect: () => void refresh(w) },
          { label: 'Quitar wallet', icon: Trash2, danger: true, onSelect: () => onRemove({ id: w.id, name: w.address }) },
        ]} />
      </div>
      {open && <div id={`wallet-${w.id}`} className="exchange-documents">
        {w.swaps.length > 1 && <div className="swap-tools small"><button className="link" disabled={locked} onClick={() => void include(w.swaps.filter((s) => on(s) === all).map((s) => s.id), !all)}>{all ? 'Desmarcar todas' : 'Marcar todas'}</button></div>}
        <div className="list">{shown.map((s) => <label className={`item swap ${on(s) ? '' : 'off'}`} key={s.id}>
          <input type="checkbox" checked={on(s)} disabled={locked} onChange={(e) => void include([s.id], e.target.checked)} />
          <span className="main-col">
            <span className="title"><span className="strike">{amount(s.quantity)} {s.assetId} → {amount(s.counterQuantity)} {s.counterAsset}</span></span>
            <span className="sub">{dateShort(s.datetime)}{on(s) && s.reviewReasons?.length ? ' · Por revisar' : ''}</span>
          </span>
          <span className="end">{s.grossEur ? <span className="amount">{eur(s.grossEur)}</span> : !on(s) ? null : state.resolving ? <span className="small faint">Valorando…</span> : <button type="button" className="link small" onClick={() => openEditor(s)}>Poner valor</button>}</span>
          <a className="btn quiet icon" href={`https://eth.blockscout.com/tx/${s.orderRef}`} target="_blank" rel="noreferrer" aria-label="Ver la transacción en Blockscout"><ExternalLink size={15} /></a>
        </label>)}</div>
        {w.swaps.length > shown.length && <div className="more"><button className="btn small" onClick={() => setExpanded((old) => new Set(old).add(w.id))}>Ver todas ({w.swaps.length})</button></div>}
        {skipped.length > 0 && <p className="small muted swap-note">Sin importar: {skipped.map(([label, n]) => `${n} ${label}`).join(' · ')}.</p>}
      </div>}
    </div>;
  })}</>;
}
