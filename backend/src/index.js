const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const db = require('./db');
const timing = require('./timing');

const compression = require('compression');

const app = express();

app.use(compression());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '15mb' }));
app.use(timing.middleware);

app.use('/auth', require('./routes/auth'));
app.use('/training', require('./routes/training'));

app.get('/health', (_, res) => res.json({ ok: true }));

// Serve the built React app (single-origin). Mounted after the API routers so
// they take precedence; anything else falls through to the SPA entry point.
const dist = path.join(__dirname, '../../frontend/dist');
// Vite fingerprints everything in assets/ (name-hash.js), so those can be cached forever;
// index.html must always revalidate so a deploy is picked up on the next load.
app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(dist, { setHeaders: res => res.set('Cache-Control', 'no-cache') }));
app.get('*', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(dist, 'index.html')));

const PORT = process.env.PORT || 3000;

db.init()
  .then(() => app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`)))
  .catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
