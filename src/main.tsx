import { createRoot } from 'react-dom/client';
import { App } from './app';
import './styles.css';
import './theme.css';
import './workspace.css';

createRoot(document.getElementById('root')!).render(<App />);
