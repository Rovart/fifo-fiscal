import { ChevronRight, RefreshCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import { D } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type DisposalClass, type OpenLot, type Position } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { Callout, Empty, Help, Loading, PageHead } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, initial, isinOf, niceName, price, qty, signClass, signed, symbol, units } from '../format.ts';
import { useApi } from '../hooks.ts';

const GROUPS: { id: DisposalClass; label: string }[] = [
  { id: 'stock', label: 'Acciones' }, { id: 'etf', label: 'ETF' }, { id: 'fund', label: 'Fondos' }, { id: 'crypto', label: 'Criptomonedas' },
  { id: 'bond', label: 'Renta fija y ETC' }, { id: 'other', label: 'Otros' }, { id: 'fx', label: 'Monedas' },
];

const brokerName = (b: string) => (b === 'externo' ? 'Fuera de los brókers' : BROKER_LABEL[b as Broker] ?? b);

interface Quote { symbol: string | null; currency: string | null; price: string | null; priceEur: string | null; at: string | null; fetchedAt: string | null }

export function Portfolio() {
  const { tick, go, changed, toast } = useApp();
  const { data, reload } = useApi<{ lots: OpenLot[]; positions: Position[]; quotes: Record<string, Quote>; brokerNames: Record<string, { broker: Broker; name: string }[]>; today: string }>('/portfolio', `${tick}`);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <><PageHead title="Cartera" /><Loading /></>;
  const positions = data.positions.filter((p) => D(p.quantity).gt(0));
  if (positions.length === 0) {
    return (
      <>
        <PageHead title="Cartera" />
        <div className="card"><Empty icon={Wallet} title="Aún no hay nada en cartera"><button className="btn primary" onClick={() => go('upload')}>Subir mis extractos</button></Empty></div>
      </>
    );
  }
  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ updated: number; missing: string[] }>('/quotes/refresh', { method: 'POST' });
      setMissing(r.missing);
      reload();
      toast(`${r.updated} precios actualizados`);
      changed();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const quote = (p: Position) => (p.class === 'fx' ? undefined : data.quotes[p.assetId]);
  const valueOf = (p: Position) => { const q = quote(p); return q?.priceEur ? D(p.quantity).times(D(q.priceEur)) : null; };
  const priced = positions.filter((p) => valueOf(p));
  const total = positions.filter((p) => p.class !== 'fx').reduce((s, p) => s.plus(D(p.costEur)), D(0)).toFixed(2);
  const value = priced.reduce((s, p) => s.plus(valueOf(p) ?? 0), D(0));
  const latent = priced.reduce((s, p) => s.plus((valueOf(p) ?? D(0)).minus(D(p.costEur))), D(0));
  const fetched = Object.values(data.quotes).map((q) => q.fetchedAt).filter(Boolean).sort().pop();
  const twoMonthsAgo = (() => { const d = new Date(`${data.today}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 2); return d.toISOString().slice(0, 10); })();
  const noPrice = positions.filter((p) => p.class !== 'fx' && !valueOf(p)).length;

  return (
    <>
      <PageHead title="Cartera" sub={fetched ? `Precios de Yahoo del ${new Date(fetched).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : undefined}>
        <button className="btn" disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} /> {busy ? 'Buscando…' : fetched ? 'Actualizar precios' : 'Ver precios actuales'}</button>
      </PageHead>
      {error && <Callout tone="error">No se han podido obtener los precios: {error}</Callout>}
      {missing.length > 0 && <Callout tone="warn">Sin precio: {missing.map(niceName).join(', ')}.</Callout>}
      <div className="stat-grid">
        <div className="stat-card">
          <div className="l">Te ha costado <Help text={HELP.coste} /></div>
          <div className="v">{eur(total)}</div>
        </div>
        {priced.length > 0 && (
          <>
            <div className="stat-card">
              <div className="l">Vale hoy</div>
              <div className="v">{eur(value.toFixed(2))}</div>
              {noPrice > 0 && <div className="small faint">Sin contar {noPrice} sin precio</div>}
            </div>
            <div className="stat-card">
              <div className="l">Sin realizar <Help text={HELP.latente} /></div>
              <div className={`v ${signClass(latent.toFixed(2))}`}>{signed(latent.toFixed(2))}</div>
            </div>
          </>
        )}
      </div>
      {GROUPS.map((g) => {
        const rows = positions.filter((p) => p.class === g.id).sort((a, b) => {
          const la = valueOf(a), lb = valueOf(b);
          if (!la || !lb) return la ? -1 : lb ? 1 : a.assetName.localeCompare(b.assetName);
          return la.minus(D(a.costEur)).minus(lb.minus(D(b.costEur))).toNumber();
        });
        if (rows.length === 0) return null;
        return (
          <div className="card flush" key={g.id}>
            <div className="card-title"><h2>{g.label}</h2></div>
            <div className="list">
              {rows.map((p) => {
                const lots = data.lots.filter((l) => l.assetId === p.assetId);
                const isOpen = open === p.assetId;
                const q = quote(p);
                const val = valueOf(p);
                const res = val ? val.minus(D(p.costEur)).toFixed(2) : null;
                const hasRecent = lots.some((l) => l.acqDate.slice(0, 10) >= twoMonthsAgo);
                return (
                  <div key={p.assetId}>
                    <button className="item tap" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.assetId)}>
                      <div className="avatar">{initial(p.assetName)}</div>
                      <div className="main-col">
                        <div className="title">{niceName(p.assetName)}</div>
                        <div className="sub">{units(p.quantity, p.class, p.assetId)} · {Object.keys(p.byBroker).filter((b) => D(p.byBroker[b]).gt(0)).map(brokerName).join(', ')}</div>
                        {hasRecent && g.id !== 'crypto' && g.id !== 'fx' && <span className="tag warn" style={{ marginTop: 4 }}>Compra reciente</span>}
                      </div>
                      <div className="end">
                        {res ? <div className={`amount ${signClass(res)}`}>{signed(res)}</div> : <div className="amount">{eur(D(p.costEur).toFixed(2))}</div>}
                        <div className="sub">{res ? `vale ${eur((val as ReturnType<typeof D>).toFixed(2))}` : g.id === 'fx' ? 'coste' : 'sin precio'}</div>
                      </div>
                      <ChevronRight size={16} className={`chevron ${isOpen ? 'open' : ''}`} />
                    </button>
                    {isOpen && (
                      <div className="expand">
                        {(isinOf(p.assetId) || q?.price) && (
                          <div className="small muted" style={{ marginBottom: 6 }}>
                            {isinOf(p.assetId)}{isinOf(p.assetId) && q?.price ? ' · ' : ''}
                            {q?.price && <>{q.symbol}: {price(q.price)} {symbol(q.currency)}{q.currency !== 'EUR' && q.priceEur ? ` (${price(D(q.priceEur).toDecimalPlaces(4).toFixed())} €)` : ''}</>}
                          </div>
                        )}
                        {data.brokerNames[p.assetId]?.map((n) => <div className="small muted" style={{ marginBottom: 6 }} key={`${n.broker}${n.name}`}>En {BROKER_LABEL[n.broker]}: {n.name}</div>)}
                        <div className="small muted inline" style={{ marginBottom: 6 }}>Orden en que se venderán <Help text={HELP.fifo} /></div>
                        <table className="mini-table">
                          <tbody>
                            {lots.map((l, i) => {
                              const lotRes = q?.priceEur ? D(l.quantity).times(D(q.priceEur)).minus(D(l.costEur)).toFixed(2) : null;
                              const recent = l.acqDate.slice(0, 10) >= twoMonthsAgo && g.id !== 'crypto' && g.id !== 'fx';
                              return (
                                <tr key={l.lotId}>
                                  <td style={{ width: 28 }} className="faint">{i + 1}.</td>
                                  <td>
                                    {dateShort(l.acqDate)}
                                    {recent && <> <span className="tag warn inline">Reciente <Help text={HELP.reciente} /></span></>}
                                    {D(l.blockedQuantity).gt(0) && <> <span className="tag warn">Pérdida aplazada</span></>}
                                  </td>
                                  <td className="r">{qty(l.quantity)}</td>
                                  <td className={`r ${lotRes ? 'wide-only' : ''}`}>{eur(D(l.costEur).toFixed(2))}</td>
                                  {lotRes && <td className={`r ${signClass(lotRes)}`}>{signed(lotRes)}</td>}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </>
  );
}
