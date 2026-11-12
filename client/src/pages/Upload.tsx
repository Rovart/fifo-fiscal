import { ArrowRight, Check, CircleAlert, CircleHelp, FileText, KeyRound, Loader2, MoreHorizontal, Plus, RefreshCw, Trash2, Unplug, Wallet, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BROKER_LABEL, type Broker, type FifoHistory } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { Callout, Dialog, Disclosure, Loading, Menu, PageHead } from '../components/ui.tsx';
import { WalletDialog, WalletRows } from '../components/Wallets.tsx';
import { ApiDialog, ApiStatus, useExchangeApis, type ApiBroker } from '../components/ExchangeApis.tsx';
import { Folder } from '../components/motion.tsx';
import { useApp } from '../context.ts';
import { dateShort, monthLabel } from '../format.ts';
import { useApi } from '../hooks.ts';

interface Preview {
  broker: Broker; format: string; rows: number; newOps: number; duplicates: number; warnings: string[]; ignored: Record<string, number>;
  needsReview: number; needsValue: number; kinds: Record<string, number>; costs: number; from: string | null; to: string | null;
}
interface Item { id: string; file: string; content: string; preview?: Preview; error?: string; done?: { added: number; existing?: boolean } }
interface ImportRow { id: string; at: string; file: string; broker: Broker; format: string; operations: number; summary: { newOps: number; duplicates: number; from?: string; to?: string; costs?: { attached: number; orphan: number } } }
interface Removal { title: string; name: string; path: string; files: number; wallet?: boolean }

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
  {
    id: 'cointracking',
    needs: [{ format: 'Lista de operaciones', label: 'Operaciones' }],
    steps: ['Entra en Introducir monedas.', 'Pulsa Exportar y elige CSV.', 'Añade antes los extractos de Kraken o Coinbase: lo que ya cubren no se duplica.'],
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
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<'wallet' | 'guides' | 'fifo' | ApiBroker | null>(null);
  const apis = useExchangeApis();
  const input = useRef<HTMLInputElement>(null);
  const target = useRef<Broker | null>(null);
  const readLock = useRef(false);
  const commitLock = useRef(false);
  const { data: history, error: historyError } = useApi<ImportRow[]>('/imports', tick);
  const { data: fifo } = useApi<FifoHistory>('/fifo/history', tick);
  // Una carga en curso sigue ligada a su cuenta aunque el usuario cambie de persona.
  const request = <T,>(path: string, opts: { method?: string; body?: unknown } = {}) => api<T>(path, { ...opts, profileId: state.profileId });
  const locked = busy || reading || removing;
  const open = (key: string, value = true) => setOpened((old) => { const next = new Set(old); if (value) next.add(key); else next.delete(key); return next; });

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

  // Los extractos se pueden soltar en cualquier parte de la página.
  const drop = useRef(addFiles);
  drop.current = addFiles;
  useEffect(() => {
    let depth = 0;
    const files = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    const enter = (e: DragEvent) => { if (files(e)) { depth++; setOver(true); } };
    const move = (e: DragEvent) => { if (files(e)) e.preventDefault(); };
    const leave = (e: DragEvent) => { if (files(e) && --depth <= 0) { depth = 0; setOver(false); } };
    const release = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      if (e.dataTransfer?.files.length) void drop.current(e.dataTransfer.files);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', move);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', release);
    return () => { window.removeEventListener('dragenter', enter); window.removeEventListener('dragover', move); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', release); };
  }, []);

  const commitAll = async () => {
    if (commitLock.current || readLock.current) return;
    commitLock.current = true;
    setBusy(true);
    setError('');
    // CoinTracking va al final: omite lo que ya cubren los extractos propios de cada exchange.
    const rank = (it: Item) => it.preview?.format === 'Transactions' ? 0 : it.preview?.broker === 'cointracking' ? 2 : 1;
    const order = [...items].filter((it) => it.preview && !it.done).sort((a, b) => rank(a) - rank(b));
    let added = 0, documents = 0;
    try {
      for (const it of order) {
        try {
          const r = await request<{ newOps: number; alreadyImported?: boolean }>('/import/commit', { method: 'POST', body: { file: it.file, content: it.content } });
          added += r.newOps;
          if (!r.alreadyImported) documents++;
          setItems((old) => old.map((o) => o.id === it.id ? { ...o, done: { added: r.newOps, existing: r.alreadyImported } } : o));
          open(`broker:${it.preview!.broker}`);
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
      changed(`${removal.wallet ? 'Wallet quitado' : `${countFiles(removal.files)} ${removal.files === 1 ? 'quitado' : 'quitados'}`} · ${countOps(r.removed)} retirados`);
    } catch (e) { setError((e as Error).message); }
    finally { setRemoving(false); }
  };

  const pending = items.filter((i) => i.preview && !i.done);
  const anyAdded = items.some((i) => i.done && !i.done.existing);
  const hasSources = (history?.length ?? 0) > 0 || apis.list.length > 0;
  const active = BROKERS.filter((b) => history?.some((h) => h.broker === b.id) || apis.of(b.id));
  const isApi = (b: Broker): b is ApiBroker => b === 'kraken' || b === 'coinbase';
  const account = state.profiles.find((p) => p.id === state.profileId)?.name;
  const fifoFrom = fifo?.cryptoFrom ?? fifo?.from;

  return (
    <>
      <PageHead title="Tus documentos" sub={<>{account}{!!state.counts.operations && fifo && <> · <button className="link muted" onClick={() => setDialog('fifo')}>FIFO {fifoFrom ? `desde ${dateShort(fifoFrom)}` : 'cerrado'}</button></>}</>}>
        <Menu className="btn primary" disabled={locked} label={<><Plus size={16} /> Añadir</>} items={[
          { label: 'Extractos CSV', icon: FileText, onSelect: () => choose() },
          { label: 'Wallet de Ethereum', icon: Wallet, onSelect: () => setDialog('wallet') },
          { label: 'Kraken o Coinbase por API', icon: KeyRound, onSelect: () => setDialog('kraken') },
          { label: 'Cómo descargar los extractos', icon: CircleHelp, onSelect: () => setDialog('guides') },
        ]} />
      </PageHead>
      <input ref={input} type="file" accept=".csv,text/csv" multiple hidden aria-label="Elegir documentos CSV" onChange={(e) => { if (e.target.files) void addFiles(e.target.files, target.current); e.target.value = ''; }} />
      {history && !hasSources && <div className={`drop ${over ? 'over' : ''} ${locked ? 'disabled' : ''}`} role="button" tabIndex={locked ? -1 : 0} aria-disabled={locked} aria-label="Añadir documentos CSV"
        onClick={() => { if (!locked) choose(); }}
        onKeyDown={(e) => { if (!locked && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); choose(); } }}>
        <div className={`upload-icon ${reading ? 'reading' : ''}`}><Folder /></div>
        <div><div className="strong">{reading ? 'Leyendo…' : 'Arrastra tus extractos CSV'}</div><div className="small muted">O elígelos aquí.</div></div>
      </div>}
      {hasSources && (over || reading) && <div className="drop-veil" aria-hidden="true"><div className={`drop ${over ? 'over' : ''}`}><div className={`upload-icon ${reading ? 'reading' : ''}`}><Folder /></div><div className="strong">{reading ? 'Leyendo…' : 'Suelta para añadir'}</div></div></div>}
      {(error && !removal || historyError) && <Callout tone="error">{historyError || error}</Callout>}

      {items.length > 0 && <section className="card flush upload-queue" aria-label="Documentos seleccionados" aria-busy={busy}>
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
        <div className="upload-footer">
          <button className="btn quiet small" disabled={locked} onClick={() => setItems([])}>Limpiar</button>
          {pending.length > 0 ? <button className="btn primary" disabled={locked} onClick={() => void commitAll()}>{busy ? <><Loader2 size={16} className="spin" /> Añadiendo…</> : `Añadir ${countFiles(pending.length)}`}</button> : anyAdded && <button className="btn primary" disabled={locked} onClick={() => go('review')}>Revisar <ArrowRight size={16} /></button>}
        </div>
      </section>}

      {!history && !historyError && <Loading />}
      {hasSources && <section className="card flush sources" aria-label="Exchanges y wallets">
        {active.map((b) => {
          const docs = history?.filter((h) => h.broker === b.id) ?? [];
          const link = apis.of(b.id);
          const key = `broker:${b.id}`, expanded = opened.has(key);
          const from = docs.map((d) => d.summary.from).filter(Boolean).sort()[0];
          const to = docs.map((d) => d.summary.to).filter(Boolean).sort().at(-1);
          return <div className="source" key={b.id}>
            <div className="exchange-head">
              <button className="exchange-toggle" aria-expanded={expanded} aria-controls={`documents-${b.id}`} onClick={() => open(key, !expanded)}>
                <span className={`exchange-avatar broker-${b.id}`}>{BROKER_LABEL[b.id].charAt(0)}</span>
                <span className="main-col"><span className="exchange-title">{BROKER_LABEL[b.id]}</span><span className="sub">{countFiles(docs.length)}{from && <span className="exchange-period"> · {period(from, to)}</span>}</span>{link && <span className="sub"><ApiStatus c={link} /></span>}</span>
                <span className={`exchange-chevron ${expanded ? 'expanded' : ''}`}><ArrowRight size={16} /></span>
              </button>
              <Menu className="btn quiet icon" ariaLabel={`Acciones de ${BROKER_LABEL[b.id]}`} label={<MoreHorizontal size={18} />} disabled={locked} items={[
                { label: 'Añadir documentos', icon: Plus, onSelect: () => choose(b.id) },
                ...(isApi(b.id) ? link
                  ? [{ label: 'Actualizar desde la API', icon: RefreshCw, disabled: link.running, onSelect: () => void apis.sync(b.id as ApiBroker).catch((e: Error) => setError(e.message)) },
                    { label: 'Desconectar la API', icon: Unplug, disabled: link.running, onSelect: () => void apis.disconnect(b.id as ApiBroker).catch((e: Error) => setError(e.message)) }]
                  : [{ label: 'Conectar por API', icon: KeyRound, onSelect: () => setDialog(b.id as ApiBroker) }] : []),
                { label: `Quitar ${BROKER_LABEL[b.id]}`, icon: Trash2, danger: true, onSelect: () => { setError(''); setRemoval({ title: `¿Quitar ${BROKER_LABEL[b.id]}?`, name: countFiles(docs.length), path: `/imports/broker/${b.id}`, files: docs.length }); } },
              ]} />
            </div>
            {expanded && <div id={`documents-${b.id}`} className="exchange-documents list">{docs.map((doc) => <div className="item" key={doc.id}>
              <FileText size={18} className="faint" />
              <div className="main-col"><div className="title file-name" title={doc.file}>{doc.file}</div><div className="sub">{FORMAT_LABEL[doc.format] ?? doc.format} · {doc.operations === 0 && doc.summary.costs?.attached ? `${doc.summary.costs.attached} ${doc.summary.costs.attached === 1 ? 'coste asociado' : 'costes asociados'}` : countOps(doc.operations)}<span className="document-date"> · {dateShort(doc.at)}</span></div></div>
              <button className="btn quiet icon" disabled={locked} aria-label={`Quitar ${doc.file}`} onClick={() => { setError(''); setRemoval({ title: '¿Quitar este documento?', name: doc.file, path: `/imports/${doc.id}`, files: 1 }); }}><Trash2 size={15} /></button>
            </div>)}</div>}
          </div>;
        })}
        <WalletRows locked={locked} isOpen={(key) => opened.has(key)} toggle={(key) => open(key, !opened.has(key))} onError={setError}
          onRemove={(w) => { setError(''); setRemoval({ title: '¿Quitar este wallet?', name: w.name, path: `/imports/${w.id}`, files: 1, wallet: true }); }} />
      </section>}

      {(dialog === 'kraken' || dialog === 'coinbase') && <ApiDialog initial={dialog} onClose={() => setDialog(null)} onConnected={(b) => { apis.reload(); open(`broker:${b}`); }} />}
      {dialog === 'wallet' && <WalletDialog onClose={() => setDialog(null)} onAdded={(id) => open(`wallet:${id}`)} />}
      {dialog === 'guides' && <Dialog title="Cómo descargar los extractos" onClose={() => setDialog(null)}>
        <div className="guides">{BROKERS.map((b) => <Disclosure key={b.id} title={BROKER_LABEL[b.id]}><ol>{b.steps.map((s) => <li key={s}>{s}</li>)}</ol></Disclosure>)}</div>
      </Dialog>}
      {dialog === 'fifo' && fifo && <Dialog title={`FIFO ${fifoFrom ? `desde ${dateShort(fifoFrom)}` : 'cerrado'}`} onClose={() => setDialog(null)}>
        <div className="stack" style={{ gap: 10 }}>
          {fifo.cryptoFrom && fifo.from && fifo.from < fifo.cryptoFrom && <p className="small muted">Otros activos necesitan historial desde {dateShort(fifo.from)}.</p>}
          <p className="small muted">{!fifo.complete ? 'Faltan datos para confirmar un inicio más reciente.' : fifo.from ? 'Para continuar en próximos años, necesitas los movimientos desde esta fecha. Lo anterior ya no sostiene posiciones ni pérdidas aplazadas.' : 'No quedan posiciones ni pérdidas aplazadas. Puedes empezar con las próximas operaciones.'} Conserva también los movimientos del año que declares y tus pérdidas pendientes de compensar.</p>
          {state.settings.fifoAutoStart && Object.entries(state.settings.fifoConfirmedClosures ?? {}).map(([id, c]) => <p className="small muted" key={id} title={c.note}>{id === 'CRYPTO:*' ? 'Todas las criptomonedas' : id} · Saldo cero confirmado por el titular en {monthLabel(c.month)}.</p>)}
          {fifo.assets.length > 0 && <div className="list fifo-assets">{fifo.assets.map((a) => <div className="item" key={a.assetId}><span className="main-col small">{a.assetName}{a.deferred && <span className="muted"> · Pérdida aplazada</span>}</span><span className="small num">{dateShort(a.from)}</span></div>)}</div>}
        </div>
      </Dialog>}

      {removal && <Dialog title={removal.title} onClose={() => { if (!removing) { setRemoval(null); setError(''); } }}>
        <p className="strong removal-name">{removal.name}</p>
        <p className="muted small">Se recalculará el FIFO de {account}. {removal.wallet ? 'Sus permutas dejarán de contar.' : 'Los movimientos presentes en otros documentos se conservan.'}</p>
        {error && <p className="small loss" role="alert">{error}</p>}
        <div className="dialog-actions"><button className="btn quiet" disabled={removing} onClick={() => setRemoval(null)}>Cancelar</button><button className="btn danger" disabled={removing} onClick={() => void remove()}>{removing ? 'Quitando…' : removal.wallet ? 'Quitar wallet' : removal.files === 1 ? 'Quitar documento' : 'Quitar documentos'}</button></div>
      </Dialog>}
    </>
  );
}
