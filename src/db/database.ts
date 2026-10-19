import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Notification, NotificationStatus, Registration, Workshop } from '../types.js';

type WorkshopRow = Omit<Workshop, 'cancelled'> & { cancelled: number };

export class AppDatabase {
  readonly sqlite: Database.Database;

  constructor(path = ':memory:') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.sqlite = new Database(path);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('foreign_keys = ON');
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS workshops (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        capacity INTEGER,
        startsAt TEXT NOT NULL,
        cancelled INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workshopId TEXT NOT NULL REFERENCES workshops(id),
        memberId TEXT NOT NULL,
        email TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        UNIQUE(workshopId, memberId)
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotencyKey TEXT NOT NULL UNIQUE,
        type TEXT NOT NULL CHECK(type IN ('CONFIRMATION', 'CANCELLATION')),
        recipient TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        attempts INTEGER NOT NULL DEFAULT 0,
        nextAttemptAt TEXT NOT NULL,
        lockedUntil TEXT,
        lastError TEXT,
        createdAt TEXT NOT NULL,
        sentAt TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(status, nextAttemptAt);
    `);
  }

  close(): void {
    if (this.sqlite.open) this.sqlite.close();
  }

  createWorkshop(input: Omit<Workshop, 'id' | 'cancelled' | 'createdAt'>): Workshop {
    const workshop: Workshop = { ...input, id: randomUUID(), cancelled: false, createdAt: new Date().toISOString() };
    this.sqlite.prepare(`
      INSERT INTO workshops (id, title, description, capacity, startsAt, cancelled, createdAt)
      VALUES (@id, @title, @description, @capacity, @startsAt, 0, @createdAt)
    `).run(workshop);
    return workshop;
  }

  getWorkshop(id: string): Workshop | undefined {
    const row = this.sqlite.prepare('SELECT * FROM workshops WHERE id = ?').get(id) as WorkshopRow | undefined;
    return row ? { ...row, cancelled: Boolean(row.cancelled) } : undefined;
  }

  listRegistrations(workshopId: string): Registration[] {
    return this.sqlite.prepare('SELECT * FROM registrations WHERE workshopId = ? ORDER BY id').all(workshopId) as Registration[];
  }

  register(workshopId: string, memberId: string, email: string): Registration {
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction(() => {
      const workshop = this.sqlite.prepare('SELECT * FROM workshops WHERE id = ?').get(workshopId) as WorkshopRow | undefined;
      if (!workshop) throw new Error('WORKSHOP_NOT_FOUND');
      if (workshop.cancelled) throw new Error('WORKSHOP_CANCELLED');
      const count = this.sqlite.prepare('SELECT COUNT(*) AS count FROM registrations WHERE workshopId = ?').get(workshopId) as { count: number };
      if (workshop.capacity !== null && count.count >= workshop.capacity) throw new Error('WORKSHOP_FULL');
      const result = this.sqlite.prepare(`
        INSERT INTO registrations (workshopId, memberId, email, createdAt) VALUES (?, ?, ?, ?)
      `).run(workshopId, memberId, email, now);
      const registration: Registration = { id: Number(result.lastInsertRowid), workshopId, memberId, email, createdAt: now };
      this.insertOutbox({
        idempotencyKey: `confirm:${registration.id}`,
        type: 'CONFIRMATION',
        recipient: email,
        payload: { subject: `Registration confirmed: ${workshop.title}`, message: `You are registered for ${workshop.title}.`, workshopId, memberId },
        now
      });
      return registration;
    });
    return transaction();
  }

  cancelWorkshop(workshopId: string): number {
    const now = new Date().toISOString();
    const transaction = this.sqlite.transaction(() => {
      const workshop = this.sqlite.prepare('SELECT * FROM workshops WHERE id = ?').get(workshopId) as WorkshopRow | undefined;
      if (!workshop) throw new Error('WORKSHOP_NOT_FOUND');
      if (workshop.cancelled) throw new Error('WORKSHOP_ALREADY_CANCELLED');
      this.sqlite.prepare('UPDATE workshops SET cancelled = 1 WHERE id = ?').run(workshopId);
      const registrations = this.listRegistrations(workshopId);
      for (const registration of registrations) {
        this.insertOutbox({
          idempotencyKey: `cancel:${workshopId}:${registration.memberId}`,
          type: 'CANCELLATION',
          recipient: registration.email,
          payload: { subject: `Workshop cancelled: ${workshop.title}`, message: `The workshop ${workshop.title} has been cancelled.`, workshopId, memberId: registration.memberId },
          now
        });
      }
      return registrations.length;
    });
    return transaction();
  }

  private insertOutbox(input: {
    idempotencyKey: string; type: Notification['type']; recipient: string; payload: Notification['payload']; now: string;
  }): void {
    this.sqlite.prepare(`
      INSERT INTO outbox (idempotencyKey, type, recipient, payload, nextAttemptAt, createdAt)
      VALUES (@idempotencyKey, @type, @recipient, @payload, @now, @now)
    `).run({ ...input, payload: JSON.stringify(input.payload) });
  }

  listNotifications(status?: NotificationStatus): Notification[] {
    const rows = (status
      ? this.sqlite.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY id').all(status)
      : this.sqlite.prepare('SELECT * FROM outbox ORDER BY id').all()) as Array<Omit<Notification, 'payload'> & { payload: string }>;
    return rows.map((row) => ({ ...row, payload: JSON.parse(row.payload) }));
  }

  requeueDead(): number {
    return this.sqlite.prepare(`
      UPDATE outbox SET status = 'PENDING', attempts = 0, nextAttemptAt = ?, lockedUntil = NULL, lastError = NULL
      WHERE status = 'DEAD'
    `).run(new Date().toISOString()).changes;
  }

  claimDue(limit: number, leaseMs: number): Notification[] {
    const now = new Date();
    const nowIso = now.toISOString();
    const leaseIso = new Date(now.getTime() + leaseMs).toISOString();
    const transaction = this.sqlite.transaction(() => {
      const rows = this.sqlite.prepare(`
        SELECT * FROM outbox
        WHERE (status = 'PENDING' AND nextAttemptAt <= ?)
           OR (status = 'IN_PROGRESS' AND lockedUntil <= ?)
        ORDER BY id LIMIT ?
      `).all(nowIso, nowIso, limit) as Array<Omit<Notification, 'payload'> & { payload: string }>;
      for (const row of rows) {
        this.sqlite.prepare(`
          UPDATE outbox SET status = 'IN_PROGRESS', lockedUntil = ? WHERE id = ?
        `).run(leaseIso, row.id);
      }
      return rows.map((row) => ({ ...row, status: 'IN_PROGRESS' as const, lockedUntil: leaseIso, payload: JSON.parse(row.payload) }));
    });
    return transaction();
  }

  markSent(id: number): void {
    this.sqlite.prepare(`
      UPDATE outbox SET status = 'SENT', sentAt = ?, lockedUntil = NULL WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markFailure(id: number, error: string, nextAttemptAt: string, dead: boolean): void {
    this.sqlite.prepare(`
      UPDATE outbox SET status = ?, attempts = attempts + 1, nextAttemptAt = ?, lockedUntil = NULL, lastError = ?
      WHERE id = ?
    `).run(dead ? 'DEAD' : 'PENDING', nextAttemptAt, error, id);
  }
}
