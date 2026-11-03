import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import '@fontsource-variable/inter';
import './styles.css';
import { applyTheme, loadTheme } from './theme.ts';

applyTheme(loadTheme());

createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
