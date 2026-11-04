import { BarChart3, Check, CircleHelp, Coins, Home, ListOrdered, Settings, TrendingUp, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { useApp, type Page } from '../context.ts';

function NavLink({ id, page, onNavigate, children }: { id: Page; page: Page; onNavigate: (page: Page) => void; children: ReactNode }) {
  return <a className={`nav-btn ${page === id ? 'on' : ''}`} href={`#${id}`} aria-current={page === id ? 'page' : undefined} onClick={(e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    onNavigate(id);
  }}>{children}</a>;
}

function Step({ n, done }: { n: number; done?: boolean }) {
  return <span className={`step-dot ${done ? 'done' : ''}`} aria-hidden="true">{done ? <Check size={12} strokeWidth={3} /> : n}</span>;
}

export function NavigationLinks({ page, onNavigate, children }: { page: Page; onNavigate: (page: Page) => void; children?: ReactNode }) {
  const { state, year } = useApp();
  const hasData = state.counts.operations > 0;
  const counts = state.counts.byYear[year] ?? { errors: 0, warnings: 0 };
  const pending = counts.errors + counts.warnings;
  const link = { page, onNavigate };
  return <>
    <NavLink id="home" {...link}><Home size={18} aria-hidden="true" /> Inicio</NavLink>
    <div className="nav-group">Tu declaración</div>
    <NavLink id="upload" {...link}><Step n={1} done={hasData} /> Documentos</NavLink>
    <NavLink id="review" {...link}>
      <Step n={2} done={hasData && pending === 0} /><span className="grow">Revisar</span>
      {pending > 0 && <span className={`badge ${counts.errors === 0 ? 'soft' : ''}`} aria-label={`${pending} avisos pendientes`}>{pending > 99 ? '99+' : pending}</span>}
    </NavLink>
    <NavLink id="renta" {...link}><Step n={3} /> Mi Renta</NavLink>
    <div className="nav-group">Consultar</div>
    <NavLink id="movements" {...link}><ListOrdered size={18} aria-hidden="true" /> Movimientos</NavLink>
    <NavLink id="portfolio" {...link}><Wallet size={18} aria-hidden="true" /> Cartera</NavLink>
    <NavLink id="results" {...link}><BarChart3 size={18} aria-hidden="true" /> Resultados</NavLink>
    <NavLink id="dividends" {...link}><Coins size={18} aria-hidden="true" /> Dividendos</NavLink>
    <NavLink id="performance" {...link}><TrendingUp size={18} aria-hidden="true" /> Desempeño</NavLink>
    <NavLink id="whatif" {...link}><CircleHelp size={18} aria-hidden="true" /> ¿Y si vendo?</NavLink>
    <div className="side-foot">{children}<NavLink id="settings" {...link}><Settings size={18} aria-hidden="true" /> Ajustes</NavLink></div>
  </>;
}
