const { AsyncLocalStorage } = require('async_hooks');

// Per-request timing buckets (Strava vs DB), reported as a Server-Timing header so the
// browser's Network tab shows where each API request spent its time.
const als = new AsyncLocalStorage();

function middleware(req, res, next) {
  const store = { start: process.hrtime.bigint(), strava: 0, stravaCalls: 0, db: 0 };
  const json = res.json.bind(res);
  res.json = body => {
    if (!res.headersSent) {
      const total = Number(process.hrtime.bigint() - store.start) / 1e6;
      res.set('Server-Timing', [
        `strava;dur=${store.strava.toFixed(1)};desc="${store.stravaCalls} call${store.stravaCalls === 1 ? '' : 's'}"`,
        `db;dur=${store.db.toFixed(1)}`,
        `total;dur=${total.toFixed(1)}`,
      ].join(', '));
    }
    return json(body);
  };
  als.run(store, next);
}

// Time an async call into one of the buckets (no-op outside a request)
async function track(bucket, fn) {
  const store = als.getStore();
  if (!store) return fn();
  const t = process.hrtime.bigint();
  try {
    return await fn();
  } finally {
    store[bucket] += Number(process.hrtime.bigint() - t) / 1e6;
    if (bucket === 'strava') store.stravaCalls++;
  }
}

module.exports = { middleware, track };
