import { Check, ChevronLeft, ChevronRight, Copy as CopyIcon, X, type LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { parseLocaleNumber } from '../../../shared/decimal.ts';
import { useApp } from '../context.ts';
import { eur, plain } from '../format.ts';

export function YearPicker() {
  const { state, year, setYear } = useApp();
  const years = state.years;
  const i = years.indexOf(year);
  if (years.length <= 1) return null;
  return (
    <div className="year" role="group" aria-label="Año">
      <button disabled={i <= 0} onClick={() => setYear(years[i - 1] as number)} aria-label="Año anterior"><ChevronLeft size={16} /></button>
      <strong>{year}</strong>
      <button disabled={i >= years.length - 1} onClick={() => setYear(years[i + 1] as number)} aria-label="Año siguiente"><ChevronRight size={16} /></button>
    </div>
  );
}

export function PageHead({ title, sub, year, children }: { title: ReactNode; sub?: ReactNode; year?: boolean; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="page-sub">{sub}</div>}
      </div>
      <div className="actions">
        {children}
        {year && <YearPicker />}
      </div>
    </div>
  );
}

/** Esqueleto de lo que se está cargando: líneas con un brillo que las recorre. */
export const Loading = () => (
  <div className="skeleton" role="status">
    <span className="sr-only">Cargando…</span>
    {['38%', '100%', '84%', '62%'].map((w) => <i key={w} aria-hidden="true" style={{ '--w': w } as React.CSSProperties} />)}
  </div>
);

/**
 * Rueda de actividad sobre <progress> indeterminado: con `label`, los lectores de pantalla la anuncian como ocupado.
 * Sin él es decorativa, para botones cuyo texto ya dice lo que pasa.
 */
export const Spinner = ({ label }: { label?: string }) => <progress className="spinner" aria-label={label} aria-hidden={label ? undefined : true} />;

/** Barra fina en lo alto de la ventana mientras dura una consulta que no tiene porcentaje. */
export const PageProgress = ({ active, label }: { active: boolean; label: string }) => (active ? <progress className="page-progress" aria-label={label} /> : null);

export function LoadError({ onRetry }: { onRetry: () => void }) {
  return <Callout tone="error" title="No se pudieron cargar los datos" action={<button className="btn small" onClick={onRetry}>Reintentar</button>}>Comprueba la conexión con la aplicación.</Callout>;
}

export function Dialog({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.showModal();
    return () => { ref.current?.close(); previous?.focus(); };
  }, []);
  return createPortal(
    <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={id} onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => {
      if (e.target !== e.currentTarget) return;
      const r = e.currentTarget.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) onClose();
    }}>
      <div className="dialog-head"><h2 id={id}>{title}</h2><button type="button" className="btn quiet icon" aria-label="Cerrar" onClick={onClose}><X size={18} /></button></div>
      {children}
    </dialog>, document.body,
  );
}

export function Empty({ icon: Icon, title, tone, children }: { icon?: LucideIcon; title: string; tone?: 'gain'; children?: ReactNode }) {
  return (
    <div className="empty">
      {Icon && <div className={`avatar ${tone ?? ''}`}><Icon size={22} /></div>}
      <div className="t">{title}</div>
      {children}
    </div>
  );
}

export function Callout({ tone = 'info', icon: Icon, title, children, action }: { tone?: 'info' | 'warn' | 'error' | 'ok'; icon?: LucideIcon; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`callout ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {Icon && <Icon size={18} />}
      <div className="body">
        {title && <div className="t">{title}</div>}
        {children && <div className={title ? 'small' : ''}>{children}</div>}
      </div>
      {action && <div className="action">{action}</div>}
    </div>
  );
}

/** Icono de ayuda: explica un término sin llenar la pantalla de texto. */
export function Help({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const width = 270;
    setPos({ left: Math.max(8, Math.min(window.innerWidth - width - 8, r.left + r.width / 2 - width / 2)), top: r.bottom + 8 });
  };
  const hide = () => setPos(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="help"
        aria-label={text}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); if (pos) hide(); else show(); }}
      >?</button>
      {pos && createPortal(<div className="tooltip" role="tooltip" style={{ left: pos.left, top: pos.top, width: 270 }}>{text}</div>, document.body)}
    </>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} aria-pressed={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Disclosure({ title, meta, children, card, open: defaultOpen, flush }: { title: ReactNode; meta?: ReactNode; children: ReactNode; card?: boolean; open?: boolean; flush?: boolean }) {
  return (
    <details className={`disclosure ${card ? 'card' : ''}`} open={defaultOpen}>
      <summary>
        <ChevronRight size={16} className="chevron" />
        <span style={{ flex: 1 }}>{title}</span>
        {meta}
      </summary>
      <div className={`disc-body ${flush ? 'flush' : ''}`}>{children}</div>
    </details>
  );
}

/** Importe que se copia con un clic, con el formato que espera Renta Web. */
export function CopyValue({ value, display, text }: { value: string; display?: string; text?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className={`copy ${copied ? 'copied' : ''}`}
      aria-label={copied ? 'Copiado' : `Copiar ${display ?? value}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text ? value : plain(value));
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      }}
    >
      {display ?? eur(value)}
      {copied ? <Check size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}

/** Panel lateral con salida animada. Cierra con Esc o clic fuera. */
export function Sheet({ onClose, label, children }: { onClose: () => void; label: string; children: (close: () => void) => ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const close = () => {
    if (closing) return;
    setClosing(true);
    timer.current = setTimeout(onClose, 150);
  };
  useEffect(() => {
    const dialog = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    dialog?.showModal();
    return () => { clearTimeout(timer.current); dialog?.close(); previous?.focus(); };
  }, []);
  return (
    <dialog ref={ref} className={`sheet ${closing ? 'closing' : ''}`} aria-label={label}
      onCancel={(e) => { e.preventDefault(); close(); }}
      onClick={(e) => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      }}>{children(close)}</dialog>
  );
}

/** Campo numérico con etiqueta que admite coma o punto. */
export function NumField({ label, value, onChange, placeholder }: { label: ReactNode; value: string | null; onChange: (v: string) => void; placeholder?: string }) {
  const [text, setText] = useState(plain(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(plain(value)); }, [value, focused]);
  return (
    <label className="field">
      <span>{label}</span>
      <input
        className="input"
        style={{ textAlign: 'right' }}
        inputMode="decimal"
        placeholder={placeholder}
        value={text}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseLocaleNumber(e.target.value);
          if (parsed !== null) onChange(parsed);
          else if (e.target.value.trim() === '') onChange('');
        }}
      />
    </label>
  );
}

/** `checked` convierte el menú en una elección entre opciones: la elegida lleva una marca. */
export interface MenuItem { label: string; icon?: LucideIcon; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean }

/** Menú desplegable: reúne las acciones de una fila o de una página en un solo botón. */
export function Menu({ label, ariaLabel, className = 'btn', items, disabled }: { label: ReactNode; ariaLabel?: string; className?: string; items: MenuItem[]; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const options = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)') ?? [])];
    // Si no cabe hacia la izquierda, se abre hacia la derecha.
    const list = ref.current?.querySelector<HTMLElement>('.menu-list');
    if (list && list.getBoundingClientRect().left < 8) list.classList.add('from-left');
    (options().find((o) => o.getAttribute('aria-checked') === 'true') ?? options()[0])?.focus();
    const outside = (e: Event) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const list = options(), at = list.indexOf(document.activeElement as HTMLButtonElement);
      list[(at + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label={ariaLabel} disabled={disabled} onClick={() => setOpen((o) => !o)}>{label}</button>
      {open && <div className="menu-list" role="menu">
        {items.map((it) => (
          <button type="button" role={it.checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={it.checked} key={it.label} className={`menu-item ${it.danger ? 'danger' : ''}`} disabled={it.disabled} onClick={() => { setOpen(false); it.onSelect(); }}>
            {it.icon && <it.icon size={16} aria-hidden="true" />}{it.label}
            {it.checked && <Check size={16} className="menu-check" aria-hidden="true" />}
          </button>
        ))}
      </div>}
    </div>
  );
}
