export type Theme = 'auto' | 'light' | 'dark';

export const loadTheme = (): Theme => {
  try {
    return (localStorage.getItem('tema') as Theme) || 'auto';
  } catch {
    return 'auto';
  }
};

export function applyTheme(t: Theme) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('tema', t); } catch { /* sin almacenamiento, vale para esta visita */ }
}
