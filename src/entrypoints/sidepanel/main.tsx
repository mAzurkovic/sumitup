import { createRoot } from 'react-dom/client';
import { App } from './App';
import './style.css';

const tabId = new URLSearchParams(location.search).get('tabId');

// The worker opens the panel with its tab ID, and a port without one would be dropped and opened again forever.
if (tabId && /^\d+$/.test(tabId)) createRoot(document.getElementById('root')!).render(<App tabId={Number(tabId)} />);
