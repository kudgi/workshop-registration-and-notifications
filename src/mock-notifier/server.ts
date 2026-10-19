import { loadConfig } from '../config.js';
import { createMockNotifierApp, type MockNotifierState } from './app.js';

const config = loadConfig();
const state: MockNotifierState = {
  alwaysDown: false,
  received: [],
  duplicateCount: 0,
  errorRate: config.ERROR_RATE,
  timeoutRate: config.TIMEOUT_RATE,
  delayMs: config.DELAY_MS
};
const app = createMockNotifierApp(state);
await app.listen({ port: config.MOCK_PORT, host: '0.0.0.0' });
const shutdown = async () => { await app.close(); };
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
