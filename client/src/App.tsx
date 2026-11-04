import { Check, Menu, PanelRightOpen, Wallet } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Operation } from '../../shared/types.ts';
import { api, getProfileId, selectProfile, type AppState } from './api.ts';
import { ProfileSwitcher } from './components/ProfileSwitcher.tsx';
import { OperationEditor } from './components/OperationEditor.tsx';
import { HoldingsPanel } from './components/HoldingsPanel.tsx';
import { NavigationLinks } from './components/NavigationLinks.tsx';
import { Dialog } from './components/ui.tsx';
import { Ctx, type AppCtx, type Page } from './context.ts';
import { Dividends } from './pages/Dividends.tsx';
import { Dossier } from './pages/Dossier.tsx';
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

const PAGES: Page[] = ['home', 'upload', 'review', 'renta', 'movements', 'portfolio', 'results', 'dividends', 'performance', 'whatif', 'settings', 'dossier'];
const fromHash = (): Page => {
  const h = location.hash.slice(1) as Page;
  return PAGES.includes(h) ? h : 'home';
};

export function App() {
  const [profileId, setProfileId] = useState(getProfileId);
  const switchProfile = useCallback((id: string) => { selectProfile(id); setProfileId(id); }, []);
  return <ProfileApp key={profileId} profileId={profileId} switchProfile={switchProfile} />;
}

function ProfileApp({ profileId, switchProfile }: { profileId: string; switchProfile: (id: string) => void }) {
  const [page, setPage] = useState<Page>(fromHash);
  const [state, setState] = useState<AppState | null>(null);
  const [year, setYear] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ op: Operation | null; prefill?: Partial<Operation> } | null>(null);
  const [holdingsOpen, setHoldingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const holdingsOpener = useRef<HTMLElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hadData = useRef(false);

  useEffect(() => {
    let active = true;
    api<AppState>('/state', { profileId })
      .then((s) => {
        if (!active) return;
        setState(s);
        setLoadError(null);
        setYear((y) => {
          // Al abrir, usa el ejercicio actual; conserva la elección durante la sesión.
          const first = !hadData.current && s.counts.operations > 0;
          hadData.current = s.counts.operations > 0;
          if (y && s.years.includes(y) && !first) return y;
          const current = Number(s.today.slice(0, 4));
          return s.years.includes(current) ? current : (s.years[s.years.length - 1] as number);
        });
      })
      .catch((e: Error) => { if (active) setLoadError(e.message); });
    return () => { active = false; };
  }, [tick, profileId]);

  useEffect(() => {
    if (!state?.resolving) return;
    const timer = setTimeout(() => setTick((t) => t + 1), 1000);
    return () => clearTimeout(timer);
  }, [state]);

  useEffect(() => { if (location.hash.slice(1) !== page) location.hash = page; }, [page]);
  useEffect(() => {
    const onHash = () => setPage(fromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const wide = window.matchMedia('(min-width: 821px)');
    const closeMenu = () => { if (wide.matches) setMenuOpen(false); };
    wide.addEventListener('change', closeMenu);
    return () => wide.removeEventListener('change', closeMenu);
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
    switchProfile,
  } : null), [state, year, tick, showToast, switchProfile]);

  if (loadError) return <div className="main"><div className="callout error"><div className="body">{loadError}</div><button className="btn" onClick={() => profileId !== 'default' ? switchProfile('default') : setTick((t) => t + 1)}>Volver a intentar</button></div></div>;
  if (!ctx || !state) return null;

  const navigate = (next: Page) => { ctx.go(next); setMenuOpen(false); };
  const toggleHoldings = (opener: HTMLElement) => { holdingsOpener.current = opener; setHoldingsOpen((open) => !open); };

  return (
    <Ctx.Provider value={ctx}>
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>Saltar al contenido</a>
      <div className={`layout${holdingsOpen ? ' with-holdings' : ''}`}>
        <header className="mobile-bar no-print">
          <button className="btn quiet icon" aria-label="Abrir menú" aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Menu size={21} aria-hidden="true" /></button>
          <a className="mobile-brand" href="#home" onClick={(e) => { e.preventDefault(); navigate('home'); }}><span className="brand-mark" aria-hidden="true">F</span> FIFO Fiscal</a>
          <button className="btn quiet icon" aria-label="Mi cartera" aria-haspopup="dialog" aria-expanded={holdingsOpen} aria-controls={holdingsOpen ? 'holdings-panel' : undefined} onClick={(e) => toggleHoldings(e.currentTarget)}><Wallet size={21} aria-hidden="true" /></button>
        </header>
        <nav className="side" aria-label="Secciones">
          <div className="brand"><span className="brand-mark">F</span>FIFO Fiscal</div>
          <ProfileSwitcher />
          <NavigationLinks page={page} onNavigate={navigate}>
            <button className="nav-btn holdings-launcher" aria-haspopup="dialog" aria-expanded={holdingsOpen} aria-controls={holdingsOpen ? 'holdings-panel' : undefined} onClick={(e) => toggleHoldings(e.currentTarget)}><PanelRightOpen size={18} aria-hidden="true" /> Mi cartera</button>
          </NavigationLinks>
        </nav>
        <main id="main-content" className="main" tabIndex={-1}>
          <div className="page">
            {page === 'home' && <Home />}
            {page === 'upload' && <Upload />}
            {page === 'review' && <Review />}
            {page === 'renta' && <Renta />}
            {page === 'movements' && <Movements />}
            {page === 'portfolio' && <Portfolio />}
            {page === 'results' && <Results />}
            {page === 'dividends' && <Dividends />}
            {page === 'performance' && <Performance />}
            {page === 'whatif' && <WhatIf />}
            {page === 'settings' && <Settings />}
            {page === 'dossier' && <Dossier />}
          </div>
        </main>
        {holdingsOpen && <HoldingsPanel onClose={() => {
          setHoldingsOpen(false);
          requestAnimationFrame(() => holdingsOpener.current?.focus());
        }} />}
        {menuOpen && <Dialog title="FIFO Fiscal" className="navigation-dialog" onClose={() => setMenuOpen(false)}>
          <ProfileSwitcher />
          <nav className="mobile-navigation" aria-label="Secciones"><NavigationLinks page={page} onNavigate={navigate} /></nav>
        </Dialog>}
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

