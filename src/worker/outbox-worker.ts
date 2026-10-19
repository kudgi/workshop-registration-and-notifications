import type { Notification } from '../types.js';
import { AppDatabase } from '../db/database.js';

export interface WorkerOptions {
  notifierUrl: string;
  concurrency: number;
  timeoutMs: number;
  maxAttempts: number;
  pollIntervalMs: number;
  backoffBaseMs: number;
  logger?: Pick<Console, 'error' | 'info'>;
  random?: () => number;
}

export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private cycleInProgress = false;

  constructor(private readonly db: AppDatabase, private readonly options: WorkerOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    while (this.cycleInProgress) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  async processOnce(): Promise<void> {
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (!this.running && this.cycleInProgress) return;
    if (this.cycleInProgress) return;
    this.cycleInProgress = true;
    try {
      const rows = this.db.claimDue(this.options.concurrency, this.options.timeoutMs + 500);
      await Promise.all(rows.map((row) => this.deliver(row)));
    } finally {
      this.cycleInProgress = false;
    }
  }

  private async deliver(row: Notification): Promise<void> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      try {
        const response = await fetch(`${this.options.notifierUrl}/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Idempotency-Key': row.idempotencyKey },
          body: JSON.stringify({ type: row.type, recipient: row.recipient, payload: row.payload }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`Notifier returned HTTP ${response.status}`);
      } finally {
        clearTimeout(timeout);
      }
      this.db.markSent(row.id);
    } catch (error) {
      const attempts = row.attempts + 1;
      const dead = attempts >= this.options.maxAttempts;
      const jitter = Math.floor((this.options.random ?? Math.random)() * this.options.backoffBaseMs);
      const delay = this.options.backoffBaseMs * 2 ** Math.max(0, attempts - 1) + jitter;
      this.db.markFailure(row.id, error instanceof Error ? error.message : String(error), new Date(Date.now() + delay).toISOString(), dead);
      this.options.logger?.error(`Notification ${row.id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
