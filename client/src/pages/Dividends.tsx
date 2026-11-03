import { ChevronRight, Coins } from 'lucide-react';
import { useState } from 'react';
import { D } from '../../../shared/decimal.ts';
import { BROKER_LABEL, type Income } from '../../../shared/types.ts';
import { Empty, Help, Loading, PageHead, Segmented } from '../components/ui.tsx';
import { useApp } from '../context.ts';
import { HELP } from '../glossary.ts';
import { dateShort, eur, initial, isinOf, niceName } from '../format.ts';
import { useApi } from '../hooks.ts';

interface Totals { gross: ReturnType<typeof D>; withheld: ReturnType<typeof D>; net: ReturnType<typeof D>; count: number }

const totals = (items: Income[]): Totals => items.reduce((t, i) => ({
  gross: t.gross.plus(D(i.grossEur)), withheld: t.withheld.plus(D(i.foreignTaxEur)).plus(D(i.spanishTaxEur)), net: t.net.plus(D(i.netEur)), count: t.count + 1,
}), { gross: D(0), withheld: D(0), net: D(0), count: 0 });

const payments = (n: number) => (n === 1 ? '1 cobro' : `${n} cobros`);

export function Dividends() {
  const { tick, go } = useApp();
  const { data } = useApi<{ items: Income[] }>('/dividends', `${tick}`);
  const [scope, setScope] = useState<string>('all');
  const [open, setOpen] = useState<string | null>(null);
  if (!data) return <><PageHead title="Dividendos" /><Loading /></>;
  if (data.items.length === 0) {
    return (
      <>
        <PageHead title="Dividendos" />
        <div className="card"><Empty icon={Coins} title="Aún no hay dividendos"><button className="btn primary" onClick={() => go('upload')}>Subir mis extractos</button></Empty></div>
      </>
    );
  }
  const years = [...new Set(data.items.map((i) => i.year))].sort((a, b) => b - a);
  const shown = scope === 'all' ? data.items : data.items.filter((i) => String(i.year) === scope);
  const sum = totals(shown);
  const assets = [...shown.reduce((m, i) => m.set(i.assetId, [...(m.get(i.assetId) ?? []), i]), new Map<string, Income[]>())]
    .map(([assetId, items]) => ({ assetId, items: items.sort((a, b) => (a.date < b.date ? 1 : -1)), ...totals(items) }))
    .sort((a, b) => b.gross.cmp(a.gross));

  return (
    <>
      <PageHead title="Dividendos" />
      <div className="dividends-scope"><Segmented label="Periodo" value={scope} onChange={(v) => { setScope(v); setOpen(null); }} options={[{ id: 'all', label: 'Todos' }, ...years.map((y) => ({ id: String(y), label: String(y) }))]} /></div>
      <div className="stat-grid">
        <div className="stat-card"><div className="l">Bruto</div><div className="v">{eur(sum.gross.toFixed(2))}</div><div className="small faint">{payments(sum.count)}</div></div>
        <div className="stat-card"><div className="l">Retenido <Help text={HELP.retencion} /></div><div className="v">{eur(sum.withheld.toFixed(2))}</div></div>
        <div className="stat-card"><div className="l">Has cobrado</div><div className="v">{eur(sum.net.toFixed(2))}</div></div>
      </div>

      {scope === 'all' && (
        <div className="card">
          <h2>Por año</h2>
          <table className="mini-table">
            <thead><tr><th>Año</th><th className="r">Bruto</th><th className="r wide-only">Retenido</th><th className="r">Neto</th></tr></thead>
            <tbody>
              {years.map((y) => {
                const t = totals(data.items.filter((i) => i.year === y));
                return (
                  <tr key={y}>
                    <td><button className="link" onClick={() => setScope(String(y))}>{y}</button> <span className="faint small">· {payments(t.count)}</span></td>
                    <td className="r">{eur(t.gross.toFixed(2))}</td>
                    <td className="r wide-only">{eur(t.withheld.toFixed(2))}</td>
                    <td className="r">{eur(t.net.toFixed(2))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="card flush">
        <div className="card-title"><h2>Por activo</h2></div>
        <div className="list">
          {assets.map((a) => {
            const name = niceName(a.items[0]?.assetName ?? a.assetId);
            const brokers = [...new Set(a.items.map((i) => BROKER_LABEL[i.broker]))].join(', ');
            const isOpen = open === a.assetId;
            return (
              <div key={a.assetId}>
                <button className="item tap" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : a.assetId)}>
                  <div className="avatar">{initial(name)}</div>
                  <div className="main-col">
                    <div className="title">{name}</div>
                    <div className="sub">{payments(a.count)} · {brokers}</div>
                  </div>
                  <div className="end">
                    <div className="amount">{eur(a.gross.toFixed(2))}</div>
                    <div className="sub">{a.withheld.gt(0) ? `retenido ${eur(a.withheld.toFixed(2))}` : 'sin retención'}</div>
                  </div>
                  <ChevronRight size={16} className={`chevron ${isOpen ? 'open' : ''}`} />
                </button>
                {isOpen && (
                  <div className="expand">
                    {isinOf(a.assetId) && <div className="small muted" style={{ marginBottom: 6 }}>{isinOf(a.assetId)}</div>}
                    <table className="mini-table">
                      <thead><tr><th>Fecha</th><th className="r">Bruto</th><th className="r wide-only">Retenido</th><th className="r">Neto</th></tr></thead>
                      <tbody>
                        {a.items.map((i) => (
                          <tr key={i.opId}>
                            <td>{dateShort(i.date)} <span className="faint small">· {BROKER_LABEL[i.broker]}</span></td>
                            <td className="r">{eur(D(i.grossEur).toFixed(2))}</td>
                            <td className="r wide-only">{eur(D(i.foreignTaxEur).plus(D(i.spanishTaxEur)).toFixed(2))}</td>
                            <td className="r">{eur(D(i.netEur).toFixed(2))}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
