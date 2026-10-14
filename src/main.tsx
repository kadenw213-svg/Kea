import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import './styles/home.css';
import './styles/settings.css';
import { loadSettings } from './lib/settings';

// Settings load first so the app starts with the right look and behaviour.
loadSettings()
  .catch((err) => console.error('settings', err))
  .finally(() => createRoot(document.getElementById('root')!).render(<App />));
