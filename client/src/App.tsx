import { BarChart3, Check, CircleHelp, Home as HomeIcon, ListOrdered, Settings as SettingsIcon, Wallet, TrendingUp } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Operation } from '../../shared/types.ts';
import { api, type AppState } from './api.ts';
import { OperationEditor } from './components/OperationEditor.tsx';
import { Ctx, type AppCtx, type Page } from './context.ts';
import { Home } from './pages/Home.tsx';
import { Movements } from './pages/Movements.tsx';
import { Portfolio } from './pages/Portfolio.tsx';
import { Renta } from './pages/Renta.tsx';
import { Results } from './pages/Results.tsx';
import { Review } from './pages/Review.tsx';
import { Settings } from './pages/Settings.tsx';
import { Upload } from './pages/Upload.tsx';
import { Performance } from './pages/Performance.tsx';
import { WhatIf } from './pages/WhatIf.tsx';

const PAGES: Page[] = ['home', 'upload', 'review', 'renta', 'movements', 'portfolio', 'results', 'performance', 'whatif', 'settings'];
const fromHash = (): Page => {
  const h = location.hash.slice(1) as Page;
  return PAGES.includes(h) ? h : 'home';
};

export function App() {
  const [page, setPage] = useState<Page>(fromHash);
  const [state, setState] = useState<AppState | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ op: Operation | null; prefill?: Partial<Operation> } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hadData = useRef(false);

  useEffect(() => {
    api<AppState>('/state')
      .then((s) => {
        setState(s);
        setLoadError(null);
        setYear((y) => {
          // Al llegar los primeros datos, o al abrir: el que sigue a la última Renta presentada o, si no consta, el anterior.
          const first = !hadData.current && s.counts.operations > 0;
          hadData.current = s.counts.operations > 0;
          if (y && s.years.includes(y) && !first) return y;
          const prev = s.settings.lastFiledYear ? s.settings.lastFiledYear + 1 : Number(s.today.slice(0, 4)) - 1;
          return s.years.includes(prev) ? prev : (s.years[s.years.length - 1] as number);
        });
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [tick]);

  useEffect(() => { if (location.hash.slice(1) !== page) location.hash = page; }, [page]);
  useEffect(() => {
    const onHash = () => setPage(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  const ctx: AppCtx | null = useMemo(() => (state && year !== null ? {
    state, year, setYear, tick,
    changed: (m) => { if (m) showToast(m); setTick((t) => t + 1); },
    toast: showToast,
    go: (p) => { setPage(p); window.scrollTo(0, 0); },
    openEditor: (op, prefill) => setEditor({ op, prefill }),
  } : null), [state, year, tick, showToast]);

  if (loadError) return <div className="main"><div className="callout error"><div className="body">No se puede conectar con la aplicación. Vuelve a arrancarla con <code>npm start</code>.</div></div></div>;
  if (!ctx || !state) return null;

  const hasData = state.counts.operations > 0;
  const yearCounts = state.counts.byYear[ctx.year] ?? { errors: 0, warnings: 0 };
  const pending = yearCounts.errors + yearCounts.warnings;
  const NavBtn = ({ id, children }: { id: Page; children: React.ReactNode }) => (
    <button className={`nav-btn ${page === id ? 'on' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => ctx.go(id)}>{children}</button>
  );
  const Step = ({ n, done }: { n: number; done?: boolean }) => (
    <span className={`step-dot ${done ? 'done' : ''}`}>{done ? <Check size={12} strokeWidth={3} /> : n}</span>
  );

  return (
    <Ctx.Provider value={ctx}>
      <div className="layout">
        <nav className="side" aria-label="Secciones">
          <div className="brand"><span className="brand-mark">F</span>FIFO Fiscal</div>
          <NavBtn id="home"><HomeIcon size={18} /> Inicio</NavBtn>
          <div className="nav-group">Tu declaración</div>
          <NavBtn id="upload"><Step n={1} done={hasData} /> Subir datos</NavBtn>
          <NavBtn id="review">
            <Step n={2} done={hasData && pending === 0} /> <span className="grow">Revisar</span>
            {pending > 0 && <span className={`badge ${yearCounts.errors === 0 ? 'soft' : ''}`}>{pending > 99 ? '99+' : pending}</span>}
          </NavBtn>
          <NavBtn id="renta"><Step n={3} /> Mi Renta</NavBtn>
          <div className="nav-group">Consultar</div>
          <NavBtn id="movements"><ListOrdered size={18} /> Movimientos</NavBtn>
          <NavBtn id="portfolio"><Wallet size={18} /> Cartera</NavBtn>
          <NavBtn id="results"><BarChart3 size={18} /> Resultados</NavBtn>
          <NavBtn id="performance"><TrendingUp size={18} /> Desempeño</NavBtn>
          <NavBtn id="whatif"><CircleHelp size={18} /> ¿Y si vendo?</NavBtn>
          <div className="side-foot"><NavBtn id="settings"><SettingsIcon size={18} /> Ajustes</NavBtn></div>
        </nav>
        <main className="main">
          <div className="page">
            {page === 'home' && <Home />}
            {page === 'upload' && <Upload />}
            {page === 'review' && <Review />}
            {page === 'renta' && <Renta />}
            {page === 'movements' && <Movements />}
            {page === 'portfolio' && <Portfolio />}
            {page === 'results' && <Results />}
            {page === 'performance' && <Performance />}
            {page === 'whatif' && <WhatIf />}
            {page === 'settings' && <Settings />}
          </div>
        </main>
        {editor && (
          <OperationEditor
            op={editor.op}
            prefill={editor.prefill}
            onClose={() => setEditor(null)}
            onSaved={(m) => { setEditor(null); ctx.changed(m); }}
          />
        )}
        {toast && <div className="toast" role="status"><Check size={16} /> {toast}</div>}
      </div>
    </Ctx.Provider>
  );
}

