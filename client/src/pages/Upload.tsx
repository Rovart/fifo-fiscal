import { ArrowRight, Check, CircleAlert, FileText, Loader2, Plus, Trash2, UploadCloud, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { BROKER_LABEL, type Broker, type FifoHistory } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Callout, Dialog, Disclosure, Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dateShort, monthLabel } from '../format.ts';
import { useApi } from '../hooks.ts';

interface Preview {
  broker: Broker; format: string; rows: number; newOps: number; duplicates: number; warnings: string[]; ignored: Record<string, number>;
  needsReview: number; needsValue: number; kinds: Record<string, number>; costs: number; from: string | null; to: string | null;
}
interface Item { id: string; file: string; content: string; preview?: Preview; error?: string; done?: { added: number; existing?: boolean } }
interface ImportRow { id: string; at: string; file: string; broker: Broker; format: string; operations: number; summary: { newOps: number; duplicates: number; from?: string; to?: string; costs?: { attached: number; orphan: number } } }
interface Removal { title: string; name: string; path: string; files: number }

const FORMAT_LABEL: Record<string, string> = { 'Extracto de acciones': 'Acciones', 'Extracto de cripto': 'Cripto', 'Historial de transacciones': 'Transacciones', Transactions: 'Compras y ventas', Account: 'Estado de cuenta', Ledgers: 'Movimientos', 'Exportación de transacciones': 'Transacciones' };
const countFiles = (n: number) => `${n} ${n === 1 ? 'documento' : 'documentos'}`;
const countOps = (n: number) => `${n.toLocaleString('es-ES')} ${n === 1 ? 'movimiento' : 'movimientos'}`;
const period = (from?: string | null, to?: string | null) => from ? from === to ? dateShort(from) : `${dateShort(from)} – ${dateShort(to)}` : '';

const BROKERS: { id: Broker; needs: { format: string; label: string }[]; steps: string[] }[] = [
  {
    id: 'degiro',
    needs: [{ format: 'Transactions', label: 'Transacciones' }, { format: 'Account', label: 'Estado de cuenta' }],
    steps: ['Entra en Actividad.', 'En Transacciones, exporta en CSV.', 'En Estado de cuenta, exporta en CSV.', 'Elige desde tu primera operación hasta hoy.'],
  },
  {
    id: 'trade_republic',
    needs: [{ format: 'Exportación de transacciones', label: 'Transacciones' }],
    steps: ['Abre tu perfil.', 'Entra en Extractos de cuenta.', 'Pulsa Exportación de transacciones.', 'Elige desde tu alta hasta hoy.'],
  },
  {
    id: 'kraken',
    needs: [{ format: 'Ledgers', label: 'Ledgers' }],
    steps: ['Entra en Documentos.', 'Pulsa Exportar y elige Ledgers.', 'Formato CSV, todo el periodo.'],
  },
  {
    id: 'revolut',
    needs: [{ format: 'Extracto de acciones', label: 'Acciones' }, { format: 'Extracto de cripto', label: 'Cripto' }],
    steps: ['En Inversiones, abre Más y Documentos.', 'Pide el Extracto de cuenta en CSV, desde el principio.', 'En Cripto, abre Más y Extractos, en CSV.', 'Sube solo lo que uses.'],
  },
  {
    id: 'coinbase',
    needs: [{ format: 'Historial de transacciones', label: 'Transacciones' }],
    steps: ['Abre tu perfil y entra en Informes.', 'Genera el Historial de transacciones.', 'Todos los activos, formato CSV, desde el principio.'],
  },
];


export function Upload() {
  const { tick, changed, go, state } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState('');
  const [removal, setRemoval] = useState<Removal | null>(null);
  const [removing, setRemoving] = useState(false);
  const [closedBrokers, setClosedBrokers] = useState<Set<Broker>>(new Set());
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<Broker | null>(null);
  const readLock = useRef(false);
  const commitLock = useRef(false);
  const { data: history, error: historyError } = useApi<ImportRow[]>('/imports', tick);
  const { data: fifo } = useApi<FifoHistory>('/fifo/history', tick);
  // Una carga en curso sigue ligada a su cuenta aunque el usuario cambie de persona.
  const request = <T,>(path: string, opts: { method?: string; body?: unknown } = {}) => api<T>(path, { ...opts, profileId: state.profileId });
  const locked = busy || reading || removing;

  const choose = (broker: Broker | null = null) => { target.current = broker; input.current?.click(); };
  const addFiles = async (files: FileList | File[], broker: Broker | null = null) => {
    if (readLock.current || commitLock.current || removing) return;
    readLock.current = true;
    setReading(true);
    setError('');
    const next: Item[] = [];
    try {
      for (const f of Array.from(files)) {
        const item: Item = { id: crypto.randomUUID(), file: f.name, content: '' };
        try {
          item.content = await f.text();
          item.preview = await request<Preview>('/import/preview', { method: 'POST', body: { content: item.content } });
          if (broker && item.preview.broker !== broker) {
            item.error = `Este archivo es de ${BROKER_LABEL[item.preview.broker]}. Añádelo desde su exchange.`;
            item.preview = undefined;
          }
        } catch (e) { item.error = (e as Error).message; }
        next.push(item);
      }
      setItems((old) => [...old.filter((o) => !o.done), ...next]);
    } finally { readLock.current = false; setReading(false); }
  };

  const commitAll = async () => {
    if (commitLock.current || readLock.current) return;
    commitLock.current = true;
    setBusy(true);
    setError('');
    const order = [...items].filter((it) => it.preview && !it.done).sort((a, b) => Number(b.preview?.format === 'Transactions') - Number(a.preview?.format === 'Transactions'));
    let added = 0, documents = 0;
    try {
      for (const it of order) {
        try {
          const r = await request<{ newOps: number; alreadyImported?: boolean }>('/import/commit', { method: 'POST', body: { file: it.file, content: it.content } });
          added += r.newOps;
          if (!r.alreadyImported) documents++;
          setItems((old) => old.map((o) => o.id === it.id ? { ...o, done: { added: r.newOps, existing: r.alreadyImported } } : o));
          setClosedBrokers((old) => { const next = new Set(old); next.delete(it.preview!.broker); return next; });
        } catch (e) {
          setItems((old) => old.map((o) => o.id === it.id ? { ...o, error: (e as Error).message, preview: undefined } : o));
        }
      }
      changed(documents > 0 ? `${countFiles(documents)} ${documents === 1 ? 'añadido' : 'añadidos'} · ${countOps(added)} nuevos` : added === 0 ? 'Sin movimientos nuevos' : `${countOps(added)} añadidos`);
    } finally { commitLock.current = false; setBusy(false); }
  };

  const remove = async () => {
    if (!removal || removing) return;
    setRemoving(true);
    setError('');
    try {
      const r = await request<{ removed: number }>(removal.path, { method: 'DELETE' });
      setItems((old) => old.filter((o) => !o.done));
      setRemoval(null);
      changed(`${countFiles(removal.files)} ${removal.files === 1 ? 'quitado' : 'quitados'} · ${countOps(r.removed)} retirados`);
    } catch (e) { setError((e as Error).message); }
    finally { setRemoving(false); }
  };

  const pending = items.filter((i) => i.preview && !i.done);
  const anyAdded = items.some((i) => i.done && !i.done.existing);
  const hasHistory = (history?.length ?? 0) > 0;
  const active = BROKERS.filter((b) => history?.some((h) => h.broker === b.id));
  const available = BROKERS.filter((b) => !history?.some((h) => h.broker === b.id));
  const toggle = (broker: Broker) => setClosedBrokers((old) => { const next = new Set(old); if (next.has(broker)) next.delete(broker); else next.add(broker); return next; });

  return (
    <>
      <PageHead title="Tus documentos" sub={state.profiles.find((p) => p.id === state.profileId)?.name}>
        {hasHistory && <button className="btn primary" disabled={locked} onClick={() => choose()}><Plus size={16} /> Añadir documentos</button>}
      </PageHead>
      <input ref={input} type="file" accept=".csv,text/csv" multiple hidden aria-label="Elegir documentos CSV" onChange={(e) => { if (e.target.files) void addFiles(e.target.files, target.current); e.target.value = ''; }} />
      <div className={`drop ${hasHistory ? 'compact' : ''} ${over ? 'over' : ''} ${locked ? 'disabled' : ''}`} role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked} aria-label="Añadir documentos CSV"
        onClick={() => { if (!locked) choose(); }}
        onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(); } }}
        onDragOver={(e) => { e.preventDefault(); if (!locked) setOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(false); }}
        onDrop={(e) => { e.preventDefault(); setOver(false); if (!locked) void addFiles(e.dataTransfer.files); }}>
        <div className="upload-icon">{reading ? <Loader2 size={24} className="spin" /> : <UploadCloud size={24} />}</div>
        <div><div className="strong">{reading ? 'Leyendo documentos…' : hasHistory ? 'Arrastra más documentos' : 'Arrastra tus extractos CSV'}</div><div className="small muted">{hasHistory ? 'Puedes añadir varios del mismo exchange.' : 'O elígelos aquí. Incluye todo el historial.'}</div></div>
        {!hasHistory && <span className="upload-formats">DEGIRO · Trade Republic · Kraken · Revolut · Coinbase</span>}
      </div>
      {(error && !removal || historyError) && <Callout tone="error">{historyError || error}</Callout>}

      {!!state.counts.operations && fifo && <Disclosure card title={<span>FIFO actual {fifo.cryptoFrom ? 'cripto ' : ''}{fifo.cryptoFrom || fifo.from ? <>desde <strong>{dateShort(fifo.cryptoFrom ?? fifo.from)}</strong></> : 'cerrado'}{!fifo.complete && !fifo.cryptoFrom && <span className="small muted"> · Historial por completar</span>}</span>}>
          {fifo.cryptoFrom && fifo.from && fifo.from < fifo.cryptoFrom && <p className="small muted">Otros activos necesitan historial desde {dateShort(fifo.from)}.</p>}
          <p className="small muted">{!fifo.complete ? 'Faltan datos para confirmar un inicio más reciente.' : fifo.from ? 'Para continuar en próximos años, necesitas los movimientos desde esta fecha. Lo anterior ya no sostiene posiciones ni pérdidas aplazadas.' : 'No quedan posiciones ni pérdidas aplazadas. Puedes empezar con las próximas operaciones.'} Conserva también los movimientos del año que declares y tus pérdidas pendientes de compensar.</p>
          {state.settings.fifoAutoStart && Object.entries(state.settings.fifoConfirmedClosures ?? {}).map(([id, c]) => <p className="small muted" key={id} title={c.note}>{id} · Saldo cero confirmado por el titular en {monthLabel(c.month)}.</p>)}
          {fifo.assets.length > 0 && <div className="list">{fifo.assets.map((a) => <div className="item" key={a.assetId}><span className="main-col small">{a.assetName}{a.deferred && <span className="muted"> · Pérdida aplazada</span>}</span><span className="small num">{dateShort(a.from)}</span></div>)}</div>}
      </Disclosure>}

      {items.length > 0 && <section className="card flush upload-queue" aria-label="Documentos seleccionados" aria-busy={busy}>
        <div className="card-title"><h2>{pending.length ? 'Listos para añadir' : 'Documentos seleccionados'}</h2><button className="btn quiet small" disabled={locked} onClick={() => setItems([])}>Limpiar</button></div>
        <div className="list">{items.map((it) => <div key={it.id}>
          <div className="item">
            <div className={`avatar ${it.error ? 'loss' : it.done ? 'gain' : ''}`}>{it.error ? <CircleAlert size={18} /> : it.done ? <Check size={18} /> : <FileText size={18} />}</div>
            <div className="main-col">
              <div className="title file-name" title={it.file}>{it.file}</div>
              <div className="sub">{it.error ? 'No se ha añadido' : it.done ? it.done.existing ? 'Ya estaba añadido' : `${countOps(it.done.added)} nuevos` : it.preview ? `${BROKER_LABEL[it.preview.broker]} · ${countOps(it.preview.newOps)} nuevos${it.preview.duplicates ? ` · ${it.preview.duplicates} repetidos` : ''}` : ''}</div>
            </div>
            <button className="btn quiet icon" disabled={locked} aria-label={`Descartar ${it.file}`} onClick={() => setItems((old) => old.filter((o) => o.id !== it.id))}><X size={16} /></button>
          </div>
          {it.error && <div className="upload-detail"><Callout tone="error">{it.error}</Callout></div>}
          {!!it.preview?.warnings.length && !it.done && <div className="upload-detail"><Disclosure title={<span className="small">{it.preview.warnings.length === 1 ? '1 aviso del archivo' : `${it.preview.warnings.length} avisos del archivo`}</span>}><ul className="small muted">{it.preview.warnings.slice(0, 12).map((w, i) => <li key={i}>{w}</li>)}</ul></Disclosure></div>}
        </div>)}</div>
        {(pending.length > 0 || anyAdded) && <div className="upload-footer">
          <span className="small muted">{pending.length > 0 ? `${countFiles(pending.length)} · Sin duplicar movimientos` : 'Documentos guardados'}</span>
          {pending.length > 0 ? <button className="btn primary" disabled={locked} onClick={() => void commitAll()}>{busy ? <><Loader2 size={16} className="spin" /> Añadiendo…</> : `Añadir ${countFiles(pending.length)}`}</button> : <button className="btn primary" disabled={locked} onClick={() => go('review')}>Revisar <ArrowRight size={16} /></button>}
        </div>}
      </section>}

      {!history && !historyError && <Loading />}
      {active.length > 0 && <div className="stack exchange-list">{active.map((b) => {
        const docs = history!.filter((h) => h.broker === b.id);
        const expanded = !closedBrokers.has(b.id);
        const from = docs.map((d) => d.summary.from).filter(Boolean).sort()[0];
        const to = docs.map((d) => d.summary.to).filter(Boolean).sort().at(-1);
        return <section className="card flush exchange" key={b.id}>
          <div className="exchange-head">
            <button className="exchange-toggle" aria-expanded={expanded} aria-controls={`documents-${b.id}`} onClick={() => toggle(b.id)}>
              <span className={`exchange-avatar broker-${b.id}`}>{BROKER_LABEL[b.id].charAt(0)}</span>
              <span className="main-col"><span className="exchange-title">{BROKER_LABEL[b.id]}</span><span className="sub">{countFiles(docs.length)}{from && <span className="exchange-period"> · {period(from, to)}</span>}</span></span>
              <span className={`exchange-chevron ${expanded ? 'expanded' : ''}`}><ArrowRight size={16} /></span>
            </button>
            <div className="exchange-actions"><button className="btn small" disabled={locked} onClick={() => choose(b.id)} aria-label={`Añadir documentos a ${BROKER_LABEL[b.id]}`}><Plus size={15} /><span>Añadir</span></button><button className="btn quiet icon" disabled={locked} aria-label={`Quitar ${BROKER_LABEL[b.id]}`} onClick={() => { setError(''); setRemoval({ title: `¿Quitar ${BROKER_LABEL[b.id]}?`, name: countFiles(docs.length), path: `/imports/broker/${b.id}`, files: docs.length }); }}><Trash2 size={16} /></button></div>
          </div>
          {expanded && <div id={`documents-${b.id}`} className="exchange-documents list">{docs.map((doc) => <div className="item" key={doc.id}>
            <FileText size={18} className="faint" />
            <div className="main-col"><div className="title file-name" title={doc.file}>{doc.file}</div><div className="sub">{FORMAT_LABEL[doc.format] ?? doc.format} · {doc.operations === 0 && doc.summary.costs?.attached ? `${doc.summary.costs.attached} ${doc.summary.costs.attached === 1 ? 'coste asociado' : 'costes asociados'}` : countOps(doc.operations)}<span className="document-date"> · {dateShort(doc.at)}</span></div></div>
            <button className="btn quiet icon" disabled={locked} aria-label={`Quitar ${doc.file}`} onClick={() => { setError(''); setRemoval({ title: '¿Quitar este documento?', name: doc.file, path: `/imports/${doc.id}`, files: 1 }); }}><Trash2 size={15} /></button>
          </div>)}</div>}
        </section>;
      })}</div>}

      {available.length > 0 && <Disclosure title={hasHistory ? 'Añadir otro exchange' : 'Cómo descargar tus extractos'}>
        <div className="broker-grid">{available.map((b) => <div className="broker" key={b.id}>
          <div className="head"><div className={`exchange-avatar broker-${b.id}`}>{BROKER_LABEL[b.id].charAt(0)}</div><div className="strong">{BROKER_LABEL[b.id]}</div><button className="btn quiet icon" disabled={locked} aria-label={`Añadir documentos a ${BROKER_LABEL[b.id]}`} onClick={() => choose(b.id)}><Plus size={17} /></button></div>
          <Disclosure title={<span className="small">Descargar CSV</span>}><ol>{b.steps.map((s) => <li key={s}>{s}</li>)}</ol></Disclosure>
        </div>)}</div>
      </Disclosure>}

      {removal && <Dialog title={removal.title} onClose={() => { if (!removing) { setRemoval(null); setError(''); } }}>
        <p className="strong removal-name">{removal.name}</p>
        <p className="muted small">Se recalculará el FIFO de {state.profiles.find((p) => p.id === state.profileId)?.name}. Los movimientos presentes en otros documentos se conservan.</p>
        {error && <p className="small loss" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="btn quiet" disabled={removing} onClick={() => setRemoval(null)}>Cancelar</button><button className="btn danger" disabled={removing} onClick={() => void remove()}>{removing ? 'Quitando…' : removal.files === 1 ? 'Quitar documento' : 'Quitar documentos'}</button></div>
      </Dialog>}
    </>
  );
}
