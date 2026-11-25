import { ArrowDownUp, ChevronRight, RefreshCw, Wallet } from 'lucide-react';
import { useState } from 'react';
import { D, type Decimal } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Broker, type DisposalClass, type Position } from '../../../shared/types.ts';
import { api, ApiError, type PortfolioData } from '../api.ts';
import { Rolling } from '../components/motion.tsx';
import { Callout, Empty, Help, LoadError, Loading, Menu, PageHead, PageProgress, Spinner } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, isinOf, niceName, percent, price, qty, signClass, signed, symbol, units } from '../format.ts';
import { useApi } from '../hooks.ts';
import { isZeroPosition } from '../holdings.ts';

const GROUPS: { id: DisposalClass; label: string }[] = [
  { id: 'stock', label: 'Acciones' }, { id: 'etf', label: 'ETF' }, { id: 'fund', label: 'Fondos' }, { id: 'crypto', label: 'Criptomonedas' },
  { id: 'bond', label: 'Renta fija, ETC y ETN' }, { id: 'other', label: 'Otros' }, { id: 'fx', label: 'Monedas' },
];

const brokerName = (b: string) => (b === 'externo' ? 'Fuera de los brókers' : BROKER_LABEL[b as Broker] ?? b);
const ZERO_KEY = 'cartera-saldos-cero';
const SORT_KEY = 'cartera-orden';
const SORTS = { value: 'Valor', gain: 'Mayor ganancia', loss: 'Mayor pérdida', percent: 'Rentabilidad', name: 'Nombre' } as const;
type Sort = keyof typeof SORTS;

export function Portfolio() {
  const { tick, go, changed, toast } = useApp();
  const { data, error: loadError, reload } = useApi<PortfolioData>('/portfolio', `${tick}`);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Tras actualizar, los importes nuevos entran con un fundido; en la primera carga no.
  const [refreshed, setRefreshed] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showZero, setShowZero] = useState(() => { try { return localStorage.getItem(ZERO_KEY) === '1'; } catch { return false; } });
  const [sort, setSort] = useState<Sort>(() => { try { const s = localStorage.getItem(SORT_KEY); return s && s in SORTS ? s as Sort : 'value'; } catch { return 'value'; } });
  if (!data) return <><PageHead title="Cartera" />{loadError ? <LoadError onRetry={reload} /> : <Loading />}</>;
  const held = data.positions.filter((p) => D(p.quantity).gt(0));
  // Un saldo que se ve como 0 o que no llega a un céntimo no es una posición que interese ver.
  const isZero = (p: Position) => isZeroPosition(p, data.quotes[p.assetId]);
  const zeroCount = held.filter(isZero).length;
  const positions = showZero ? held : held.filter((p) => !isZero(p));
  const toggleZero = (on: boolean) => { setShowZero(on); try { localStorage.setItem(ZERO_KEY, on ? '1' : '0'); } catch { /* Solo para esta visita. */ } };
  const changeSort = (s: Sort) => { setSort(s); try { localStorage.setItem(SORT_KEY, s); } catch { /* Solo para esta visita. */ } };
  if (held.length === 0) {
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
      setRefreshed(true);
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
  // Lo que no tiene precio va al final; sin precio, el valor se ordena por coste.
  const metric = (p: Position): Decimal | null => {
    const v = valueOf(p), cost = D(p.costEur);
    if (sort === 'value') return v;
    if (!v) return null;
    if (sort === 'gain') return v.minus(cost);
    if (sort === 'loss') return cost.minus(v);
    return cost.gt(0) ? v.minus(cost).div(cost) : null;
  };
  const compare = (a: Position, b: Position) => {
    if (sort !== 'name') {
      const ma = metric(a), mb = metric(b);
      if (ma && mb && !ma.eq(mb)) return mb.comparedTo(ma);
      if (!ma !== !mb) return ma ? -1 : 1;
      if (!ma && sort === 'value' && !D(a.costEur).eq(D(b.costEur))) return D(b.costEur).comparedTo(D(a.costEur));
    }
    return niceName(a.assetName).localeCompare(niceName(b.assetName), 'es');
  };

  return (
    <>
      <PageProgress active={busy} label="Actualizando precios" />
      <PageHead title="Cartera" sub={fetched ? `Precios consultados el ${new Date(fetched).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}` : undefined}>
        {zeroCount > 0 && (
          <label className="inline small muted">
            Saldos a cero ({zeroCount})
            <input type="checkbox" role="switch" className="switch" checked={showZero} onChange={(e) => toggleZero(e.target.checked)} />
          </label>
        )}
        <Menu
          className="btn quiet"
          ariaLabel={`Ordenar por ${SORTS[sort].toLowerCase()}`}
          label={<><ArrowDownUp size={15} aria-hidden="true" />{SORTS[sort]}</>}
          items={(Object.keys(SORTS) as Sort[]).map((id) => ({ label: SORTS[id], checked: sort === id, onSelect: () => changeSort(id) }))}
        />
        <button className="btn" disabled={busy} onClick={() => void refresh()}>{busy ? <Spinner /> : <RefreshCw size={15} />} {busy ? 'Actualizando…' : fetched ? 'Actualizar precios' : 'Ver precios actuales'}</button>
      </PageHead>
      {positions.length === 0 && <div className="card"><Empty icon={Wallet} title="Solo quedan saldos a cero" /></div>}
      {error && <Callout tone="error">No se han podido obtener los precios: {error}</Callout>}
      {missing.length > 0 && <Callout tone="warn">Sin precio: {missing.map(niceName).join(', ')}.</Callout>}
      {data.balanceDifferences.length > 0 && (
        <Callout tone="warn">
          No cuadra lo que tienes fuera de los brókers.{' '}
          {data.balanceDifferences.map((p) => `${niceName(p.assetName)}: según tus movimientos tienes ${qty(p.computed)}, pero${p.asOf ? ` el ${dateShort(p.asOf)}` : ''} anotaste como saldo real ${qty(p.declared)}.`).join(' ')}{' '}
          <button className="link" onClick={() => go('review')}>Revisar el saldo</button>
        </Callout>
      )}
      <div className={`stat-grid ${busy ? 'is-refreshing' : ''}`}>
        <div className="stat-card">
          <div className="l">Te ha costado <Help text={HELP.coste} /></div>
          <div className="v">{eur(total)}</div>
        </div>
        {priced.length > 0 && (
          <>
            <div className="stat-card">
              <div className="l">Vale hoy</div>
              <div className="v"><Rolling value={eur(value.toFixed(2))} /></div>
              {noPrice > 0 && <div className="small faint">Sin contar {noPrice} sin precio</div>}
            </div>
            <div className="stat-card">
              <div className="l">Sin realizar <Help text={HELP.latente} /></div>
              <div className={`v ${signClass(latent.toFixed(2))}`}><Rolling value={signed(latent.toFixed(2))} /></div>
            </div>
          </>
        )}
      </div>
      {GROUPS.map((g) => {
        const rows = positions.filter((p) => p.class === g.id).sort(compare);
        if (rows.length === 0) return null;
        return (
          <div className={`card flush ${busy ? 'is-refreshing' : ''}`} key={g.id}>
            <div className="card-title"><h2>{g.label}</h2></div>
            <div className="list">
              {rows.map((p) => {
                const lots = data.lots.filter((l) => l.assetId === p.assetId);
                const isOpen = open === p.assetId;
                const q = quote(p);
                const val = valueOf(p);
                const res = val ? val.minus(D(p.costEur)).toFixed(2) : null;
                const pct = val && D(p.costEur).gt(0) ? val.minus(D(p.costEur)).div(D(p.costEur)).times(100).toFixed() : null;
                const hasRecent = lots.some((l) => l.acqDate.slice(0, 10) >= twoMonthsAgo);
                return (
                  <div key={p.assetId}>
                    <button className="item tap" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : p.assetId)}>
                      <div className="main-col">
                        <div className="title">{niceName(p.assetName)}</div>
                        <div className="sub">{units(p.quantity, p.class, p.assetId)} · {Object.keys(p.byBroker).filter((b) => D(p.byBroker[b]).gt(0)).map(brokerName).join(', ')}</div>
                        {hasRecent && g.id !== 'crypto' && g.id !== 'fx' && <span className="tag warn" style={{ marginTop: 4 }}>Compra reciente</span>}
                      </div>
                      <div className={`end ${refreshed ? 'fade-swap' : ''}`} key={refreshed ? `${res}|${pct}` : 'end'}>
                        {res ? <div className={`amount ${signClass(res)}`}>{signed(res)}</div> : <div className="amount">{eur(D(p.costEur).toFixed(2))}</div>}
                        <div className="sub">{res ? `vale ${eur((val as ReturnType<typeof D>).toFixed(2))}${pct ? ` · ${percent(pct)}` : ''}` : g.id === 'fx' ? 'coste' : 'sin precio'}</div>
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
