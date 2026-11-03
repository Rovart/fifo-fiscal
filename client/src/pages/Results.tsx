import { BarChart3, ChevronRight, Coins, Percent, Sprout, Gift, Undo2, Landmark, type LucideIcon } from 'lucide-react';
import { useState } from 'react';
import { D } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Disposal, type DisposalClass, type FeeEntry, type Income, type LossTranche } from '../../../shared/types.ts';
import { BlockingBuys, groupLosses } from '../components/DeferredLoss.tsx';
import { Disclosure, Empty, Help, PageHead, Segmented } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, initial, isinOf, niceName, qty, signClass, signed, units } from '../format.ts';
import { useApi } from '../hooks.ts';

const CLASS_CHIPS: { id: DisposalClass; label: string }[] = [
  { id: 'stock', label: 'Acciones' }, { id: 'etf', label: 'ETF' }, { id: 'fund', label: 'Fondos' }, { id: 'crypto', label: 'Cripto' },
  { id: 'bond', label: 'Renta fija' }, { id: 'other', label: 'Otros' }, { id: 'fx', label: 'Monedas' },
];

function Sales() {
  const { year, tick } = useApp();
  const { data } = useApi<{ items: Disposal[]; tranches: LossTranche[] }>(`/disposals?year=${year}`, `${year}-${tick}`);
  const [open, setOpen] = useState<string | null>(null);
  const [klass, setKlass] = useState<DisposalClass | ''>('');
  if (!data) return null;
  if (data.items.length === 0) return <div className="card"><Empty icon={BarChart3} title={`Sin ventas en ${year}`} /></div>;
  const present = CLASS_CHIPS.filter((c) => data.items.some((d) => d.class === c.id));
  const items = data.items.filter((d) => !klass || d.class === klass).sort((a, b) => (a.date < b.date ? 1 : -1));
  const aplazadaOf = (id: string) => data.tranches.filter((t) => t.originDisposalId === id && t.status === 'blocked').reduce((s, t) => s.plus(D(t.amountEur)), D(0));
  const ganado = items.reduce((s, d) => s.plus(d.matches.reduce((m, x) => (D(x.gainEur).gt(0) ? m.plus(D(x.gainEur)) : m), D(0))), D(0));
  const perdido = items.reduce((s, d) => s.plus(d.matches.reduce((m, x) => (D(x.gainEur).lt(0) ? m.plus(D(x.gainEur)) : m), D(0))), D(0));
  const aplazado = items.reduce((s, d) => s.plus(aplazadaOf(d.id)), D(0));
  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="l">Ganado</div><div className="v gain">{signed(ganado.toFixed(2))}</div></div>
        <div className="stat-card"><div className="l">Perdido</div><div className="v loss">{signed(perdido.toFixed(2))}</div></div>
        {aplazado.gt(0) && <div className="stat-card"><div className="l">De lo perdido, aplazado <Help text={HELP.aplazada} /></div><div className="v">{eur(aplazado.toFixed(2))}</div></div>}
      </div>
      {present.length > 1 && (
        <div className="chips" role="group" aria-label="Filtrar">
          <button className={`chip ${klass === '' ? 'on' : ''}`} onClick={() => setKlass('')}>Todo</button>
          {present.map((c) => <button key={c.id} className={`chip ${klass === c.id ? 'on' : ''}`} onClick={() => setKlass(c.id)}>{c.label}</button>)}
        </div>
      )}
      <div className="card flush">
        <div className="list">
          {items.map((d) => {
            const isOpen = open === d.id;
            const gain = D(d.gainEur).toDecimalPlaces(2).toFixed(2);
            const blocked = aplazadaOf(d.id);
            const pending = data.tranches.find((t) => t.originDisposalId === d.id && t.status === 'pending_window');
            const blockedGroup = groupLosses(data.tranches.filter((t) => t.originDisposalId === d.id && t.status === 'blocked'))[0];
            const otherBroker = d.class !== 'fx' && d.matches.some((m) => m.broker && m.broker !== d.broker);
            return (
              <div key={d.id}>
                <button className="item tap" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : d.id)}>
                  <div className="avatar">{initial(d.assetName)}</div>
                  <div className="main-col">
                    <div className="title">{niceName(d.assetName)}</div>
                    <div className="sub">{units(d.quantity, d.class, d.assetId)} · {dateShort(d.date)}</div>
                  </div>
                  {blocked.gt(0) && <span className="tag warn">Aplazada</span>}
                  {D(d.shortfall).gt(0) && d.class !== 'fx' && <span className="tag loss">Faltan compras</span>}
                  {d.incomplete && <span className="tag loss">Sin precio</span>}
                  <div className="end">
                    <div className={`amount ${signClass(gain)}`}>{signed(gain)}</div>
                    <div className="sub">por {eur(D(d.proceedsEur).toFixed(2))}</div>
                  </div>
                  <ChevronRight size={16} className={`chevron ${isOpen ? 'open' : ''}`} />
                </button>
                {isOpen && (
                  <div className="expand">
                    {isinOf(d.assetId) && <div className="small muted" style={{ marginBottom: 6 }}>{d.assetId}</div>}
                    <table className="mini-table">
                      <thead><tr><th>Sale de la compra del</th><th className="r">Cantidad</th><th className="r">Costó</th><th className="r">Resultado</th></tr></thead>
                      <tbody>
                        {d.matches.map((m, i) => (
                          <tr key={i}>
                            <td>
                              {m.missing ? <span className="tag loss">No consta</span> : dateShort(m.acqDate)}
                              {otherBroker && m.broker && <div className="small muted">{BROKER_LABEL[m.broker]}</div>}
                            </td>
                            <td className="r">{qty(m.quantity)}</td>
                            <td className="r">{eur(D(m.costEur).toFixed(2))}</td>
                            <td className={`r ${signClass(m.gainEur)}`}>{signed(D(m.gainEur).toFixed(2))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {otherBroker && <p className="small muted" style={{ marginTop: 8 }}>Lo vendiste en {BROKER_LABEL[d.broker]}, pero para Hacienda salen primero tus compras más antiguas, también las de otros brókers.</p>}
                    {blockedGroup && (
                      <div style={{ marginTop: 8 }}>
                        <div className="small muted">{eur(blocked.toFixed(2))} de esta pérdida aún no cuentan. Contarán así:</div>
                        <BlockingBuys group={blockedGroup} />
                      </div>
                    )}
                    {pending && <p className="small muted" style={{ marginTop: 8 }}>Si vuelves a comprar antes del {dateShort(pending.windowEnd)}, esta pérdida se aplazará.</p>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

const INCOME_META: Record<Income['type'], { label: string; icon: LucideIcon }> = {
  dividend: { label: 'Dividendo', icon: Coins }, interest: { label: 'Interés', icon: Percent }, staking: { label: 'Staking', icon: Sprout },
  reward: { label: 'Regalo o airdrop', icon: Gift }, capital_excess: { label: 'Devolución de capital', icon: Undo2 }, bond: { label: 'Renta fija', icon: Landmark },
};

function Incomes() {
  const { year, tick } = useApp();
  const { data } = useApi<{ incomes: Income[]; fees: FeeEntry[] }>(`/incomes?year=${year}`, `${year}-${tick}`);
  if (!data) return null;
  if (data.incomes.length === 0 && data.fees.length === 0) return <div className="card"><Empty icon={Coins} title={`Sin dividendos ni intereses en ${year}`} /></div>;
  const sum = (k: 'grossEur' | 'foreignTaxEur' | 'spanishTaxEur' | 'netEur') => data.incomes.reduce((s, i) => s.plus(D(i[k])), D(0));
  const withheld = sum('foreignTaxEur').plus(sum('spanishTaxEur'));
  const incomes = [...data.incomes].sort((a, b) => (a.date < b.date ? 1 : -1));
  return (
    <>
      <div className="stat-grid">
        <div className="stat-card"><div className="l">Bruto</div><div className="v">{eur(sum('grossEur').toFixed(2))}</div></div>
        <div className="stat-card"><div className="l">Retenido <Help text={HELP.retencion} /></div><div className="v">{eur(withheld.toFixed(2))}</div></div>
        <div className="stat-card"><div className="l">Has cobrado</div><div className="v">{eur(sum('netEur').toFixed(2))}</div></div>
      </div>
      <div className="card flush">
        <div className="list">
          {incomes.map((i) => {
            const meta = INCOME_META[i.type];
            const Icon = meta.icon;
            const tax = D(i.foreignTaxEur).plus(D(i.spanishTaxEur));
            return (
              <div className="item" key={`${i.opId}${i.type}`}>
                <div className="avatar"><Icon size={17} /></div>
                <div className="main-col">
                  <div className="title">{niceName(i.assetName)}</div>
                  <div className="sub">{meta.label} · {BROKER_LABEL[i.broker]} · {dateShort(i.date)}</div>
                </div>
                <div className="end">
                  <div className="amount">{signed(D(i.grossEur).toFixed(2))}</div>
                  {tax.gt(0) && <div className="sub">retenido {eur(tax.toFixed(2))}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {data.fees.length > 0 && (
        <Disclosure card flush title={`Comisiones sueltas (${data.fees.length})`}>
          <div className="list">
            {data.fees.map((f) => (
              <div className="item" key={f.opId}>
                <div className="main-col">
                  <div className="title">{f.label}</div>
                  <div className="sub">{BROKER_LABEL[f.broker]} · {dateShort(f.date)}{f.feeClass === 'custody' ? ' · deducible' : ''}</div>
                </div>
                <div className="end"><div className="amount">{eur(D(f.amountEur).toFixed(2))}</div></div>
              </div>
            ))}
          </div>
        </Disclosure>
      )}
    </>
  );
}

export function Results() {
  const [tab, setTab] = useState<'sales' | 'income'>('sales');
  return (
    <>
      <PageHead title="Resultados" year />
      <div><Segmented label="Tipo de resultado" value={tab} onChange={setTab} options={[{ id: 'sales', label: 'Ventas' }, { id: 'income', label: 'Dividendos e intereses' }]} /></div>
      {tab === 'sales' ? <Sales /> : <Incomes />}
    </>
  );
}
