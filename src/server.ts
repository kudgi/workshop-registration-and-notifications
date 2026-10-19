import { loadConfig } from './config.js';
import { createApp } from './api/app.js';
import { AppDatabase } from './db/database.js';
import { OutboxWorker } from './worker/outbox-worker.js';

const config = loadConfig();
const db = new AppDatabase(config.DATABASE_PATH);
const app = createApp(db, config.API_KEY);
const worker = new OutboxWorker(db, {
  notifierUrl: config.NOTIFIER_URL,
  concurrency: config.WORKER_CONCURRENCY,
  timeoutMs: config.NOTIFY_TIMEOUT_MS,
  maxAttempts: config.MAX_ATTEMPTS,
  pollIntervalMs: config.POLL_INTERVAL_MS,
  backoffBaseMs: config.BACKOFF_BASE_MS,
  backoffMaxMs: config.BACKOFF_MAX_MS,
  leaseMs: config.LEASE_DURATION_MS,
  logger: console
});
await app.listen({ port: config.PORT, host: '0.0.0.0' });
worker.start();
const shutdown = async () => {
  await worker.stop();
  await app.close();
  db.close();
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
