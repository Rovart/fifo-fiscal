import type { Asset, Operation, Settings } from '../../shared/types.ts';

export interface AppState {
  settings: Settings;
  assets: Asset[];
  years: number[];
  today: string;
  dbPath: string;
  latestRate: string | null;
  counts: { operations: number; byYear: Record<number, { errors: number; warnings: number }>; missingValues: number };
}

export class ApiError extends Error {
  detail: unknown;
  constructor(message: string, detail?: unknown) { super(message); this.detail = detail; }
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: unknown };
  if (!res.ok) throw new ApiError(data.error ?? `Error ${res.status}`, data.detail);
  return data as T;
}

export type OpRow = Operation & { _issue?: string | null };
