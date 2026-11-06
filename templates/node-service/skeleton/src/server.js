'use strict';
const { createApp, SERVICE_NAME, VERSION } = require('./app');

const port = Number(process.env.PORT || 8080);
const server = createApp().listen(port, () => {
  console.log(JSON.stringify({ level: 'info', msg: 'starting', service: SERVICE_NAME, version: VERSION, port }));
});

// Graceful shutdown on SIGTERM (Kubernetes / Cloud Run) or Ctrl+C.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(JSON.stringify({ level: 'info', msg: 'shutting down', signal }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
