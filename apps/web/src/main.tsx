import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import './styles.css';

/**
 * Entry point.
 *
 * The session is restored INSIDE the app rather than here, so a failed exchange
 * renders the login page instead of an unhandled rejection before React has
 * mounted anything. See `App`.
 */
const container = document.getElementById('root');
if (container === null) {
  throw new Error('The #root element is missing from index.html.');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
