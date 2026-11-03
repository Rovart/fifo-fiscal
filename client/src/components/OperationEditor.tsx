import { AlertCircle, ArrowLeft, Check, ChevronDown, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { D, isNum, parseLocaleNumber } from '../../../shared/decimal.ts';
import { applyEdit, reconcile } from '../../../shared/reconcile.ts';
import {
  BROKER_LABEL, CLASS_LABEL, KIND_LABEL,
  type AssetClass, type Broker, type EditableField, type OpKind, type Operation, type ReconcileCheck,
} from '../../../shared/types.ts';
import { api, ApiError } from '../api.ts';
import { useApp } from '../context.ts';
import { dateShort, money, niceName, plain, plainMoney, symbol } from '../format.ts';
import { COMMON_KINDS, KIND_ICON, OTHER_KINDS } from './kinds.tsx';
import { Callout, Disclosure, Help, NumField, Sheet } from './ui.tsx';

interface Row {
  field: EditableField;
  label: string;
  unit?: string;
  pre?: string;
  /** Calculado a partir de lo anterior: se ve más discreto, pero se puede editar. */
  calc?: boolean;
  total?: boolean;
  /** Solo se muestra si tiene valor o el usuario lo añade. */
  optional?: boolean;
  money?: boolean;
}

/** Las líneas del recibo de cada tipo de movimiento. */
function rowsFor(op: Operation): Row[] {
  const cur = symbol(op.currency);
  const foreign = op.currency !== 'EUR';
  const fxRows = (calcLabel: string): Row[] => (foreign
    ? [
      { field: 'fxRate', label: 'Tipo de cambio', pre: '1 € =', unit: cur },
      { field: 'grossEur', label: calcLabel, unit: '€', calc: true, money: true },
    ]
    : []);
  switch (op.kind) {
    case 'buy':
    case 'sell':
      return [
        { field: 'quantity', label: 'Cantidad', unit: op.assetClass === 'crypto' ? op.assetId : undefined },
        { field: 'unitPrice', label: 'Precio por unidad', unit: cur },
        { field: 'grossLocal', label: 'Importe', unit: cur, calc: true, money: true },
        ...fxRows('Importe en euros'),
        { field: 'feeEur', label: 'Comisión', unit: '€', money: true },
        { field: 'otherCostsEur', label: 'Impuestos y otros gastos', unit: '€', optional: true, money: true },
        { field: 'totalEur', label: op.kind === 'buy' ? 'Total pagado' : 'Total recibido', unit: '€', total: true, money: true },
      ];
    case 'dividend':
    case 'interest':
    case 'return_capital':
      return [
        { field: 'grossLocal', label: op.kind === 'return_capital' ? 'Importe' : 'Bruto', unit: cur, money: true },
        ...fxRows('Bruto en euros'),
        { field: 'withholdingEur', label: 'Retención', unit: '€', money: true },
        { field: 'feeEur', label: 'Comisión', unit: '€', optional: true, money: true },
        { field: 'totalEur', label: 'Neto recibido', unit: '€', total: true, money: true },
      ];
    case 'staking':
    case 'reward':
      return [
        { field: 'quantity', label: 'Cantidad recibida', unit: op.assetId },
        { field: 'unitPrice', label: 'Precio por unidad', unit: '€' },
        { field: 'grossEur', label: 'Valor', unit: '€', total: true, money: true },
      ];
    case 'fee':
      if (op.assetClass === 'crypto') return [
        { field: 'quantity', label: 'Comisión pagada', unit: op.assetId },
        ...(isNum(op.grossEur) ? [{ field: 'grossLocal', label: 'Valor en euros', unit: '€', money: true } as Row] : []),
      ];
      return [
        { field: 'grossLocal', label: 'Importe', unit: cur, total: !foreign, money: true },
        ...fxRows('Importe en euros'),
      ];
    case 'deposit':
    case 'withdrawal':
      return [
        { field: 'grossLocal', label: 'Importe', unit: cur, total: !foreign, money: true },
        ...(foreign ? [{ field: 'fxRate', label: 'Tipo de cambio', pre: '1 € =', unit: cur } as Row, { field: 'grossEur', label: 'Importe en euros', unit: '€', total: true, money: true } as Row] : []),
      ];
    case 'swap':
      return [
        { field: 'quantity', label: 'Entregas', unit: op.assetId },
        { field: 'counterQuantity', label: 'Recibes', unit: op.counterAsset ?? '' },
        { field: 'unitPrice', label: `Precio de ${op.assetId || 'lo entregado'}`, unit: '€' },
        { field: 'grossEur', label: 'Valor en euros', unit: '€', calc: true, money: true },
        { field: 'feeEur', label: 'Comisión', unit: '€', money: true },
        { field: 'totalEur', label: 'Total', unit: '€', total: true, money: true },
      ];
    case 'fx':
      return [
        { field: 'quantity', label: 'Entregas', unit: symbol(op.currency) },
        { field: 'counterQuantity', label: 'Recibes', unit: symbol(op.counterAsset) },
        ...(op.currency !== 'EUR' && op.counterAsset !== 'EUR' ? [{ field: 'fxRate', label: 'Tipo de cambio', pre: '1 € =', unit: cur } as Row] : []),
        { field: 'grossEur', label: 'Valor en euros', unit: '€', calc: true, money: true },
        { field: 'feeEur', label: 'Comisión', unit: '€', optional: true, money: true },
        { field: 'totalEur', label: 'Total', unit: '€', total: true, money: true },
      ];
    case 'split':
      return [{ field: 'quantity', label: 'Acciones que entran (+) o salen (−)' }];
    case 'isin_change':
      return [{ field: 'quantity', label: 'Acciones antiguas' }, { field: 'counterQuantity', label: 'Acciones nuevas' }];
    default:
      return [{ field: 'quantity', label: 'Cantidad', unit: op.assetId }];
  }
}

const shortRate = (v: string | null | undefined): string => (isNum(v) ? plain(D(v).toDecimalPlaces(5).toFixed()) : plain(v));

function AmountInput({ value, onChange, money: isMoney, rate, unit, pre, label, bad, autoFocus }: {
  value: string | null; onChange: (v: string) => void; money?: boolean; rate?: boolean; unit?: string; pre?: string; label: string; bad?: boolean; autoFocus?: boolean;
}) {
  const show = rate ? shortRate : isMoney ? plainMoney : plain;
  const [text, setText] = useState(show(value));
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const prev = useRef(value);
  useEffect(() => {
    if (!focused) setText(show(value));
    // Resalta un instante lo que ha cambiado por efecto de otra edición.
    if (!focused && prev.current !== value && ref.current?.animate && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const soft = getComputedStyle(document.documentElement).getPropertyValue('--accent-soft');
      ref.current.animate([{ backgroundColor: soft }, {}], { duration: 650, easing: 'ease-out' });
    }
    prev.current = value;
  }, [value, focused, isMoney]);
  return (
    <div className="amount-wrap">
      {pre && <span className="amount-pre">{pre}</span>}
      <input
        ref={ref}
        className={`amount-input ${bad ? 'bad' : ''}`}
        inputMode="decimal"
        aria-label={label}
        aria-invalid={bad}
        autoFocus={autoFocus}
        value={text}
        onFocus={(e) => { setFocused(true); e.target.select(); }}
        onBlur={() => { setFocused(false); setText(show(value)); }}
        onChange={(e) => {
          setText(e.target.value);
          const parsed = parseLocaleNumber(e.target.value);
          if (parsed !== null) onChange(parsed);
          else if (e.target.value.trim() === '') onChange('');
        }}
      />
      {unit !== undefined && <span className="amount-unit">{unit}</span>}
    </div>
  );
}

const blank = (today: string, kind: OpKind, prefill?: Partial<Operation>): Operation => ({
  id: '', broker: 'manual', kind, datetime: `${today}T12:00:00`, assetId: '', assetName: '', assetClass: kind === 'staking' || kind === 'swap' ? 'crypto' : 'stock',
  quantity: '', unitPrice: '', currency: 'EUR', fxRate: '1', grossLocal: '', grossEur: '', feeEur: '0', otherCostsEur: '0', withholdingEur: '0', totalEur: '', settleCurrency: 'EUR', reviewReasons: [],
  ...(kind === 'fx' ? { counterAsset: 'EUR', currency: 'USD', fxRate: null, assetId: 'USD', assetName: 'USD', assetClass: 'other' as AssetClass } : {}),
  ...(kind === 'swap' ? { counterAsset: '', counterQuantity: '' } : {}),
  ...prefill,
});

const CURRENCIES = ['EUR', 'USD', 'GBP', 'GBX', 'CHF', 'CAD', 'AUD', 'JPY', 'SEK', 'NOK', 'DKK', 'HKD'];

interface Props {
  op: Operation | null;
  prefill?: Partial<Operation>;
  onClose: () => void;
  onSaved: (message: string) => void;
}

function TypePicker({ onPick, onClose }: { onPick: (k: OpKind) => void; onClose: () => void }) {
  const [more, setMore] = useState(false);
  const kinds = more ? [...COMMON_KINDS, ...OTHER_KINDS] : COMMON_KINDS;
  return (
    <>
      <div className="sheet-head">
        <div style={{ flex: 1 }} className="t">¿Qué quieres añadir?</div>
        <button className="btn quiet icon" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
      </div>
      <div className="sheet-body">
        <div className="tile-grid">
          {kinds.map((k) => {
            const Icon = KIND_ICON[k];
            return <button key={k} className="tile" onClick={() => onPick(k)}><Icon size={20} /> {KIND_LABEL[k]}</button>;
          })}
        </div>
        {!more && <button className="btn quiet" onClick={() => setMore(true)}><ChevronDown size={16} /> Ver más tipos</button>}
      </div>
    </>
  );
}

function FixLine({ check, edit }: { check: ReconcileCheck; edit: (f: EditableField, v: string) => void }) {
  const [first, ...rest] = check.fix ?? [];
  return (
    <div className="r-fix">
      {first && <span>Debería ser {money(first.value)}</span>}
      {first && <button className="link" onClick={() => edit(first.field, first.value)}>Corregir</button>}
      {rest.map((x) => <button key={x.field} className="link muted" onClick={() => edit(x.field, x.value)}>{x.label.toLowerCase()} a {money(x.value)}</button>)}
    </div>
  );
}

export function OperationEditor({ op, prefill, onClose, onSaved }: Props) {
  const { state, changed } = useApp();
  const isNew = !op;
  const tolerance = state.settings.toleranceEur;
  const [draft, setDraft] = useState<Operation | null>(op ?? (prefill?.kind ? blank(state.today, prefill.kind, prefill) : null));
  const [auto, setAuto] = useState(true);
  const [showOptional, setShowOptional] = useState<Set<EditableField>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [history, setHistory] = useState<{ at: string; action: string }[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const rec = useMemo(() => (draft ? reconcile(draft, tolerance) : null), [draft, tolerance]);

  return (
    <Sheet onClose={onClose} label={isNew ? 'Añadir movimiento' : 'Editar movimiento'}>
      {(close) => {
        if (!draft || !rec) return <TypePicker onPick={(k) => setDraft(blank(state.today, k, prefill))} onClose={close} />;
        const Icon = KIND_ICON[draft.kind];
        const rows = rowsFor(draft);
        const dirty = isNew || JSON.stringify(draft) !== JSON.stringify(op);

        const edit = (f: EditableField, v: string) => {
          setDraft((d) => {
            if (!d) return d;
            if (auto && v !== '' && isNum(v)) return applyEdit(d, f, v, 'auto');
            const next = { ...d, [f]: v };
            // Sin recalcular, los campos que no se ven siguen a los que sí.
            if (next.currency === 'EUR' && f === 'grossLocal') next.grossEur = v;
            if (['staking', 'reward', 'fee', 'deposit', 'withdrawal'].includes(next.kind) && f === 'grossEur') next.totalEur = v;
            if (['fee', 'deposit', 'withdrawal'].includes(next.kind) && next.currency === 'EUR' && f === 'grossLocal') next.totalEur = v;
            return next;
          });
        };
        const set = <K extends keyof Operation>(k: K, v: Operation[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));
        const setCurrency = (c: string) => setDraft((d) => (d ? { ...d, currency: c, fxRate: c === 'EUR' ? '1' : d.fxRate === '1' ? '' : d.fxRate } : d));

        const useEcb = async () => {
          setError(null);
          const foreign = draft.kind === 'fx' && draft.currency === 'EUR' ? draft.counterAsset ?? '' : draft.currency;
          const r = await api<{ rate: string | null }>(`/rates/${foreign}/${draft.datetime.slice(0, 10)}`);
          if (!r.rate) { setError(`No hay tipo oficial de ${foreign} para esa fecha.`); return; }
          setDraft((d) => (d ? { ...applyEdit(d, 'fxRate', r.rate as string), fxSource: 'ecb' } : d));
        };
        const fetchMarket = async () => {
          setError(null);
          const r = await api<{ price: string | null }>(`/prices/${draft.assetId}/${draft.datetime}`);
          if (!r.price) { setError('No encontramos precio para esa moneda y fecha. Escríbelo a mano.'); return; }
          setDraft((d) => (d ? applyEdit({ ...d, currency: 'EUR', fxRate: '1' }, 'unitPrice', D(r.price as string).toDecimalPlaces(8).toFixed()) : d));
        };
        const save = async () => {
          setSaving(true);
          setError(null);
          try {
            const body: Operation = { ...draft, assetName: draft.assetName || draft.assetId };
            if (isNew) {
              const { id: _omit, ...rest } = body;
              await api('/operations', { method: 'POST', body: rest });
              onSaved('Movimiento añadido');
            } else {
              await api(`/operations/${op.id}`, { method: 'PUT', body });
              onSaved('Cambios guardados');
            }
          } catch (e) {
            setError(e instanceof ApiError ? e.message : String(e));
          } finally {
            setSaving(false);
          }
        };
        const confirmReason = async (reason: string) => {
          if (isNew) { set('reviewReasons', (draft.reviewReasons ?? []).filter((r) => r !== reason)); return; }
          await api('/review/confirm', { method: 'POST', body: { ids: [op.id], reason } });
          setDraft((d) => (d ? { ...d, reviewReasons: (d.reviewReasons ?? []).filter((r) => r !== reason) } : d));
          changed('Marcado como revisado');
        };
        const remove = async () => {
          if (!confirmDelete) { setConfirmDelete(true); return; }
          await api(`/operations/${op?.id}`, { method: 'DELETE' });
          onSaved('Movimiento eliminado');
        };
        const restore = async () => { await api(`/operations/${op?.id}/restore`, { method: 'POST' }); onSaved('Valores originales recuperados'); };
        const undelete = async () => { await api(`/operations/${op?.id}/undelete`, { method: 'POST' }); onSaved('Movimiento recuperado'); };
        const showHistory = async () => setHistory(await api(`/operations/${op?.id}/history`));

        const failing = rec.checks.filter((c) => !c.ok);
        const shownFields = new Set(rows.map((r) => r.field));
        const checkFor = (f: EditableField) => failing.find((c) => c.field === f);
        const orphanChecks = failing.filter((c) => !c.field || !shownFields.has(c.field));
        const missing = (f: EditableField) => rec.missingFields.includes(f);
        const hiddenOptional = rows.filter((r) => r.optional && !showOptional.has(r.field) && !D(draft[r.field] as string).gt(0));
        const visibleRows = rows.filter((r) => !hiddenOptional.includes(r));
        const foreign = draft.kind === 'fx' ? draft.currency !== 'EUR' || (draft.counterAsset ?? 'EUR') !== 'EUR' : draft.currency !== 'EUR';
        const wantsCurrency = !['swap', 'staking', 'reward', 'transfer_in', 'transfer_out', 'split', 'isin_change'].includes(draft.kind);
        const assetField = (
          <label className="field" style={{ gridColumn: '1 / -1' }}>
            <span>{draft.kind === 'swap' ? 'Moneda que entregas' : '¿Qué activo?'}</span>
            <input
              className="input"
              list="asset-options"
              placeholder="Nombre, ISIN o símbolo"
              value={draft.assetName || draft.assetId}
              autoFocus={isNew && !draft.assetId}
              onChange={(e) => {
                const v = e.target.value;
                const known = state.assets.find((a) => a.name === v || a.id === v);
                setDraft((d) => (d ? { ...d, assetId: known?.id ?? v.trim(), assetName: known?.name ?? v, assetClass: known?.class ?? d.assetClass } : d));
              }}
            />
            <datalist id="asset-options">{state.assets.map((a) => <option key={a.id} value={a.name}>{a.id}</option>)}</datalist>
          </label>
        );
        const dateField = (
          <label className="field"><span>Fecha</span>
            <input className="input" type="date" value={draft.datetime.slice(0, 10)} onChange={(e) => set('datetime', `${e.target.value}T${draft.datetime.slice(11)}`)} />
          </label>
        );
        const brokerField = (
          <label className="field"><span>Bróker</span>
            <select className="input" value={draft.broker} onChange={(e) => set('broker', e.target.value as Broker)}>
              {(Object.keys(BROKER_LABEL) as Broker[]).map((b) => <option key={b} value={b}>{BROKER_LABEL[b]}</option>)}
            </select>
          </label>
        );
        const currencyField = wantsCurrency && (
          <label className="field"><span>{draft.kind === 'fx' ? 'Moneda que entregas' : 'Moneda'}</span>
            <select className="input" value={draft.currency} onChange={(e) => setCurrency(e.target.value)}>
              {[...new Set([...CURRENCIES, draft.currency])].map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        );
        const counterField = (draft.kind === 'swap' || draft.kind === 'fx' || draft.kind === 'isin_change') && (
          <label className="field"><span>{draft.kind === 'fx' ? 'Moneda que recibes' : draft.kind === 'swap' ? 'Moneda que recibes' : 'Nuevo ISIN'}</span>
            <input className="input" value={draft.counterAsset ?? ''} onChange={(e) => {
              const v = draft.kind === 'fx' ? e.target.value.toUpperCase() : e.target.value.trim();
              setDraft((d) => (d ? { ...d, counterAsset: v, counterName: v } : d));
            }} />
          </label>
        );

        const title = isNew ? KIND_LABEL[draft.kind] : `${KIND_LABEL[draft.kind]}${draft.assetName ? ` de ${niceName(draft.assetName)}` : ''}`;
        return (
          <>
            <div className="sheet-head">
              {isNew && !prefill?.kind
                ? <button className="btn quiet icon" onClick={() => setDraft(null)} aria-label="Cambiar tipo"><ArrowLeft size={18} /></button>
                : <div className="avatar"><Icon size={18} /></div>}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="t">{title}</div>
                {!isNew && <div className="small muted">{dateShort(draft.datetime)} · {BROKER_LABEL[draft.broker]}{op?.edited ? ' · editado' : ''}</div>}
              </div>
              <button className="btn quiet icon" onClick={close} aria-label="Cerrar"><X size={18} /></button>
            </div>

            <div className="sheet-body">
              {op?.deleted && <Callout tone="warn">Este movimiento está eliminado.</Callout>}
              {(draft.reviewReasons ?? []).map((r) => (
                <Callout key={r} tone="warn" icon={AlertCircle} action={<button className="btn small" onClick={() => void confirmReason(r)}>Está bien</button>}>{r}</Callout>
              ))}

              {isNew && <div className="form-grid">{assetField}{dateField}{brokerField}{currencyField}{counterField}</div>}

              <div className="receipt">
                {visibleRows.map((r) => {
                  const check = checkFor(r.field);
                  const isMissing = missing(r.field) && !isNew;
                  return (
                    <div key={r.field} className={`r-row ${r.calc ? 'calc' : ''} ${r.total ? 'total' : ''}`}>
                      <div className="r-line">
                        <span className="r-label">{r.label}</span>
                        <AmountInput value={draft[r.field] as string | null} onChange={(v) => edit(r.field, v)} money={r.money} rate={r.field === 'fxRate'} unit={r.unit ?? ''} pre={r.pre} label={r.label} bad={!!check || isMissing} />
                      </div>
                      {check && <FixLine check={check} edit={edit} />}
                      {isMissing && !check && <div className="r-fix">Falta este dato</div>}
                    </div>
                  );
                })}
                {hiddenOptional.length > 0 && (
                  <div style={{ padding: '2px 18px 4px' }}>
                    {hiddenOptional.map((r) => (
                      <button key={r.field} className="link small" style={{ marginRight: 12 }} onClick={() => setShowOptional((s) => new Set([...s, r.field]))}>+ {r.label.toLowerCase()}</button>
                    ))}
                  </div>
                )}
                {orphanChecks.map((c) => <div key={c.label} className="r-fix" style={{ padding: '4px 18px' }}>{c.label}: no cuadra</div>)}
                <div className={`receipt-status ${rec.ok ? 'ok' : 'bad'}`}>
                  {rec.ok ? <><Check size={15} strokeWidth={2.5} /> Todo cuadra</> : <><AlertCircle size={15} /> {isNew && failing.length === 0 ? 'Completa los datos' : 'Revisa lo marcado'}</>}
                  <label className="auto small">
                    Calcular solo
                    <input type="checkbox" role="switch" className="switch" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
                    <Help text="Al cambiar un dato se recalculan los demás. Desactívalo para copiar los valores de tu justificante tal cual." />
                  </label>
                </div>
              </div>

              {(foreign && rows.some((r) => r.field === 'fxRate')) || (draft.assetClass === 'crypto' && rows.some((r) => r.field === 'unitPrice')) ? (
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {foreign && rows.some((r) => r.field === 'fxRate') && <button className="btn small" onClick={() => void useEcb()}>Usar el cambio oficial de ese día</button>}
                  {draft.assetClass === 'crypto' && rows.some((r) => r.field === 'unitPrice') && draft.assetId && <button className="btn small" onClick={() => void fetchMarket()}>Buscar precio de ese día</button>}
                </div>
              ) : null}

              <Disclosure title={isNew ? 'Más datos' : 'Fecha, bróker y más'}>
                <div className="stack" style={{ gap: 12 }}>
                  <div className="form-grid">
                    {!isNew && assetField}
                    {!isNew && dateField}
                    <label className="field"><span>Hora</span>
                      <input className="input" type="time" step="1" value={draft.datetime.slice(11)} onChange={(e) => set('datetime', `${draft.datetime.slice(0, 10)}T${e.target.value.length === 5 ? `${e.target.value}:00` : e.target.value}`)} />
                    </label>
                    {!isNew && brokerField}
                    {!isNew && currencyField}
                    {!isNew && counterField}
                    <label className="field"><span>Tipo de movimiento</span>
                      <select className="input" value={draft.kind} onChange={(e) => set('kind', e.target.value as OpKind)}>
                        {(Object.keys(KIND_LABEL) as OpKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                      </select>
                    </label>
                    <label className="field"><span>Tipo de activo</span>
                      <select className="input" value={draft.assetClass} onChange={(e) => set('assetClass', e.target.value as AssetClass)}>
                        {(['stock', 'etf', 'fund', 'crypto', 'bond', 'other'] as const).map((c) => <option key={c} value={c}>{CLASS_LABEL[c]}</option>)}
                      </select>
                    </label>
                    {draft.assetId && draft.assetName !== draft.assetId && (
                      <label className="field"><span>ISIN o símbolo</span>
                        <input className="input" value={draft.assetId} onChange={(e) => set('assetId', e.target.value.trim())} />
                      </label>
                    )}
                    {(draft.kind === 'buy' || draft.kind === 'sell') && foreign && (
                      <label className="field">
                        <span className="inline">Se paga en <Help text="EUR si el bróker cambia la moneda al momento, como el AutoFX de DEGIRO. La otra moneda si el dinero se queda en una cuenta en esa moneda." /></span>
                        <select className="input" value={draft.settleCurrency} onChange={(e) => set('settleCurrency', e.target.value)}>
                          <option value="EUR">Euros</option>
                          <option value={draft.currency}>{draft.currency}</option>
                        </select>
                      </label>
                    )}
                    {(draft.kind === 'dividend' || draft.kind === 'interest') && (
                      <NumField
                        label={<span className="inline">Retenido en España <Help text="Va en la casilla 0597 y se descuenta entero. Lo retenido fuera solo se descuenta hasta el límite del convenio." /></span>}
                        value={draft.spanishTaxEur ?? null}
                        onChange={(v) => set('spanishTaxEur', v || null)}
                      />
                    )}
                    {draft.kind === 'fee' && (
                      <label className="field">
                        <span className="inline">¿Deducible? <Help text="Solo son deducibles los gastos de administración y custodia de valores." /></span>
                        <select className="input" value={draft.feeClass ?? 'non_deductible'} onChange={(e) => set('feeClass', e.target.value as Operation['feeClass'])}>
                          <option value="non_deductible">No</option>
                          <option value="custody">Sí, es de custodia</option>
                        </select>
                      </label>
                    )}
                  </div>
                  <label className="field"><span>Nota</span>
                    <textarea className="input" rows={2} value={draft.note ?? ''} onChange={(e) => set('note', e.target.value)} />
                  </label>
                  {!isNew && (
                    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center' }}>
                      <button className="link muted small" onClick={() => void showHistory()}>Ver historial</button>
                      {op?.edited && op.original && <button className="link muted small" onClick={() => void restore()}>Volver a los valores originales</button>}
                      {!op?.deleted && <button className="link small" style={{ color: 'var(--loss)' }} onClick={() => void remove()}>{confirmDelete ? '¿Seguro? Pulsa otra vez' : 'Eliminar'}</button>}
                    </div>
                  )}
                  {history && (
                    <div className="stack small" style={{ gap: 4 }}>
                      {history.map((h, i) => <div key={i} className="muted">{new Date(h.at).toLocaleString('es-ES')} · {h.action}</div>)}
                    </div>
                  )}
                </div>
              </Disclosure>
              {error && <Callout tone="error">{error}</Callout>}
            </div>

            <div className="sheet-foot">
              {op?.deleted ? (
                <button className="btn primary" onClick={() => void undelete()}>Recuperar</button>
              ) : (
                <button className="btn primary" disabled={!rec.ok || saving || !draft.assetId || !dirty} onClick={() => void save()}>{saving ? 'Guardando…' : isNew ? 'Añadir' : 'Guardar'}</button>
              )}
              <button className="btn" onClick={close}>Cancelar</button>
            </div>
          </>
        );
      }}
    </Sheet>
  );
}
