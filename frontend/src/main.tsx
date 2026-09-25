import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { registerAetherServiceWorker } from './services/pwaService';

registerAetherServiceWorker().catch((err) => {
  console.error('AETHER service worker registration failed:', err);
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
