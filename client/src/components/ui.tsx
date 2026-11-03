import { Check, ChevronLeft, ChevronRight, Copy as CopyIcon, type LucideIcon } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
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

export const Loading = () => <div className="skeleton" aria-label="Cargando" />;

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
    <div className={`callout ${tone}`}>
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
    <div className="segmented" role="tablist" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="tab" aria-selected={value === o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}>{o.label}</button>
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
  const [closing, setClosing] = useState(false);
  const close = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(onClose, 150);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <>
      <div className={`sheet-bg ${closing ? 'closing' : ''}`} onClick={close} />
      <aside className={`sheet ${closing ? 'closing' : ''}`} role="dialog" aria-modal="true" aria-label={label}>{children(close)}</aside>
    </>
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
