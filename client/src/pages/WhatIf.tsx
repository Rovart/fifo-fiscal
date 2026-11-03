import { ChevronRight, CircleHelp, RefreshCw, RotateCcw } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { D, Decimal, ZERO, isNum } from '../../../shared/decimal.ts';
import type { OpenLot, Position, SaleSimulation, SalesSimulation } from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { LotSlider, lotSegments } from '../components/LotSlider.tsx';
import { Callout, Disclosure, Empty, Help, Loading, NumField, PageHead, Segmented } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { dateShort, eur, isinOf, monthLabel, niceName, price as priceText, qty, signClass, signed, symbol, units } from '../format.ts';
import { HELP } from '../glossary.ts';
import { useApi } from '../hooks.ts';

interface Quote { symbol: string | null; currency: string | null; price: string | null; priceEur: string | null; fetchedAt: string | null }
interface Portfolio { lots: OpenLot[]; positions: Position[]; quotes: Record<string, Quote> }
interface Row { p: Position; lots: OpenLot[]; quote?: Quote; price: string | null; latent: Decimal | null }
type Filter = 'all' | 'loss' | 'gain' | 'picked';

const STORE = 'fifo-whatif';
const stored = (): { picked?: Record<string, string>; prices?: Record<string, string> } => {
  try { return JSON.parse(sessionStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
};

/** Coste de vender esa cantidad, de lo más antiguo a lo más reciente. */
function costOf(lots: OpenLot[], quantity: Decimal): Decimal {
  let left = quantity, cost = ZERO;
  for (const l of lots) {
    if (left.lte(0)) break;
    const lotQty = D(l.quantity), take = Decimal.min(left, lotQty);
    cost = cost.plus(D(l.costEur).times(take).div(lotQty));
    left = left.minus(take);
  }
  return cost;
}

/** Con muchas compras pequeñas, como el staking, se agrupan por mes. */
function groupLots(lots: OpenLot[]) {
  const monthly = lots.length > 12;
  const out: { key: string; label: string; quantity: Decimal; cost: Decimal; upTo: Decimal }[] = [];
  let upTo = ZERO;
  for (const l of lots) {
    upTo = upTo.plus(D(l.quantity));
    const key = monthly ? l.acqDate.slice(0, 7) : l.lotId;
    const last = out[out.length - 1];
    if (last && last.key === key) {
      last.quantity = last.quantity.plus(D(l.quantity));
      last.cost = last.cost.plus(D(l.costEur));
      last.upTo = upTo;
    } else {
      out.push({ key, label: monthly ? monthLabel(l.acqDate) : dateShort(l.acqDate), quantity: D(l.quantity), cost: D(l.costEur), upTo });
    }
  }
  // Los meses con menos de un euro solo añaden ruido: se suman al siguiente.
  return monthly ? out.reduceRight<typeof out>((kept, g) => {
    const next = kept[0];
    if (next && g.cost.lt(1)) { next.quantity = next.quantity.plus(g.quantity); next.cost = next.cost.plus(g.cost); return kept; }
    if (next && next.cost.lt(1)) { g.quantity = g.quantity.plus(next.quantity); g.cost = g.cost.plus(next.cost); g.upTo = next.upTo; kept.shift(); }
    return [g, ...kept];
  }, []) : out;
}

interface RowProps {
  row: Row;
  quantity: string;
  fee: string;
  sale?: SaleSimulation;
  isOpen: boolean;
  /** Plazo ya indicado en el resumen: la fila solo avisa si el suyo es otro. */
  rebuyNote: string | null;
  onQuantity: (assetId: string, quantity: string) => void;
  onPrice: (assetId: string, price: string) => void;
  onToggle: (assetId: string) => void;
}

const AssetRow = memo(function AssetRow({ row, quantity, fee, sale, isOpen, rebuyNote, onQuantity, onPrice, onToggle }: RowProps) {
  const { p, lots, quote, price, latent } = row;
  const px = price ? D(price) : null;
  const total = D(p.quantity);
  const chosen = Decimal.min(D(quantity), total);
  const picked = chosen.gt(0) && !!px;
  const segments = useMemo(() => lotSegments(lots, px), [lots, price]);
  const name = niceName(p.assetName);
  const held = units(p.quantity, p.class, p.assetId);
  const proceeds = px ? px.times(chosen).minus(picked ? D(fee || 0) : 0) : ZERO;
  const gain = picked ? proceeds.minus(costOf(lots, chosen)).toFixed(2) : '0';
  const setQuantity = (v: string) => onQuantity(p.assetId, isNum(v) ? Decimal.max(0, Decimal.min(D(v), total)).toFixed() : '0');
  const info = [isinOf(p.assetId), quote?.price ? `${quote.symbol}: ${priceText(quote.price)} ${symbol(quote.currency)}` : null].filter(Boolean).join(' · ');
  const showSale = picked && !!sale;
  const ownRebuy = showSale && D(gain).lt(0) && sale.safeRebuyFrom && sale.safeRebuyFrom !== rebuyNote ? sale.safeRebuyFrom : null;
  return (
    <div className={`sell-row ${picked ? 'on' : ''}`}>
      <button className="sell-name" aria-expanded={isOpen} onClick={() => onToggle(p.assetId)}>
        <span className="title"><span className="text" title={name}>{name}</span><ChevronRight size={14} className={`chevron ${isOpen ? 'open' : ''}`} /></span>
        <span className="sub">{picked ? `${qty(chosen.toFixed())} de ${held}` : held}</span>
      </button>
      <div className="sell-slider">
        <LotSlider
          segments={segments}
          total={total}
          value={chosen}
          disabled={!px}
          label={`Cantidad de ${name} a vender`}
          valueText={`${qty(chosen.toFixed())} de ${held}`}
          onChange={(v) => onQuantity(p.assetId, v)}
        />
      </div>
      <div className="sell-result">
        {!px && <button className="link small" onClick={() => onToggle(p.assetId)}>Poner precio</button>}
        {px && picked && <><div className={`amount ${signClass(gain)}`}>{signed(gain)}</div><div className="sub">cobras {eur(proceeds.toFixed(2))}</div></>}
        {px && !picked && <><div className="amount faint">{signed((latent ?? ZERO).toFixed(2))}</div><div className="sub">vale {eur(px.times(total).toFixed(2))}</div></>}
      </div>
      {showSale && (D(sale.deferredEur).gt(0) || D(sale.releasedEur).gt(0) || ownRebuy) && (
        <div className="sell-tags">
          {D(sale.deferredEur).gt(0) && <span className="tag warn">{eur(sale.deferredEur)} se aplazan</span>}
          {D(sale.releasedEur).gt(0) && <span className="tag gain">Libera {eur(sale.releasedEur)} aplazados</span>}
          {ownRebuy && <span className="tag">Sin recomprar hasta el {dateShort(ownRebuy)}</span>}
        </div>
      )}
      {isOpen && (
        <div className="sell-detail">
          <div className="sell-fields">
            <NumField label="Cantidad" placeholder="0" value={chosen.gt(0) ? chosen.toFixed() : ''} onChange={setQuantity} />
            <NumField label="Precio en €" placeholder="0,00" value={px ? px.toDecimalPlaces(4).toFixed() : ''} onChange={(v) => onPrice(p.assetId, v)} />
          </div>
          {info && <div className="small faint">{info}</div>}
          <div className="lot-rows">
            {groupLots(lots).map((l) => {
              const res = px ? px.times(l.quantity).minus(l.cost).toFixed(2) : null;
              return (
                <button key={l.key} className={`lot-row ${chosen.gte(l.upTo) ? 'on' : ''}`} title="Vender hasta aquí" onClick={() => setQuantity(l.upTo.toFixed())}>
                  <span>{l.label}</span>
                  <span className="num muted">{qty(l.quantity.toFixed())}</span>
                  {res && <span className={`num ${signClass(res)}`}>{signed(res)}</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
});

/** El plazo más habitual entre las ventas con pérdida: el mismo para casi todas. */
const commonRebuy = (sim: SalesSimulation | null): string | null =>
  sim?.sales.filter((s) => D(s.gainEur).lt(0) && s.safeRebuyFrom).map((s) => s.safeRebuyFrom as string).sort()[0] ?? null;

function Summary({ sim, busy, active }: { sim: SalesSimulation; busy: boolean; active: boolean }) {
  const delta = D(sim.payAfter).minus(D(sim.payBefore));
  const useful = D(sim.usefulLossEur);
  const width = useful.gt(0) ? D(sim.usedLossEur).div(useful).times(100).toNumber() : 0;
  const rebuy = commonRebuy(sim);
  return (
    <div className={`card sim-panel ${busy ? 'busy' : ''}`} role="status">
      <div className="sim-main">
        <div className="sim-pay">
          <div className="hero-label">{active ? 'Pagarías' : 'A pagar'} en {sim.year}</div>
          <div className="sim-value num">{eur(active ? sim.payAfter : sim.payBefore)}</div>
        </div>
        {active && !delta.isZero() && (
          <div className={`sim-delta ${delta.lt(0) ? 'gain' : 'loss'}`}>{delta.lt(0) ? `Ahorras ${eur(delta.abs().toFixed(2))}` : `${eur(delta.toFixed(2))} más`}</div>
        )}
      </div>
      <div className="sim-stats">
        <div><span>Cobrarías</span><b className="num">{eur(sim.proceedsEur)}</b></div>
        <div><span>Resultado</span><b className={`num ${signClass(sim.gainEur)}`}>{signed(sim.gainEur)}</b></div>
        <div><span>Se aplaza <Help text={HELP.aplazada} /></span><b className="num">{eur(sim.deferredEur)}</b></div>
      </div>
      <div className="sim-note small muted">
        {!active && 'Mueve una barra para probar una venta.'}
        {active && rebuy && `Si recompras antes del ${dateShort(rebuy)}, la pérdida se aplaza.`}
      </div>
      {useful.gt(0) && (
        <div className="sim-meter">
          <div className="sim-meter-head small">
            <span className="inline muted">Pérdida aprovechada <Help text={HELP.perdidaUtil} /></span>
            <span className="num">{D(sim.extraLossEur).gt(0) ? `+${eur(sim.extraLossEur)} para otros años` : `${eur(sim.usedLossEur)} de ${eur(sim.usefulLossEur)}`}</span>
          </div>
          <div className="sim-meter-bar"><i style={{ width: `${width}%` }} /></div>
        </div>
      )}
    </div>
  );
}

export function WhatIf() {
  const { state, tick, go, changed, toast } = useApp();
  const { data, reload } = useApi<Portfolio>('/portfolio', `${tick}`);
  const [picked, setPicked] = useState<Record<string, string>>(() => stored().picked ?? {});
  const [prices, setPrices] = useState<Record<string, string>>(() => stored().prices ?? {});
  const [fee, setFee] = useState('0');
  const [date, setDate] = useState(state.today);
  const [filter, setFilter] = useState<Filter>('all');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [sim, setSim] = useState<SalesSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [missing, setMissing] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const rows = useMemo<Row[]>(() => (data?.positions ?? [])
    .filter((p) => p.class !== 'fx' && D(p.quantity).gt(0))
    .map((p) => {
      const quote = data?.quotes[p.assetId];
      const price = prices[p.assetId] || quote?.priceEur || null;
      // El orden sale del precio de mercado: una fila no se mueve mientras escribes en ella.
      const latent = quote?.priceEur ? D(quote.priceEur).times(D(p.quantity)).minus(D(p.costEur)) : null;
      return { p, lots: data?.lots.filter((l) => l.assetId === p.assetId) ?? [], quote, price, latent };
    })
    .sort((a, b) => (a.latent && b.latent ? a.latent.minus(b.latent).toNumber() : a.latent ? -1 : b.latent ? 1 : a.p.assetName.localeCompare(b.p.assetName))), [data, prices]);

  const sales = useMemo(() => rows.flatMap(({ p, price }) => {
    const q = Decimal.min(D(picked[p.assetId] ?? 0), D(p.quantity));
    return q.gt(0) && price ? [{ assetId: p.assetId, quantity: q.toFixed(), priceEur: price, feeEur: fee || '0' }] : [];
  }), [rows, picked, fee]);
  const request = JSON.stringify({ sales, date });

  useEffect(() => {
    if (!data) return;
    const id = ++latest.current;
    setBusy(true);
    const t = setTimeout(() => {
      api<SalesSimulation>('/simulate', { method: 'POST', body: { sales, date } })
        .then((r) => { if (id === latest.current) { setSim(r); setError(null); setBusy(false); } })
        .catch((e) => { if (id === latest.current) { setError(e instanceof ApiError ? e.message : String(e)); setBusy(false); } });
    }, 120);
    return () => clearTimeout(t);
  }, [request, !!data, tick]);

  useEffect(() => {
    try { sessionStorage.setItem(STORE, JSON.stringify({ picked, prices })); } catch { /* Sin almacenamiento solo se pierde la selección al cambiar de pestaña. */ }
  }, [picked, prices]);

  const onQuantity = useCallback((id: string, v: string) => setPicked((m) => ({ ...m, [id]: v })), []);
  const onPrice = useCallback((id: string, v: string) => setPrices((m) => ({ ...m, [id]: v })), []);
  const onToggle = useCallback((id: string) => setOpen((o) => (o === id ? null : id)), []);

  const bySale = useMemo(() => new Map(sim?.sales.map((s) => [s.assetId, s])), [sim]);
  const rebuyNote = commonRebuy(sim);

  if (!data) return <><PageHead title="¿Y si vendo?" /><Loading /></>;
  if (rows.length === 0) {
    return (
      <>
        <PageHead title="¿Y si vendo?" />
        <div className="card"><Empty icon={CircleHelp} title="Aún no hay nada que vender"><button className="btn primary" onClick={() => go('upload')}>Subir mis extractos</button></Empty></div>
      </>
    );
  }

  const refresh = async () => {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  };
  const chooseFilter = (f: Filter) => {
    setFilter(f);
    // Se fija al entrar: una fila no desaparece mientras bajas su barra a cero.
    if (f === 'picked') setPickedIds(new Set(sales.map((s) => s.assetId)));
  };
  const visible = rows.filter(({ p, latent }) => {
    if (filter === 'loss') return !!latent?.lt(0);
    if (filter === 'gain') return !!latent?.gte(0);
    if (filter === 'picked') return pickedIds.has(p.assetId);
    return true;
  });
  const fetched = Object.values(data.quotes).map((q) => q.fetchedAt).filter(Boolean).sort().pop();
  const updated = fetched ? ` Precios del ${new Date(fetched).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })}.` : '';

  return (
    <>
      <PageHead title="¿Y si vendo?" sub={`No se guarda nada.${updated}`}>
        <button className={`btn ${fetched ? '' : 'primary'}`} disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15} /> {refreshing ? 'Buscando…' : 'Actualizar precios'}</button>
      </PageHead>
      {error && <Callout tone="error">{error}</Callout>}
      {missing.length > 0 && <Callout tone="warn">Sin precio: {missing.map(niceName).join(', ')}.</Callout>}
      {sim ? <Summary sim={sim} busy={busy} active={sales.length > 0} /> : <Loading />}
      <div className="sim-bar">
        <Segmented
          label="Filtrar activos"
          value={filter}
          onChange={chooseFilter}
          options={[{ id: 'all', label: 'Todos' }, { id: 'loss', label: 'Pérdida' }, { id: 'gain', label: 'Ganancia' }, { id: 'picked', label: sales.length ? `Elegidos ${sales.length}` : 'Elegidos' }]}
        />
        <div className="sim-legend small muted">
          <span className="lot-dot loss" /> En pérdida
          <span className="lot-dot gain" /> En ganancia
          <Help text={HELP.barra} />
          {sales.length > 0 && <button className="btn quiet small" onClick={() => { setPicked({}); setFilter('all'); }}><RotateCcw size={13} /> Borrar</button>}
        </div>
      </div>
      <div className="card flush sell-list">
        {visible.map((row) => (
          <AssetRow
            key={row.p.assetId}
            row={row}
            quantity={picked[row.p.assetId] ?? '0'}
            fee={fee}
            sale={bySale.get(row.p.assetId)}
            isOpen={open === row.p.assetId}
            rebuyNote={rebuyNote}
            onQuantity={onQuantity}
            onPrice={onPrice}
            onToggle={onToggle}
          />
        ))}
        {visible.length === 0 && <div className="item muted small">{filter === 'picked' ? 'Aún no has elegido nada.' : 'Nada por aquí.'}</div>}
      </div>
      <Disclosure title={<span className="small">Fecha y comisión</span>}>
        <div className="form-grid" style={{ maxWidth: 380 }}>
          <label className="field"><span>Fecha</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <NumField label="Comisión por venta (€)" value={fee} onChange={setFee} />
        </div>
      </Disclosure>
    </>
  );
}
