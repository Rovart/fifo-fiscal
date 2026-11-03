import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

export function useApi<T>(path: string | null, tick: string | number = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const load = useCallback(() => {
    if (!path) return;
    const id = ++latest.current;
    api<T>(path)
      .then((d) => { if (id === latest.current) { setData(d); setError(null); } })
      .catch((e: Error) => { if (id === latest.current) setError(e.message); });
  }, [path]);
  useEffect(() => { load(); return () => { latest.current++; }; }, [load, tick]);
  return { data, error, reload: load };
}
