import { ArrowDown, ArrowUpRight, RefreshCw, Wallet, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type PortfolioData } from '../api.ts';
import { useApp } from '../context.ts';
import { eur, niceName, percent, qty, signClass, units } from '../format.ts';
import { holdings } from '../holdings.ts';
import { useApi } from '../hooks.ts';
import { Empty, Help, Loading } from './ui.tsx';

export function HoldingsPanel({ onClose }: { onClose: () => void }) {
  const { state, tick, changed, go } = useApp();
  const { data, error, reload } = useApi<PortfolioData>('/portfolio', tick);
  const [busy, setBusy] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { closeButton.current?.focus(); }, []);

  const portfolio = data ? holdings(data.positions, data.quotes, state.assets) : null;
  const fetched = portfolio?.rows.map((row) => data?.quotes[row.position.assetId]?.fetchedAt).filter((at): at is string => !!at).sort().pop();
  const updated = fetched ? new Date(fetched).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  const refresh = async () => {
    setBusy(true);
    setRefreshFailed(false);
    try {
      await api('/quotes/refresh', { method: 'POST' });
      changed();
    } catch {
      setRefreshFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside id="holdings-panel" className="holdings-panel" role="dialog" aria-modal="false" aria-labelledby="holdings-title" onKeyDown={(e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); onClose(); }
    }}>
      <header className="holdings-head">
        <Wallet size={19} className="muted" />
        <h2 id="holdings-title">Mi cartera</h2>
        <button ref={closeButton} className="btn quiet icon" aria-label="Cerrar cartera" onClick={onClose}><X size={19} /></button>
      </header>
      <div className="holdings-body" aria-busy={busy}>
        {error && <div className="holdings-message" role="alert"><p>No se pudo cargar la cartera.</p><button className="btn small" onClick={reload}>Reintentar</button></div>}
        {!data && !error && <Loading />}
        {portfolio && portfolio.rows.length === 0 && <Empty icon={Wallet} title="Aún no tienes posiciones"><button className="btn small" onClick={() => go('upload')}>Subir CSV</button></Empty>}
        {portfolio && portfolio.rows.length > 0 && <>
          <div className="holdings-summary">
            <div className="small muted">{portfolio.unpriced > 0 && portfolio.valueEur !== null ? 'Valor parcial' : 'Valor actual'}</div>
            <div className="holdings-total">
              <strong>{eur(portfolio.valueEur)}</strong>
              {portfolio.gainPercent !== null && <span className={`holdings-return ${signClass(portfolio.gainPercent)}`} title="Ganancia o pérdida total de las posiciones que conservas">{percent(portfolio.gainPercent)}</span>}
            </div>
            {portfolio.unpriced > 0 && <div className="small muted">{portfolio.unpriced} {portfolio.unpriced === 1 ? 'activo sin precio' : 'activos sin precio'}</div>}
          </div>
          <table className="holdings-table">
            <caption className="sr-only">Posiciones actuales según los movimientos importados, sumadas entre brókers.</caption>
            <thead><tr><th scope="col">Activo<span className="sr-only"> y cantidad</span></th><th scope="col" aria-sort="descending"><span className="inline">Total <ArrowDown size={12} aria-hidden="true" /> <Help text="Valor actual de cada posición en euros, de mayor a menor. Debajo, su ganancia o pérdida frente al coste de las unidades que conservas. No incluye ventas ni dividendos. — indica que falta el precio o el coste." /></span></th></tr></thead>
            <tbody>{portfolio.rows.map(({ position: p, ticker, valueEur, gainPercent }) => (
              <tr key={p.assetId}>
                <th scope="row" title={`${niceName(p.assetName)} · ${p.assetId}`}>
                  <span className="holdings-symbol">{ticker ? `$${ticker}` : niceName(p.assetName)}</span>
                  <span className="holdings-name" title={p.quantity} aria-label={units(p.quantity, p.class, p.assetId)}>{qty(p.quantity)} {p.class === 'crypto' ? p.assetId : 'uds.'}</span>
                </th>
                <td className="num">
                  <span className="holdings-value" title={valueEur === null ? 'Sin precio disponible' : 'Valor actual en euros'}>{eur(valueEur)}</span>
                  <span className={`holdings-gain ${signClass(gainPercent)}`} title={gainPercent === null ? 'Sin precio o coste disponible' : 'Ganancia o pérdida sin vender'}>{gainPercent === null ? '—' : percent(gainPercent)}</span>
                </td>
              </tr>
            ))}</tbody>
          </table>
          {refreshFailed && <p className="small loss holdings-error" role="alert">No se pudieron actualizar los precios. Inténtalo de nuevo.</p>}
        </>}
      </div>
      {portfolio && portfolio.rows.length > 0 && <footer className="holdings-foot">
        <div className="holdings-prices">
          <span className="small muted">{updated ? `Precios: ${updated}` : 'Sin precios actuales'}</span>
          <button className="btn quiet small" aria-label={busy ? 'Actualizando precios' : 'Actualizar precios'} disabled={busy} onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" className={busy ? 'holdings-refreshing' : undefined} /> {busy ? 'Actualizando…' : 'Actualizar'}</button>
        </div>
        <button className="link small inline" onClick={() => go('portfolio')}>Ver detalle <ArrowUpRight size={14} /></button>
      </footer>}
    </aside>
  );
}
