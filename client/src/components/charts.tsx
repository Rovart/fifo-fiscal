import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { compactEur, compactSigned, eur, monthShort, signed } from '../format.ts';

/** Un solo aviso flotante por gráfica. Solo amplía: cada valor se puede leer también en la tabla. */
function useTip() {
  const [tip, setTip] = useState<{ x: number; y: number; content: ReactNode } | null>(null);
  const node = tip && (
    <div className="chart-tip" role="status" style={{ left: tip.x, top: tip.y }}>{tip.content}</div>
  );
  return { node, show: (x: number, y: number, content: ReactNode) => setTip({ x, y, content }), hide: () => setTip(null) };
}

const TipRow = ({ label, value, color }: { label: string; value: string; color?: string }) => (
  <div className="tip-row">
    <b>{value}</b>
    <span>{color && <i style={{ background: color }} />}{label}</span>
  </div>
);

export interface YearColumn { year: number; result: number; rows: { label: string; value: string }[] }

/** Resultado de cada año. Pulsar un año filtra el resto de la pantalla. */
export function YearColumns({ years, selected, onSelect }: { years: YearColumn[]; selected: number | null; onSelect: (y: number) => void }) {
  const { node, show, hide } = useTip();
  const up = Math.max(0, ...years.map((y) => y.result));
  const down = Math.max(0, ...years.map((y) => -y.result));
  const span = up + down || 1;
  const zero = (up / span) * 100;
  return (
    <div className="ycols">
      {node}
      <div className="ycols-plot">
        <div className="ycols-zero" style={{ top: `${zero}%` }} />
        {years.map((y) => {
          const h = (Math.abs(y.result) / span) * 100;
          const positive = y.result >= 0;
          const tip = (
            <>
              <div className="tip-head">{y.year}</div>
              {y.rows.map((r) => <TipRow key={r.label} label={r.label} value={r.value} />)}
            </>
          );
          return (
            <button
              key={y.year}
              className={`ycol ${selected === y.year ? 'on' : ''} ${selected !== null && selected !== y.year ? 'dim' : ''}`}
              aria-pressed={selected === y.year}
              aria-label={`${y.year}: ${compactSigned(y.result)}`}
              onClick={() => onSelect(y.year)}
              onPointerMove={(e) => { if (e.pointerType === 'mouse') show(e.clientX, e.clientY, tip); }}
              onPointerLeave={hide}
              onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); show(r.left + r.width / 2, r.top + 24, tip); }}
              onBlur={hide}
            >
              <i className={`ycol-bar ${positive ? 'up' : 'down'}`} style={positive ? { top: `${zero - h}%`, height: `${h}%` } : { top: `${zero}%`, height: `${h}%` }} />
              <span className="ycol-value" style={positive ? { bottom: `calc(${100 - zero + h}% + 3px)` } : { top: `calc(${zero + h}% + 3px)` }}>{compactSigned(y.result)}</span>
            </button>
          );
        })}
      </div>
      <div className="ycols-axis">{years.map((y) => <span key={y.year} className={selected === y.year ? 'strong' : ''}>{y.year}</span>)}</div>
    </div>
  );
}

const niceStep = (max: number, count: number) => {
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
};

export interface ValuePoint { month: string; value: number; cost: number }

/** Lo que vale la cartera frente a lo que costó: la distancia entre las líneas es lo que se ganaría o perdería. */
export function ValueChart({ points }: { points: ValuePoint[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [active, setActive] = useState<number | null>(null);
  const { node, show, hide } = useTip();
  useEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => { if (e) setWidth(Math.max(240, e.contentRect.width)); });
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  const H = 240, L = 52, R = 12, T = 12, B = 26;
  const max = Math.max(1, ...points.flatMap((p) => [p.value, p.cost]));
  const step = niceStep(max, 4);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const n = points.length;
  const x = (i: number) => L + (n > 1 ? (i / (n - 1)) * (width - L - R) : 0);
  const y = (v: number) => T + (1 - v / top) * (H - T - B);
  const line = (key: 'value' | 'cost') => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join(' ');
  const area = n ? `${line('value')} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z` : '';
  // Con varios años, una marca en cada enero; con uno, cada dos o tres meses.
  const labels = useMemo(() => {
    const room = Math.max(1, Math.floor((width - L - R) / 62));
    const yearly = points.map((p, i) => ({ p, i })).filter(({ p, i }) => p.month.endsWith('-01') || i === 0);
    const pick = n > 14 ? yearly : points.map((p, i) => ({ p, i })).filter(({ i }) => i % Math.ceil(n / room) === 0);
    return pick.map(({ p, i }) => ({ i, text: n > 14 ? p.month.slice(0, 4) : monthShort(p.month) }));
  }, [points, width, n]);
  const tipFor = (i: number) => {
    const p = points[i];
    if (!p) return null;
    const diff = p.value - p.cost;
    return (
      <>
        <div className="tip-head">{monthShort(p.month)}</div>
        <TipRow label="Vale" value={eur(p.value.toFixed(2))} color="var(--accent)" />
        <TipRow label="Te costó" value={eur(p.cost.toFixed(2))} color="var(--ink-3)" />
        <TipRow label="Diferencia" value={signed(diff.toFixed(2))} />
      </>
    );
  };
  const at = (i: number | null, clientX?: number, clientY?: number) => {
    setActive(i);
    if (i === null) { hide(); return; }
    const rect = box.current?.getBoundingClientRect();
    if (rect) show(clientX ?? rect.left + x(i), clientY ?? rect.top + y(points[i]?.value ?? 0), tipFor(i));
  };
  const onMove = (e: React.PointerEvent) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const i = Math.round(((e.clientX - rect.left - L) / Math.max(1, width - L - R)) * (n - 1));
    at(Math.min(n - 1, Math.max(0, i)), e.clientX, e.clientY);
  };
  const last = points[n - 1];
  return (
    <div
      className="vchart"
      ref={box}
      tabIndex={0}
      role="img"
      aria-label={last ? `Valor de la cartera por meses. En ${monthShort(last.month)} vale ${eur(last.value.toFixed(2))} y te costó ${eur(last.cost.toFixed(2))}.` : 'Sin datos'}
      onPointerMove={onMove}
      onPointerLeave={() => at(null)}
      onBlur={() => at(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const d = e.key === 'ArrowLeft' ? -1 : 1;
          at(Math.min(n - 1, Math.max(0, (active ?? n - 1) + d)));
        } else if (e.key === 'Escape') at(null);
      }}
    >
      {node}
      <svg width={width} height={H} aria-hidden="true">
        {ticks.map((t) => (
          <g key={t}>
            <line className="vchart-grid" x1={L} x2={width - R} y1={y(t)} y2={y(t)} />
            <text className="vchart-tick" x={L - 8} y={y(t) + 4} textAnchor="end">{t === 0 ? '0' : compactEur(t)}</text>
          </g>
        ))}
        {labels.map((l) => <text key={l.i} className="vchart-tick" x={x(l.i)} y={H - 7} textAnchor={l.i === 0 ? 'start' : 'middle'}>{l.text}</text>)}
        <path d={area} className="vchart-area" />
        <path d={line('cost')} className="vchart-cost" />
        <path d={line('value')} className="vchart-value" />
        {active !== null && points[active] && (
          <g>
            <line className="vchart-cross" x1={x(active)} x2={x(active)} y1={T} y2={H - B} />
            <circle className="vchart-dot cost" cx={x(active)} cy={y(points[active].cost)} r={4} />
            <circle className="vchart-dot" cx={x(active)} cy={y(points[active].value)} r={4} />
          </g>
        )}
        {active === null && last && <circle className="vchart-dot" cx={x(n - 1)} cy={y(last.value)} r={4} />}
      </svg>
    </div>
  );
}

export interface BarRow { key: string; name: string; value: number; tip?: string }

/** Barras a un lado u otro del cero: ganancia a la derecha, pérdida a la izquierda. */
export function DivergingBars({ rows }: { rows: BarRow[] }) {
  const up = Math.max(0, ...rows.map((r) => r.value));
  const down = Math.max(0, ...rows.map((r) => -r.value));
  const span = up + down;
  const zero = span ? (down / span) * 100 : 0;
  return (
    <div className="bars">
      {rows.map((r) => {
        const pct = span ? (Math.abs(r.value) / span) * 100 : 0;
        const positive = r.value >= 0;
        return (
          <div className="bar-row" key={r.key}>
            <div className="bar-name" title={r.name}>{r.name}</div>
            <div className="bar-track">
              <div className="bar-zero" style={{ left: `${zero}%` }} />
              <div className={`bar ${positive ? 'up' : 'down'}`} style={{ left: `${positive ? zero : zero - pct}%`, width: `${pct}%` }} />
            </div>
            <div className="bar-value">{signed(r.value.toFixed(2))}</div>
            {r.tip && <div className="bar-tip">{r.tip}</div>}
          </div>
        );
      })}
    </div>
  );
}

export interface StackSegment { key: string; label: string; value: number; color: string }

/** Reparto de un total: una barra y, debajo, cada parte con su importe. */
export function StackBar({ segments }: { segments: StackSegment[] }) {
  const parts = segments.filter((s) => s.value > 0);
  const total = parts.reduce((s, p) => s + p.value, 0);
  if (total <= 0) return null;
  return (
    <div className="stack">
      <div className="stack-bar" aria-hidden="true">
        {parts.map((s) => <i key={s.key} style={{ flexGrow: s.value, background: s.color }} title={s.label} />)}
      </div>
      <ul className="stack-legend">
        {parts.map((s) => (
          <li key={s.key}>
            <i style={{ background: s.color }} />
            <span className="stack-name">{s.label}</span>
            <span className="num muted">{((s.value / total) * 100).toLocaleString('es-ES', { maximumFractionDigits: 0 })} %</span>
            <span className="num">{eur(s.value.toFixed(2))}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
