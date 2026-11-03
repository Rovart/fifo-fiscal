import type { Asset, Operation, Profile, Settings } from '../../shared/types.ts';

let profileId = (() => { try { return localStorage.getItem('fifo-profile') || 'default'; } catch { return 'default'; } })();
export const getProfileId = () => profileId;
export function selectProfile(id: string) {
  profileId = id;
  try { localStorage.setItem('fifo-profile', id); } catch { /* Solo para esta visita. */ }
}

export interface AppState {
  profileId: string;
  profiles: Profile[];
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

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; profileId?: string } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'X-Fifo-Profile': opts.profileId ?? profileId, ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; detail?: unknown };
  if (!res.ok) throw new ApiError(data.error ?? `Error ${res.status}`, data.detail);
  return data as T;
}

export type OpRow = Operation & { _issue?: string | null };
