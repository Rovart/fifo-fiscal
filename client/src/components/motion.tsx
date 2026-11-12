import { useLayoutEffect, useRef, useState } from 'react';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];

/** Importe que rueda cifra a cifra, como un cuentakilómetros, al cambiar de año o de dato. */
export function Rolling({ value }: { value: string }) {
  const chars = [...value];
  return (
    <span className="rolling">
      <span className="sr-only">{value}</span>
      <span aria-hidden="true">
        {chars.map((c, i) => {
          // La posición se cuenta desde la derecha: los céntimos no se mueven aunque cambie el número de cifras.
          const place = chars.length - i;
          return /\d/.test(c)
            ? <span className="roll" key={place} style={{ '--digit': c, '--place': place } as React.CSSProperties}><span>{DIGITS.map((d) => <i key={d}>{d}</i>)}</span></span>
            : <span key={place}>{c}</span>;
        })}
      </span>
    </span>
  );
}

/** Marca de la aplicación: una pila de lotes en la que sale el primero que entró. */
export function FifoMark() {
  return (
    <svg className="fifo-mark" viewBox="0 0 26 26" aria-hidden="true">
      <rect className="plate" width="26" height="26" rx="7" />
      <rect className="lot in" x="6" y="6.5" width="14" height="3" rx="1.5" />
      <rect className="lot mid" x="6" y="11.5" width="14" height="3" rx="1.5" />
      <rect className="lot out" x="6" y="16.5" width="14" height="3" rx="1.5" />
    </svg>
  );
}

/** Carpeta que se abre para recibir los extractos: al arrastrar levanta la tapa y asoma la hoja. */
export function Folder() {
  return (
    <svg className="folder" viewBox="0 0 56 48" aria-hidden="true">
      <path className="back" d="M4 10a4 4 0 0 1 4-4h12l5 5h23a4 4 0 0 1 4 4v25a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
      <g className="sheet-in">
        <rect x="13" y="9" width="30" height="30" rx="3" />
        <path d="M19 17h18M19 23h18M19 29h11" />
      </g>
      <path className="front" d="M4 22a4 4 0 0 1 4-4h40a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z" />
    </svg>
  );
}

/** Sello de tinta que cae sobre el papel cuando todo el ejercicio está pasado a Renta Web. */
export function Stamp({ top, bottom }: { top: string; bottom: string }) {
  return (
    <span className="stamp no-print" role="img" aria-label={`${top} ${bottom}`}>
      <span className="stamp-ink"><b>{top}</b><i>{bottom}</i></span>
    </span>
  );
}

/** Textura de tinta para el sello: una sola vez en la página. */
export const InkFilter = () => (
  <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
    <filter id="ink" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="7" result="grain" />
      <feDisplacementMap in="SourceGraphic" in2="grain" scale="2.2" result="rough" />
      <feColorMatrix in="grain" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  -4 0 0 0 2.8" result="wear" />
      <feComposite in="rough" in2="wear" operator="in" />
    </filter>
  </svg>
);

/** Fondo del apartado activo del menú: se desliza de uno a otro en vez de saltar. */
export function NavIndicator({ watch }: { watch: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState<{ top: number; left: number; width: number; height: number } | null>(null);
  const [moved, setMoved] = useState(false);
  useLayoutEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const measure = () => {
      const on = parent.querySelector<HTMLElement>('.nav-btn.on');
      setBox(on ? { top: on.offsetTop, left: on.offsetLeft, width: on.offsetWidth, height: on.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [watch]);
  // La primera posición aparece en su sitio; solo se anima al cambiar de apartado.
  useLayoutEffect(() => { if (box && !moved) requestAnimationFrame(() => setMoved(true)); }, [box, moved]);
  return <span ref={ref} className={`nav-indicator ${moved ? 'moving' : ''}`} aria-hidden="true"
    style={box ? { transform: `translate(${box.left}px, ${box.top}px)`, width: box.width, height: box.height } : { opacity: 0 }} />;
}
