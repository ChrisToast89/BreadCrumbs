import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// See I7 — no localStorage, sessionStorage, or IndexedDB anywhere in the
// renderer. All persistence goes through IPC to disk in the main process.

const container = document.getElementById('root');
if (!container) throw new Error('Root element is missing from index.html');

createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
