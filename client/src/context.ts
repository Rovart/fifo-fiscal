import { createContext, useContext } from 'react';
import type { Operation } from '../../shared/types.ts';
import type { AppState } from './api.ts';

export type Page = 'home' | 'upload' | 'review' | 'renta' | 'movements' | 'portfolio' | 'results' | 'dividends' | 'performance' | 'whatif' | 'settings';

export interface AppCtx {
  state: AppState;
  year: number;
  setYear: (y: number) => void;
  tick: number;
  /** Refresca los datos y, si se indica, muestra un mensaje. */
  changed: (message?: string) => void;
  toast: (message: string) => void;
  go: (page: Page) => void;
  openEditor: (op: Operation | null, prefill?: Partial<Operation>) => void;
  switchProfile: (id: string) => void;
}

export const Ctx = createContext<AppCtx | null>(null);
export const useApp = (): AppCtx => useContext(Ctx) as AppCtx;
