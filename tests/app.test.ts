import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/api/app.js';
import { AppDatabase } from '../src/db/database.js';
import { createMockNotifierApp, type MockNotifierState } from '../src/mock-notifier/app.js';
import { OutboxWorker } from '../src/worker/outbox-worker.js';

describe('workshop registration and notifications', () => {
  let db: AppDatabase;
  let app: Awaited<ReturnType<typeof createApp>>;
  let mock: Awaited<ReturnType<typeof createMockNotifierApp>>;
  let state: MockNotifierState;

  beforeEach(async () => {
    db = new AppDatabase();
    app = createApp(db, 'test-key');
    state = { alwaysDown: false, received: [], duplicateCount: 0, errorRate: 0, timeoutRate: 0, delayMs: 0, failRecipients: new Set() };
    mock = createMockNotifierApp(state);
    await app.ready();
    await mock.listen({ port: 0 });
  });

  afterEach(async () => {
    await app.close();
    await mock.close();
    db.close();
  });

  async function createWorkshop(capacity: number | null = null): Promise<string> {
    const response = await app.inject({
      method: 'POST', url: '/workshops', headers: { 'x-api-key': 'test-key' },
      payload: { title: 'TypeScript', description: 'Workshop', capacity, startsAt: '2030-01-01T10:00:00.000Z' }
    });
    return response.json().id as string;
  }

  function worker(): OutboxWorker {
    return new OutboxWorker(db, {
      notifierUrl: `http://127.0.0.1:${(mock.server.address() as { port: number }).port}`,
      concurrency: 2, timeoutMs: 50, maxAttempts: 3, pollIntervalMs: 10, backoffBaseMs: 1, backoffMaxMs: 10, leaseMs: 100,
      random: () => 0
    });
  }

  it('rejects duplicate registration and creates confirmation atomically', async () => {
    const id = await createWorkshop();
    const first = await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm1', email: 'one@example.com' } });
    const duplicate = await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm1', email: 'one@example.com' } });
    expect(first.statusCode).toBe(201);
    expect(duplicate.statusCode).toBe(409);
    expect(db.listNotifications()).toHaveLength(1);
    expect(db.listNotifications()[0].status).toBe('PENDING');
  });

  it('does not create a notification for a failed registration', async () => {
    const id = await createWorkshop(1);
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm1', email: 'one@example.com' } });
    const response = await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm2', email: 'two@example.com' } });
    expect(response.statusCode).toBe(409);
    expect(db.listNotifications()).toHaveLength(1);
  });

  it('rolls back registration and outbox together when outbox insertion fails', async () => {
    const id = await createWorkshop();
    db.sqlite.exec(`
      CREATE TRIGGER fail_confirmation BEFORE INSERT ON outbox
      WHEN NEW.type = 'CONFIRMATION'
      BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END;
    `);
    expect(() => db.register(id, 'rollback', 'rollback@example.com')).toThrow('simulated outbox failure');
    expect(db.listRegistrations(id)).toHaveLength(0);
    expect(db.listNotifications()).toHaveLength(0);
  });

  it('retries after notifier failure without blocking another recipient', async () => {
    const id = await createWorkshop();
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'bad', email: 'bad@example.com' } });
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'good', email: 'good@example.com' } });
    state.failRecipients?.add('bad@example.com');
    const firstWorker = worker();
    await firstWorker.processOnce();
    expect(db.listNotifications('PENDING')).toHaveLength(1);
    expect(db.listNotifications('SENT')).toHaveLength(1);
    state.failRecipients?.clear();
    await new Promise((resolve) => setTimeout(resolve, 3));
    await firstWorker.processOnce();
    expect(db.listNotifications('SENT')).toHaveLength(2);
  });

  it('notifies every registered member on cancellation', async () => {
    const id = await createWorkshop();
    for (const member of ['a', 'b', 'c']) {
      await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: member, email: `${member}@example.com` } });
    }
    const response = await app.inject({ method: 'POST', url: `/workshops/${id}/cancel`, headers: { 'x-api-key': 'test-key' } });
    expect(response.statusCode).toBe(200);
    expect(db.listNotifications('PENDING')).toHaveLength(6);
    const second = await app.inject({ method: 'POST', url: `/workshops/${id}/cancel`, headers: { 'x-api-key': 'test-key' } });
    expect(second.statusCode).toBe(409);
    expect(db.listNotifications('PENDING')).toHaveLength(6);
  });

  it('recovers an expired lease with a new worker', async () => {
    const id = await createWorkshop();
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm1', email: 'one@example.com' } });
    const claimed = db.claimDue(1, 1);
    expect(claimed).toHaveLength(1);
    db.sqlite.prepare("UPDATE outbox SET lockedUntil = '2000-01-01T00:00:00.000Z'").run();
    const freshWorker = worker();
    await freshWorker.processOnce();
    expect(db.listNotifications('SENT')).toHaveLength(1);
    expect(state.received).toHaveLength(1);
  });

  it('deduplicates delivery by idempotency key', async () => {
    const id = await createWorkshop();
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'm1', email: 'one@example.com' } });
    const firstWorker = worker();
    await firstWorker.processOnce();
    db.sqlite.prepare("UPDATE outbox SET status = 'PENDING', nextAttemptAt = ?").run(new Date().toISOString());
    await firstWorker.processOnce();
    expect(state.received).toHaveLength(1);
    expect(state.duplicateCount).toBe(1);
  });

  it('marks repeated failures DEAD and requeues them', async () => {
    const id = await createWorkshop();
    await app.inject({ method: 'POST', url: `/workshops/${id}/register`, payload: { memberId: 'dead', email: 'dead@example.com' } });
    state.failRecipients?.add('dead@example.com');
    const deadWorker = worker();
    await deadWorker.processOnce();
    await new Promise((resolve) => setTimeout(resolve, 3));
    await deadWorker.processOnce();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await deadWorker.processOnce();
    expect(db.listNotifications('DEAD')).toHaveLength(1);
    expect(db.requeueDead()).toBe(1);
    expect(db.listNotifications('PENDING')).toHaveLength(1);
  });
});
