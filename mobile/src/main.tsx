// (First: the screens shared with Kea on the PC read window.api when they load.)
import './install';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './kit.css';
import './styles.css';
import '../../src/styles/scholar.css';
// (Last: the phone's own sizing wins over the laptop's.)
import './screens.css';

createRoot(document.getElementById('root')!).render(<App />);
