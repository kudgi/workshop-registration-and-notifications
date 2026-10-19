import Fastify, { type FastifyInstance } from 'fastify';

export interface ReceivedMessage {
  idempotencyKey: string | undefined;
  recipient: string;
  type: string;
  payload: unknown;
}

export interface MockNotifierState {
  alwaysDown: boolean;
  received: ReceivedMessage[];
  duplicateCount: number;
  errorRate: number;
  timeoutRate: number;
  delayMs: number;
  failRecipients?: Set<string>;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createMockNotifierApp(state: MockNotifierState): FastifyInstance {
  const app = Fastify({ logger: true });
  app.post('/notify', async (request, reply) => {
    if (state.alwaysDown || Math.random() < state.timeoutRate) {
      await pause(Math.max(state.delayMs, 60_000));
      return reply.code(503).send({ error: 'service unavailable' });
    }
    if (state.delayMs) await pause(state.delayMs);
    const body = request.body as { recipient: string; type: string; payload: unknown };
    if (state.failRecipients?.has(body.recipient) || Math.random() < state.errorRate) return reply.code(500).send({ error: 'random failure' });
    const idempotencyKey = request.headers['idempotency-key'];
    if (state.received.some((message) => message.idempotencyKey === idempotencyKey)) state.duplicateCount += 1;
    else state.received.push({ idempotencyKey, recipient: body.recipient, type: body.type, payload: body.payload });
    return reply.code(202).send({ accepted: true });
  });
  app.post('/admin/down', async () => { state.alwaysDown = true; return { alwaysDown: true }; });
  app.post('/admin/up', async () => { state.alwaysDown = false; return { alwaysDown: false }; });
  app.get('/received', async () => ({ count: state.received.length, duplicates: state.duplicateCount, messages: state.received }));
  return app;
}
