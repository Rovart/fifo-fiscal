import { useMemo } from 'react';
import { D, type Decimal } from '../../../shared/decimal.ts';

type Kind = 'gain' | 'loss' | 'none';
interface Segment { kind: Kind; share: number }

/** Tramos de la barra en orden FIFO: seguidos los del mismo signo y sin tramos demasiado finos para verse. */
export function lotSegments(lots: { quantity: string; costEur: string }[], price: Decimal | null): Segment[] {
  const total = lots.reduce((s, l) => s + Number(l.quantity), 0);
  const out: Segment[] = [];
  for (const l of lots) {
    const share = total > 0 ? Number(l.quantity) / total : 0;
    const kind: Kind = price ? (price.times(D(l.quantity)).gte(D(l.costEur)) ? 'gain' : 'loss') : 'none';
    const last = out[out.length - 1];
    if (last && (last.kind === kind || share < 0.008)) last.share += share;
    else out.push({ kind, share });
  }
  return out;
}

interface Props {
  segments: Segment[];
  /** Cantidad total y cantidad elegida. */
  total: Decimal;
  value: Decimal;
  disabled?: boolean;
  label: string;
  valueText: string;
  onChange: (quantity: string) => void;
}

const PER_MILLE = 1000;

export function LotSlider({ segments, total, value, disabled, label, valueText, onChange }: Props) {
  // Acciones enteras, de una en una; con fracciones, por milésimas de la posición.
  const whole = total.isInteger();
  const max = whole ? total.toNumber() : PER_MILLE;
  const position = whole ? value.toNumber() : Math.round(value.div(total).toNumber() * PER_MILLE);
  const percent = total.isZero() ? 0 : value.div(total).toNumber() * 100;
  const track = useMemo(() => segments.map((s, i) => <i key={i} className={s.kind} style={{ flexGrow: s.share }} />), [segments]);
  const toQuantity = (p: number) => {
    if (whole) return String(p);
    return p >= PER_MILLE ? total.toFixed() : total.times(p).div(PER_MILLE).toDecimalPlaces(8).toFixed();
  };
  return (
    <div className={`lot-slider ${disabled ? 'off' : ''}`}>
      <div className="lot-track" aria-hidden="true">{track}</div>
      <div className="lot-track on" aria-hidden="true" style={{ clipPath: `inset(-2px ${100 - percent}% -2px 0)` }}>{track}</div>
      <input
        type="range"
        min={0}
        max={max}
        step={1}
        value={position}
        disabled={disabled}
        aria-label={label}
        aria-valuetext={valueText}
        onChange={(e) => onChange(toQuantity(Number(e.target.value)))}
      />
    </div>
  );
}
