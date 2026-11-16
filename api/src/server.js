import { config } from './config.js';
import { createApp } from './app.js';
import { createLedger } from './ledger.js';

const ledger = createLedger(config.databaseUrl);
const app = createApp({ token: config.token, ledger });

const server = app.listen(config.port, () => {
  console.log(`wallet ledger API listening on port ${config.port}`);
});

// Graceful shutdown (docker compose stop sends SIGTERM): stop accepting new
// connections, let in-flight requests finish, then close the database pool.
let shuttingDown = false;

// Keep-alive clients reuse their connection for the next request, so a busy
// connection would never close. Once shutting down, every response tells the
// client to close the connection after it.
server.prependListener('request', (req, res) => {
  if (shuttingDown) res.setHeader('Connection', 'close');
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  server.close(async () => {
    await ledger.close();
    process.exit(0);
  });
  server.closeIdleConnections();
  // Don't hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
