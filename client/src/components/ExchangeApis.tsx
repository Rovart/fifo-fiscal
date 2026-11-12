import { Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BROKER_LABEL } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../context.ts';
import { dateShort } from '../format.ts';
import { useApi } from '../hooks.ts';
import { Dialog, Segmented } from './ui.tsx';

export type ApiBroker = 'kraken' | 'coinbase';
export interface Connection {
  broker: ApiBroker; hint: string; addedAt: string; syncedAt: string | null; running: boolean; fetched: number; error: string | null;
  result: { added: number; found: number; warnings: string[] } | null;
}

const GUIDE: Record<ApiBroker, { key: string; secret: string; steps: string }> = {
  kraken: { key: 'Clave pública', secret: 'Clave privada', steps: 'En Kraken: Ajustes → API → Crear clave. Marca solo «Query Ledger Entries».' },
  coinbase: { key: 'Nombre de la clave', secret: 'Clave privada', steps: 'En portal.cdp.coinbase.com: API Keys → Crear clave con permiso «View». También puedes pegar el JSON que descargas.' },
};

/** Conexiones activas. Mientras una lee, se consulta cada dos segundos; al acabar, avisa y refresca el resto. */
export function useExchangeApis() {
  const { tick, changed, state } = useApp();
  const { data, reload } = useApi<Connection[]>('/exchange-apis', tick);
  const busy = useRef(new Set<ApiBroker>());
  const running = data?.some((c) => c.running) ?? false;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [running, reload]);
  useEffect(() => {
    for (const c of data ?? []) {
      if (c.running) { busy.current.add(c.broker); continue; }
      if (!busy.current.delete(c.broker)) continue;
      const name = BROKER_LABEL[c.broker];
      changed(c.error ? `${name}: ${c.error}` : c.result?.added ? `${c.result.added} movimientos nuevos de ${name}` : `${name} al día`);
    }
  }, [data, changed]);
  const call = async (path: string, method: string) => { await api(path, { method, profileId: state.profileId }); reload(); };
  return {
    list: data ?? [],
    of: (b: string) => data?.find((c) => c.broker === b),
    sync: (b: ApiBroker) => call(`/exchange-apis/${b}/sync`, 'POST'),
    disconnect: (b: ApiBroker) => call(`/exchange-apis/${b}`, 'DELETE'),
    reload,
  };
}

/** Estado de la API en la fila del exchange. */
export function ApiStatus({ c }: { c: Connection }) {
  if (c.running) return <span className="api-status"><Loader2 size={13} className="spin" aria-hidden="true" /> Leyendo la API{c.fetched ? ` · ${c.fetched.toLocaleString('es-ES')}` : ''}…</span>;
  if (c.error) return <span className="api-status loss">API: {c.error}</span>;
  return <span className="api-status">API {c.syncedAt ? `al día ${dateShort(c.syncedAt)}` : 'conectada'}</span>;
}

/** Pide las claves de solo lectura; el servidor las comprueba antes de guardarlas y empieza a leer. */
export function ApiDialog({ initial = 'kraken', onClose, onConnected }: { initial?: ApiBroker; onClose: () => void; onConnected: (b: ApiBroker) => void }) {
  const { state, toast } = useApp();
  const [broker, setBroker] = useState<ApiBroker>(initial);
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const guide = GUIDE[broker];
  // Coinbase entrega un JSON con las dos partes: basta con pegarlo.
  const json = broker === 'coinbase' && secret.trim().startsWith('{');
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await api(`/exchange-apis/${broker}`, { method: 'PUT', body: { key, secret }, profileId: state.profileId });
      onConnected(broker);
      onClose();
      toast(`${BROKER_LABEL[broker]} conectado. Leyendo movimientos…`);
    } catch (e) { setError((e as Error).message); setBusy(false); }
  };
  return (
    <Dialog title="Conectar por API" onClose={() => { if (!busy) onClose(); }}>
      <form className="stack api-form" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Segmented label="Exchange" value={broker} options={[{ id: 'kraken', label: 'Kraken' }, { id: 'coinbase', label: 'Coinbase' }]} onChange={(b) => { setBroker(b); setError(''); }} />
        <p className="small muted">{guide.steps}</p>
        {!json && <label className="field"><span>{guide.key}</span><input className="input" autoComplete="off" spellCheck={false} value={key} readOnly={busy} onChange={(e) => { setKey(e.target.value); setError(''); }} /></label>}
        <label className="field"><span>{guide.secret}</span>
          {broker === 'coinbase'
            ? <textarea className="input" rows={4} autoComplete="off" spellCheck={false} placeholder="-----BEGIN EC PRIVATE KEY-----" value={secret} readOnly={busy} onChange={(e) => { setSecret(e.target.value); setError(''); }} />
            : <input className="input" type="password" autoComplete="off" spellCheck={false} value={secret} readOnly={busy} onChange={(e) => { setSecret(e.target.value); setError(''); }} />}
        </label>
        <p className={`small ${error ? 'loss' : 'muted'}`} role={error ? 'alert' : undefined}>{error || 'Solo lectura. Las claves se quedan en este equipo, fuera de las copias de seguridad.'}</p>
        <div className="dialog-actions">
          <button type="button" className="btn quiet" disabled={busy} onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !secret.trim() || (!json && !key.trim())}>{busy ? <><Loader2 size={16} className="spin" /> Comprobando…</> : 'Conectar'}</button>
        </div>
      </form>
    </Dialog>
  );
}
