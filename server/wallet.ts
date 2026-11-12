import { randomUUID } from 'node:crypto';
import { D, type Decimal } from '../shared/decimal.ts';
import type { Operation } from '../shared/types.ts';
import { addHistory, bump, db, getOp, hasSourceKey, putOp, rateAt } from './db.ts';
import { applyGas, detectSwaps, isAddress, type ChainData, type InternalTx, type NormalTx, type TokenTransfer } from './importers/ethereum.ts';
import { yf } from './quotes.ts';
import { ValidationError, assetsMap, deleteOp, registerAsset, restoreDeleted, withAssetMeta } from './service.ts';

const API = 'https://eth.blockscout.com/api/v2/addresses';
const MAX_PAGES = 200;

/** Lee todas las páginas de una lista de Blockscout. Solo se envía la dirección pública del wallet. */
async function pages<T>(address: string, list: string): Promise<T[]> {
  const out: T[] = [];
  let next: Record<string, unknown> | null = {};
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const query = new URLSearchParams(Object.entries(next).map(([k, v]) => [k, String(v)]));
    const url = `${API}/${address}/${list}${query.size ? `?${query}` : ''}`;
    let res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get('x-ratelimit-reset')) || 5000, 40_000)));
      res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    }
    if (res.status === 404) return out;
    if (!res.ok) throw new Error(`Blockscout respondió ${res.status}. Inténtalo de nuevo en unos minutos.`);
    const data = (await res.json()) as { items?: T[]; next_page_params?: Record<string, unknown> | null };
    if (!Array.isArray(data.items)) throw new Error('Blockscout no pudo leer esa dirección.');
    out.push(...data.items);
    next = data.next_page_params ?? null;
  }
  if (next) throw new Error('Este wallet tiene demasiados movimientos para leerlo entero.');
  return out;
}

interface Party { hash: string }
interface RawTransfer { transaction_hash: string; timestamp: string | null; from: Party; to: Party | null; token: { address_hash?: string; address?: string; symbol: string | null; name: string | null; type: string }; total?: { value?: string; decimals?: string | null; token_id?: string | null } }
interface RawTx { hash: string; timestamp: string | null; from: Party; to: Party | null; value: string; fee?: { value: string | null }; status: string | null }
interface RawInternal { transaction_hash: string; timestamp: string | null; from: Party; to: Party | null; value: string; success: boolean }
const unix = (iso: string) => String(Math.floor(Date.parse(iso) / 1000));

export async function fetchChain(address: string): Promise<ChainData> {
  const transfers = (await pages<RawTransfer>(address, 'token-transfers')).filter((r) => r.timestamp).map((r): TokenTransfer => ({
    hash: r.transaction_hash, timeStamp: unix(r.timestamp!), from: r.from.hash, to: r.to?.hash ?? '', value: r.total?.value ?? '0', contractAddress: r.token.address_hash ?? r.token.address ?? '',
    tokenSymbol: r.token.symbol, tokenName: r.token.name, tokenDecimal: r.token.type === 'ERC-20' ? r.total?.decimals : '', tokenID: r.total?.token_id,
  }));
  // Una transacción pendiente aún no tiene fecha ni resultado.
  const txs = (await pages<RawTx>(address, 'transactions')).filter((r) => r.timestamp && r.status).map((r): NormalTx => ({
    hash: r.hash, timeStamp: unix(r.timestamp!), from: r.from.hash, to: r.to?.hash ?? '', value: r.value, fee: r.fee?.value ?? '0', isError: r.status === 'error' ? '1' : '0',
  }));
  const internals = (await pages<RawInternal>(address, 'internal-transactions')).filter((r) => r.timestamp).map((r): InternalTx => ({
    transactionHash: r.transaction_hash, timeStamp: unix(r.timestamp!), from: r.from.hash, to: r.to?.hash ?? '', value: r.value, isError: r.success ? '0' : '1',
  }));
  return { transfers, txs, internals };
}

/** Cierre diario del ETH en euros (Yahoo), para valorar el gas. Sin precio, la permuta queda sin ese gasto. */
async function ethDailyEur(dates: string[]): Promise<(date: string) => Decimal | null> {
  const sorted = [...new Set(dates)].sort();
  const prices = new Map<string, Decimal>();
  if (sorted.length) {
    const until = new Date(Date.parse(`${sorted.at(-1)}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
    const chart = (await yf.chart('ETH-EUR', { period1: sorted[0]!, period2: until, interval: '1d' }, { validateResult: false }).catch(() => null)) as { quotes?: { date: Date | string; close?: number | null }[] } | null;
    for (const q of chart?.quotes ?? []) if (q.close) prices.set(new Date(q.date).toISOString().slice(0, 10), D(q.close));
  }
  return (date) => prices.get(date) ?? null;
}

interface WalletSummary { newOps: number; duplicates: number; from: string | null; to: string | null; ignored: Record<string, number> }
const walletRow = (address: string) => db.prepare("SELECT id FROM imports WHERE broker = 'ethereum' AND lower(file) = ?").get(address.toLowerCase()) as { id: string } | undefined;

/** Guarda las permutas nuevas del wallet. Las que ya constan, también las desmarcadas, no se repiten. */
export function saveWallet(address: string, data: ChainData, ethEur: (date: string) => Decimal | null = () => null) {
  const { swaps, ignored } = detectSwaps(address, data, rateAt);
  const fresh = swaps.filter((s) => !hasSourceKey(s.op.sourceKey!));
  applyGas(fresh, ethEur);
  const assets = assetsMap();
  db.exec('BEGIN');
  try {
    const importId = walletRow(address)?.id ?? randomUUID();
    for (const { op } of fresh) {
      op.importId = importId;
      op.original = { ...op, original: undefined };
      putOp(op);
      registerAsset(assets, op.assetId, op.assetName, 'crypto');
      registerAsset(assets, op.counterAsset!, op.counterName ?? op.counterAsset!, 'crypto');
      addHistory(op.id, 'importada', null, op);
      db.prepare('INSERT OR IGNORE INTO import_operations (import_id, op_id) VALUES (?, ?)').run(importId, op.id);
    }
    const dates = (db.prepare('SELECT MIN(datetime) AS "from", MAX(datetime) AS "to" FROM operations WHERE import_id = ?').get(importId) ?? {}) as { from: string | null; to: string | null };
    const summary: WalletSummary = { newOps: fresh.length, duplicates: swaps.length - fresh.length, from: dates.from?.slice(0, 10) ?? null, to: dates.to?.slice(0, 10) ?? null, ignored };
    db.prepare(`INSERT INTO imports (id, at, file, broker, format, summary) VALUES (?, ?, ?, 'ethereum', 'Wallet', ?)
      ON CONFLICT(id) DO UPDATE SET at = excluded.at, summary = excluded.summary`).run(importId, new Date().toISOString(), address, JSON.stringify(summary));
    db.exec('COMMIT');
    bump();
    return { importId, added: fresh.length, found: swaps.length, ignored };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export async function syncWallet(raw: string) {
  const address = (raw ?? '').trim();
  if (!isAddress(address)) throw new ValidationError('Eso no parece una dirección de Ethereum: empieza por 0x y tiene 42 caracteres.', null);
  const data = await fetchChain(address);
  const dates = detectSwaps(address, data, rateAt).swaps.filter((s) => s.gasEth.gt(0) && !hasSourceKey(s.op.sourceKey!)).map((s) => s.op.datetime.slice(0, 10));
  return saveWallet(address, data, await ethDailyEur(dates));
}

export function listWallets() {
  const rows = db.prepare("SELECT id, at, file, summary FROM imports WHERE broker = 'ethereum' ORDER BY rowid").all() as { id: string; at: string; file: string; summary: string }[];
  const assets = assetsMap();
  return rows.map((r) => {
    // Incluye las desmarcadas, que se guardan como eliminadas, para poder volver a marcarlas.
    const ops = (db.prepare("SELECT data FROM operations WHERE import_id = ? AND kind = 'swap' ORDER BY datetime DESC").all(r.id) as { data: string }[]).map((x) => JSON.parse(x.data) as Operation);
    return { id: r.id, address: r.file, at: r.at, ignored: (JSON.parse(r.summary) as WalletSummary).ignored ?? {}, swaps: withAssetMeta(ops, assets) };
  });
}

/** Marcar una permuta la cuenta en el FIFO; desmarcarla la deja fuera sin perderla. */
export function includeSwaps(ids: string[], included: boolean): number {
  let changed = 0;
  for (const id of ids) {
    const op = getOp(id);
    if (!op || op.broker !== 'ethereum' || !op.deleted === included) continue;
    if (included) restoreDeleted(id); else deleteOp(id);
    changed++;
  }
  return changed;
}
