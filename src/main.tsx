import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.css';
import './styles/home.css';

createRoot(document.getElementById('root')!).render(<App />);
