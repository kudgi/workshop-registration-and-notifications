import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const api = 'http://localhost:3100';
const mock = 'http://localhost:4100';
const key = 'demo-key';
const databasePath = join(root, 'data', `demo-${Date.now()}.db`);
const jsonHeaders = { 'content-type': 'application/json' };
const organizerHeaders = { ...jsonHeaders, 'x-api-key': key };
const processes: ChildProcess[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const body = await response.json();
  console.log(`${response.status} ${url} ${JSON.stringify(body)}`);
  return body;
}

async function waitFor(url: string, predicate: (body: any) => boolean = () => true, init?: RequestInit): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      console.log(`${response.status} ${url} ${JSON.stringify(body)}`);
      if (predicate(body)) return body;
    } catch {
      // The child process may still be starting.
    }
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function start(file: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, [join(root, 'dist', file)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit'
  });
  processes.push(child);
  return child;
}

async function register(workshopId: string, memberId: string): Promise<void> {
  await request(`${api}/workshops/${workshopId}/register`, {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ memberId, email: `${memberId}@example.com` })
  });
}

let passed = true;
let backend: ChildProcess | undefined;

try {
  console.log('\n1. START SERVICES');
  start('mock-notifier/server.js', { MOCK_PORT: '4100', ERROR_RATE: '0', TIMEOUT_RATE: '0' });
  backend = start('server.js', {
    PORT: '3100',
    API_KEY: key,
    DATABASE_PATH: databasePath,
    NOTIFIER_URL: mock,
    POLL_INTERVAL_MS: '50',
    NOTIFY_TIMEOUT_MS: '100',
    LEASE_DURATION_MS: '250'
  });
  await waitFor(`${mock}/received`);
  await waitFor(`${api}/notifications`, () => true, { headers: { 'x-api-key': key } });

  console.log('\n2. CREATE WORKSHOP');
  const workshop = await request(`${api}/workshops`, {
    method: 'POST',
    headers: organizerHeaders,
    body: JSON.stringify({ title: 'Reliable Systems', description: 'Outbox demo', capacity: 20, startsAt: '2030-01-01T10:00:00.000Z' })
  });
  const workshopId = workshop.id as string;

  console.log('\n3. REGISTER MEMBERS; CONFIRMATIONS ARRIVE');
  for (const member of ['alice', 'bob', 'carol']) await register(workshopId, member);
  await waitFor(`${mock}/received`, (body) => body.count === 3);

  console.log('\n4. NOTIFIER DOWN; REGISTER MORE MEMBERS');
  await request(`${mock}/admin/down`, { method: 'POST' });
  await register(workshopId, 'dave');
  await register(workshopId, 'erin');
  await wait(400);
  const pendingDuringOutage = await request(`${api}/notifications?status=PENDING`, { headers: { 'x-api-key': key } });
  const inProgressDuringOutage = await request(`${api}/notifications?status=IN_PROGRESS`, { headers: { 'x-api-key': key } });
  console.log(`Retries visible: pending=${pendingDuringOutage.notifications.length}, inProgress=${inProgressDuringOutage.notifications.length}`);

  console.log('\n5. NOTIFIER UP; RETRIES RECOVER');
  await request(`${mock}/admin/up`, { method: 'POST' });
  await waitFor(`${mock}/received`, (body) => body.count === 5);

  console.log('\n6. RESTART RECOVERY: CREATE PENDING ROWS, SIGKILL BACKEND, RESTART');
  await request(`${mock}/admin/down`, { method: 'POST' });
  await register(workshopId, 'frank');
  await register(workshopId, 'grace');
  await wait(150);
  const beforeKill = await request(`${api}/notifications?status=PENDING`, { headers: { 'x-api-key': key } });
  console.log(`Rows saved before SIGKILL: ${beforeKill.notifications.length}`);
  backend.kill('SIGKILL');
  await wait(400);
  backend = start('server.js', {
    PORT: '3100',
    API_KEY: key,
    DATABASE_PATH: databasePath,
    NOTIFIER_URL: mock,
    POLL_INTERVAL_MS: '50',
    NOTIFY_TIMEOUT_MS: '100',
    LEASE_DURATION_MS: '250'
  });
  await waitFor(`${api}/notifications`, () => true, { headers: { 'x-api-key': key } });
  await request(`${mock}/admin/up`, { method: 'POST' });
  const recovered = await waitFor(`${mock}/received`, (body) => body.count === 7);
  console.log(`Restart recovery delivered ${recovered.count}/7 confirmations`);

  console.log('\n7. CANCEL WORKSHOP; EVERY MEMBER IS NOTIFIED');
  await request(`${api}/workshops/${workshopId}/cancel`, { method: 'POST', headers: { 'x-api-key': key } });
  const finalReceived = await waitFor(`${mock}/received`, (body) => body.count === 14);
  const cancellationCount = finalReceived.messages.filter((message: { type: string }) => message.type === 'CANCELLATION').length;
  console.log(`Cancellation notifications delivered: ${cancellationCount}/7`);
  passed = finalReceived.count === 14 && cancellationCount === 7;
} catch (error) {
  passed = false;
  console.error(`Demo failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  for (const child of processes) {
    if (child.pid) child.kill('SIGTERM');
  }
}

console.log(`\nFINAL RESULT: ${passed ? 'PASS' : 'FAIL'}`);
if (!passed) process.exitCode = 1;
