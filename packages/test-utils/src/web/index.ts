// Web-side barrel — only loaded by the web workspace's tests.
// Server-side tests (api, integration) must NOT import from here, or
// they'll pull React + jsdom into a node environment.

export { renderWithProviders } from './render.js';
