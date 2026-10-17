import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import '../../src/styles/scholar.css';

createRoot(document.getElementById('root')!).render(<App />);
