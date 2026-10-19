import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'http://localhost:3100';
const mock = 'http://localhost:4100';
const key = 'demo-key';
const databasePath = join(root, 'data', `demo-${Date.now()}.db`);
const headers = { 'content-type': 'application/json', 'x-api-key': key };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const processes: ChildProcess[] = [];
const request = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const body = await response.json();
  console.log(response.status, url, JSON.stringify(body, null, 2));
  return body;
};

async function waitFor(url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fetch(url); return; } catch { await wait(100); }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function start(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), script], {
    cwd: root, env: { ...process.env, ...env }, stdio: 'inherit'
  });
  processes.push(child);
  return child;
}

try {
  console.log('Starting backend and mock notifier');
  start('src/mock-notifier/server.ts', { MOCK_PORT: '4100', API_KEY: key, ERROR_RATE: '0', TIMEOUT_RATE: '0' });
  let backend = start('src/server.ts', {
    PORT: '3100', MOCK_PORT: '4100', API_KEY: key, DATABASE_PATH: databasePath,
    NOTIFIER_URL: mock, POLL_INTERVAL_MS: '50', CLIENT_TIMEOUT_MS: '100'
  });
  await waitFor(`${mock}/received`);
  await waitFor(`${api}/notifications`);

  console.log('Create workshop');
  const workshop = await request(`${api}/workshops`, {
    method: 'POST', headers, body: JSON.stringify({ title: 'Reliable Systems', description: 'Outbox demo', capacity: 10, startsAt: '2030-01-01T10:00:00.000Z' })
  });
  console.log('Register members');
  for (const member of ['alice', 'bob', 'carol']) {
    await request(`${api}/workshops/${workshop.id}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId: member, email: `${member}@example.com` }) });
  }
  await wait(500);
  console.log('Confirmations received');
  await request(`${mock}/received`);
  console.log('Take notifier down and register more');
  await request(`${mock}/admin/down`, { method: 'POST' });
  await request(`${api}/workshops/${workshop.id}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId: 'dave', email: 'dave@example.com' }) });
  await wait(250);
  console.log('Kill backend mid-delivery, then restart it');
  backend.kill('SIGTERM');
  await wait(300);
  backend = start('src/server.ts', {
    PORT: '3100', MOCK_PORT: '4100', API_KEY: key, DATABASE_PATH: databasePath,
    NOTIFIER_URL: mock, POLL_INTERVAL_MS: '50', CLIENT_TIMEOUT_MS: '100'
  });
  await waitFor(`${api}/notifications`);
  console.log('Bring notifier back and show recovery');
  await request(`${mock}/admin/up`, { method: 'POST' });
  await wait(1000);
  await request(`${mock}/received`);
  console.log('Cancel workshop and show cancellation notifications');
  await request(`${api}/workshops/${workshop.id}/cancel`, { method: 'POST', headers: { 'x-api-key': key } });
  await wait(500);
  await request(`${mock}/received`);
} finally {
  for (const child of processes) if (child.pid) child.kill('SIGTERM');
}
