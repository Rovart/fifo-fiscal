import { Plus, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BROKER_LABEL, KIND_LABEL, type Broker, type OpKind } from '../../../shared/types.ts';
import type { OpRow } from '../api.ts';
import { KIND_ICON } from '../components/kinds.tsx';
import { Empty, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dayMonth, eur, monthLabel, niceName, price, qty, symbol } from '../format.ts';
import { useApi } from '../hooks.ts';

const FILTERS: { id: string; label: string; kinds?: string; flag?: string }[] = [
  { id: 'all', label: 'Todos' },
  { id: 'buy', label: 'Compras', kinds: 'buy' },
  { id: 'sell', label: 'Ventas', kinds: 'sell' },
  { id: 'income', label: 'Dividendos e intereses', kinds: 'dividend,interest,staking,reward,return_capital' },
  { id: 'other', label: 'Otros', kinds: 'swap,fx,fee,deposit,withdrawal,transfer_in,transfer_out,split,isin_change' },
  { id: 'review', label: 'Con aviso', flag: 'review' },
  { id: 'edited', label: 'Editados', flag: 'edited' },
];

const OUT: OpKind[] = ['buy', 'fee', 'withdrawal'];

function detail(o: OpRow): string {
  if (o.kind === 'swap') return `${qty(o.quantity)} ${o.assetId} → ${qty(o.counterQuantity)} ${o.counterAsset ?? ''}`;
  if (o.kind === 'fx') return `${qty(o.quantity)} ${symbol(o.currency)} → ${qty(o.counterQuantity)} ${symbol(o.counterAsset)}`;
  if ((o.kind === 'buy' || o.kind === 'sell') && o.unitPrice) return `${qty(o.quantity)} × ${price(o.unitPrice)} ${symbol(o.currency)}`;
  if (o.kind === 'staking' || o.kind === 'reward') return `${qty(o.quantity)} ${o.assetId}`;
  if (o.quantity && !o.grossEur) return `${qty(o.quantity)} ${o.assetClass === 'crypto' ? o.assetId : ''}`;
  return '';
}

function amount(o: OpRow): string {
  if (!o.totalEur) return o.quantity ? '' : '—';
  if (['transfer_in', 'transfer_out', 'split', 'isin_change'].includes(o.kind)) return '';
  const out = OUT.includes(o.kind) !== Number(o.totalEur) < 0;
  return `${out ? '−' : '+'}${eur(o.totalEur.replace(/^-/, ''))}`;
}

export function Movements() {
  const { year, tick, openEditor } = useApp();
  const [filter, setFilter] = useState('all');
  const [broker, setBroker] = useState('');
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(100);
  const [deleted, setDeleted] = useState(false);
  useEffect(() => setLimit(100), [year, filter, broker, q, deleted]);

  const f = FILTERS.find((x) => x.id === filter);
  const params = new URLSearchParams();
  // Al buscar, mira en todos los años: es lo que se espera de un buscador.
  if (!q) params.set('year', String(year));
  if (q) params.set('q', q);
  if (broker) params.set('broker', broker);
  if (f?.kinds) params.set('kind', f.kinds);
  if (deleted) params.set('flag', 'deleted');
  else if (f?.flag) params.set('flag', f.flag);
  params.set('limit', String(limit));
  const { data } = useApi<{ total: number; items: OpRow[] }>(`/operations?${params}`, `${tick}`);

  let month = '';
  return (
    <>
      <PageHead title="Movimientos" year>
        <button className="btn primary" onClick={() => openEditor(null)}><Plus size={16} /> Añadir</button>
      </PageHead>
      <div className="chips" role="group" aria-label="Filtrar">
        {FILTERS.map((x) => <button key={x.id} className={`chip ${filter === x.id ? 'on' : ''}`} aria-pressed={filter === x.id} onClick={() => setFilter(x.id)}>{x.label}</button>)}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
          <Search size={16} className="faint" style={{ position: 'absolute', left: 12, top: 12 }} />
          <input className="input" style={{ paddingLeft: 34 }} placeholder="Buscar" aria-label="Buscar activo" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input" style={{ width: 'auto' }} value={broker} onChange={(e) => setBroker(e.target.value)} aria-label="Bróker">
          <option value="">Todos los brókers</option>
          {(Object.keys(BROKER_LABEL) as Broker[]).map((b) => <option key={b} value={b}>{BROKER_LABEL[b]}</option>)}
        </select>
      </div>
      <div className="card flush">
        {data && data.items.length === 0 ? (
          <Empty title={q ? 'Sin resultados' : 'No hay movimientos aquí'} />
        ) : (
          <div className="list">
            {data?.items.map((o) => {
              const m = o.datetime.slice(0, 7);
              const head = m !== month ? monthLabel(o.datetime) : null;
              month = m;
              const Icon = KIND_ICON[o.kind];
              const d = detail(o);
              return (
                <div key={o.id}>
                  {head && <div className="group-label">{head}</div>}
                  <button className="item tap" onClick={() => openEditor(o)}>
                    <div className={`avatar ${o._issue === 'error' ? 'loss' : o._issue === 'warning' ? 'warn' : ''}`}><Icon size={17} /></div>
                    <div className="main-col">
                      <div className="title">{niceName(o.assetName || o.assetId)}{o.counterName && o.kind !== 'fx' ? ` → ${niceName(o.counterName)}` : ''}</div>
                      <div className="sub">{KIND_LABEL[o.kind]} · {BROKER_LABEL[o.broker]} · {dayMonth(o.datetime)}{o.edited ? ' · editado' : ''}</div>
                    </div>
                    {d && <div className="mid">{d}</div>}
                    <div className="end">
                      <div className="amount">{amount(o) || <span className="faint">{o.quantity && !o.totalEur && !['transfer_in', 'transfer_out', 'split', 'isin_change'].includes(o.kind) ? 'Sin precio' : ''}</span>}</div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {data && data.total > data.items.length && (
          <div className="more"><button className="btn small" onClick={() => setLimit(limit + 100)}>Ver más ({data.total - data.items.length})</button></div>
        )}
      </div>
      <div><button className="link muted small" onClick={() => setDeleted(!deleted)}>{deleted ? 'Volver a los movimientos' : 'Ver eliminados'}</button></div>
    </>
  );
}
