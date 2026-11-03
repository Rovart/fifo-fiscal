import { ArrowRight, Check, CircleAlert, FileText, Loader2, UploadCloud, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { BROKER_LABEL, type Broker } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Callout, Disclosure, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { useApi } from '../hooks.ts';

interface Preview {
  broker: Broker; format: string; rows: number; newOps: number; duplicates: number; warnings: string[]; ignored: Record<string, number>;
  needsReview: number; needsValue: number; kinds: Record<string, number>; costs: number;
}
interface Item { file: string; content: string; preview?: Preview; error?: string; done?: { added: number } }
interface ImportRow { id: string; at: string; file: string; broker: Broker; format: string; summary: { newOps: number; duplicates: number } }

const FORMAT_LABEL: Record<string, string> = { 'Extracto de acciones': 'Acciones', 'Extracto de cripto': 'Cripto', 'Historial de transacciones': 'Transacciones', Transactions: 'Compras y ventas', Account: 'Estado de cuenta', Ledgers: 'Movimientos', 'Exportación de transacciones': 'Transacciones' };

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
  const { tick, changed, go } = useApp();
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data: history, reload } = useApi<ImportRow[]>('/imports', `${tick}`);

  const addFiles = async (files: FileList | File[]) => {
    setReading(true);
    const next: Item[] = [];
    for (const f of Array.from(files)) {
      const content = await f.text();
      try {
        next.push({ file: f.name, content, preview: await api<Preview>('/import/preview', { method: 'POST', body: { content } }) });
      } catch (e) {
        next.push({ file: f.name, content, error: e instanceof ApiError ? e.message : String(e) });
      }
    }
    setItems((old) => [...old.filter((o) => !o.done), ...next]);
    setReading(false);
  };

  const commitAll = async () => {
    setBusy(true);
    // Primero las compras y ventas, para que los impuestos del estado de cuenta encuentren su operación.
    const order = [...items].sort((a, b) => (a.preview?.format === 'Transactions' ? -1 : 0) - (b.preview?.format === 'Transactions' ? -1 : 0));
    const out: Item[] = [];
    let added = 0;
    for (const it of order) {
      if (!it.preview || it.done) { out.push(it); continue; }
      try {
        const r = await api<{ newOps: number }>('/import/commit', { method: 'POST', body: { file: it.file, content: it.content } });
        added += r.newOps;
        out.push({ ...it, done: { added: r.newOps } });
      } catch (e) {
        out.push({ ...it, error: e instanceof ApiError ? e.message : String(e), preview: undefined });
      }
    }
    setItems(out);
    setBusy(false);
    reload();
    changed(added === 1 ? '1 movimiento añadido' : `${added} movimientos añadidos`);
  };

  const undo = async (row: ImportRow) => {
    if (!window.confirm(`¿Quitar los movimientos de ${row.file}?`)) return;
    const r = await api<{ removed: number }>(`/imports/${row.id}`, { method: 'DELETE' });
    reload();
    changed(`${r.removed} movimientos quitados`);
  };

  const pending = items.filter((i) => i.preview && !i.done);
  const toAdd = pending.reduce((s, p) => s + (p.preview?.newOps ?? 0), 0);
  const allDone = items.length > 0 && items.every((i) => i.done || i.error);
  const anyAdded = items.some((i) => i.done);

  return (
    <>
      <PageHead title="Sube tus extractos" sub="Incluye desde tu primera compra: el cálculo necesita toda la historia." />
      <div
        className={`drop ${over ? 'over' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); void addFiles(e.dataTransfer.files); }}
      >
        <div className="avatar" style={{ width: 48, height: 48 }}>{reading ? <Loader2 size={22} /> : <UploadCloud size={22} />}</div>
        <div className="strong">Arrastra aquí tus archivos CSV</div>
        <div className="small muted">o haz clic para elegirlos. Reconocemos el bróker solos.</div>
        <input ref={input} type="file" accept=".csv,text/csv" multiple hidden onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
      </div>

      {items.length > 0 && (
        <div className="card flush">
          <div className="list">
            {items.map((it, i) => (
              <div key={i}>
                <div className="item">
                  <div className={`avatar ${it.error ? 'loss' : it.done ? 'gain' : ''}`}>
                    {it.error ? <CircleAlert size={18} /> : it.done ? <Check size={18} /> : <FileText size={18} />}
                  </div>
                  <div className="main-col">
                    <div className="title">{it.preview ? `${BROKER_LABEL[it.preview.broker]} · ${FORMAT_LABEL[it.preview.format] ?? it.preview.format}` : it.file}</div>
                    <div className="sub">
                      {it.error && 'No reconocemos este archivo'}
                      {it.done && (it.done.added === 1 ? '1 movimiento añadido' : `${it.done.added} movimientos añadidos`)}
                      {!it.done && it.preview && (
                        it.preview.newOps === 0 ? 'Ya estaba todo subido' : `${it.preview.newOps} movimientos nuevos${it.preview.duplicates ? `, ${it.preview.duplicates} ya estaban` : ''}`
                      )}
                    </div>
                  </div>
                  {!it.done && <button className="btn quiet icon" aria-label={`Quitar ${it.file}`} onClick={() => setItems(items.filter((_, j) => j !== i))}><X size={16} /></button>}
                </div>
                {it.error && <div style={{ padding: '0 22px 14px' }}><Callout tone="error">{it.error}</Callout></div>}
                {it.preview && it.preview.warnings.length > 0 && !it.done && (
                  <div style={{ padding: '0 22px 12px 70px' }}>
                    <Disclosure title={<span className="small">{it.preview.warnings.length === 1 ? '1 línea que no podemos importar sola' : `${it.preview.warnings.length} líneas que no podemos importar solas`}</span>}>
                      <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                        {it.preview.warnings.slice(0, 12).map((w) => <li key={w}>{w}</li>)}
                      </ul>
                      {it.preview.warnings.length > 12 && <div className="small faint">Y {it.preview.warnings.length - 12} más.</div>}
                    </Disclosure>
                  </div>
                )}
              </div>
            ))}
          </div>
          {!allDone && (
            <div style={{ padding: '12px 22px', display: 'flex', justifyContent: 'flex-end', gap: 8, borderTop: '1px solid var(--hairline)' }}>
              <button className="btn primary" disabled={busy || toAdd === 0} onClick={() => void commitAll()}>
                {busy ? 'Añadiendo…' : toAdd === 1 ? 'Añadir 1 movimiento' : `Añadir ${toAdd} movimientos`}
              </button>
            </div>
          )}
          {allDone && anyAdded && (
            <div style={{ padding: '12px 22px', display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--hairline)' }}>
              <button className="btn primary" onClick={() => go('review')}>Siguiente: revisar <ArrowRight size={16} /></button>
            </div>
          )}
        </div>
      )}

      <div className="broker-grid">
        {BROKERS.map((b) => {
          const have = (history ?? []).filter((h) => h.broker === b.id).map((h) => h.format);
          const missing = b.needs.filter((n) => !have.includes(n.format));
          const started = have.length > 0;
          return (
            <div className="broker" key={b.id}>
              <div className="head">
                <div className={`avatar ${missing.length === 0 ? 'gain' : ''}`}>{missing.length === 0 ? <Check size={18} /> : BROKER_LABEL[b.id].charAt(0)}</div>
                <div>
                  <div className="strong">{BROKER_LABEL[b.id]}</div>
                  <div className="small muted">
                    {missing.length === 0 ? 'Subido' : started ? `Falta: ${missing.map((m) => m.label.toLowerCase()).join(', ')}` : b.needs.length === 1 ? '1 archivo' : `${b.needs.length} archivos`}
                  </div>
                </div>
              </div>
              <Disclosure title={<span className="small">Cómo descargarlo</span>}>
                <ol>{b.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              </Disclosure>
            </div>
          );
        })}
      </div>

      {history && history.length > 0 && (
        <Disclosure card flush title={`Archivos ya subidos (${history.length})`}>
          <div className="list">
            {history.map((h) => (
              <div className="item" key={h.id}>
                <div className="main-col">
                  <div className="title">{h.file}</div>
                  <div className="sub">{BROKER_LABEL[h.broker]} · {h.summary.newOps} movimientos · {new Date(h.at).toLocaleDateString('es-ES')}</div>
                </div>
                <button className="btn small" onClick={() => void undo(h)}>Quitar</button>
              </div>
            ))}
          </div>
        </Disclosure>
      )}
    </>
  );
}

