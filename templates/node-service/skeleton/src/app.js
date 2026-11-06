'use strict';
// ${{ values.name }}: CastorX service with a small REST API and Prometheus metrics.
const express = require('express');
const client = require('prom-client');

const SERVICE_NAME = '${{ values.name }}';
const VERSION = process.env.APP_VERSION || '0.1.0';

// ---- Metrics ------------------------------------------------------------------

const register = new client.Registry();
client.collectDefaultMetrics({ register }); // process & Node.js runtime metrics

const httpRequests = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests by method, route and status code.',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency in seconds.',
  labelNames: ['method', 'route'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const greetings = new client.Counter({
  name: 'hello_greetings_total',
  help: 'Number of greetings served, by whether a custom name was given.',
  labelNames: ['named'],
  registers: [register],
});

const itemsGauge = new client.Gauge({
  name: 'hello_items',
  help: 'Current number of items in the in-memory store.',
  registers: [register],
});

new client.Gauge({
  name: 'app_info',
  help: 'Static application info.',
  labelNames: ['service', 'version', 'language'],
  registers: [register],
}).set({ service: SERVICE_NAME, version: VERSION, language: 'nodejs' }, 1);

const UNINSTRUMENTED = new Set(['/healthz', '/readyz', '/metrics']);

// ---- In-memory store ------------------------------------------------------------

function createStore() {
  let nextId = 1;
  const items = new Map();
  return {
    list: () => [...items.values()],
    get: (id) => items.get(id),
    create(name) {
      const item = { id: nextId++, name, createdAt: new Date().toISOString() };
      items.set(item.id, item);
      itemsGauge.set(items.size);
      return item;
    },
    delete(id) {
      const removed = items.delete(id);
      itemsGauge.set(items.size);
      return removed;
    },
  };
}

// ---- App --------------------------------------------------------------------------

function createApp(store = createStore()) {
  const app = express();
  app.use(express.json());

  // Metrics + access log middleware. Uses the matched route template
  // (e.g. /api/items/:id) to keep label cardinality bounded.
  app.use((req, res, next) => {
    if (UNINSTRUMENTED.has(req.path)) return next();
    const end = httpDuration.startTimer();
    res.on('finish', () => {
      const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
      const seconds = end({ method: req.method, route });
      httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
      console.log(JSON.stringify({ level: 'info', msg: 'request', method: req.method, path: req.path, status: res.statusCode, duration_ms: Math.round(seconds * 1000) }));
    });
    next();
  });

  app.get('/', (req, res) => {
    res.json({ message: 'Hello, World!', service: SERVICE_NAME, version: VERSION });
  });

  app.get('/api/hello', (req, res) => {
    const name = typeof req.query.name === 'string' && req.query.name ? req.query.name : null;
    greetings.inc({ named: String(Boolean(name)) });
    res.json({ message: `Hello, ${name || 'World'}!` });
  });

  app.get('/api/items', (req, res) => res.json(store.list()));

  app.post('/api/items', (req, res) => {
    const name = req.body && req.body.name;
    if (typeof name !== 'string' || name.length === 0) {
      return res.status(400).json({ error: "body must be JSON with a non-empty 'name'" });
    }
    res.status(201).json(store.create(name));
  });

  const parseId = (req, res) => {
    const id = Number.parseInt(req.params.id, 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ error: 'id must be an integer' });
      return null;
    }
    return id;
  };

  app.get('/api/items/:id', (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    const item = store.get(id);
    if (!item) return res.status(404).json({ error: 'item not found' });
    res.json(item);
  });

  app.delete('/api/items/:id', (req, res) => {
    const id = parseId(req, res);
    if (id === null) return;
    if (!store.delete(id)) return res.status(404).json({ error: 'item not found' });
    res.status(204).end();
  });

  app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
  app.get('/readyz', (req, res) => res.json({ status: 'ready' }));
  app.get('/metrics', async (req, res) => {
    res.set('Content-Type', register.contentType);
    res.send(await register.metrics());
  });

  return app;
}

module.exports = { createApp, register, SERVICE_NAME, VERSION };
