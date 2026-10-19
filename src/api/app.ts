import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { z } from 'zod';

import { AppDatabase } from '../db/database.js';

const workshopSchema = z.object({
  title: z.string().min(1),
  description: z.string(),
  capacity: z.number().int().positive().nullable().optional(),
  startsAt: z.string().datetime()
});
const registrationSchema = z.object({ memberId: z.string().min(1), email: z.string().email() });

function requireApiKey(request: FastifyRequest, apiKey: string): void {
  if (request.headers['x-api-key'] !== apiKey) throw Object.assign(new Error('Invalid API key'), { statusCode: 401 });
}

export function createApp(db: AppDatabase, apiKey = 'change-me'): FastifyInstance {
  const app = Fastify({ logger: true });
  app.register(sensible);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request', details: error.issues });
    request.log.error(error);
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    return reply.code(statusCode).send({ error: error instanceof Error ? error.message : String(error) });
  });

  app.post('/workshops', async (request, reply) => {
    requireApiKey(request, apiKey);
    const body = workshopSchema.parse(request.body);
    return reply.code(201).send(db.createWorkshop({
      title: body.title,
      description: body.description,
      capacity: body.capacity ?? null,
      startsAt: body.startsAt
    }));
  });

  app.post('/workshops/:id/register', async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = registrationSchema.parse(request.body);
    try {
      return reply.code(201).send(db.register(params.id, body.memberId, body.email));
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSHOP_NOT_FOUND') return reply.notFound('Workshop not found');
      if (error instanceof Error && error.message === 'WORKSHOP_CANCELLED') return reply.conflict('Workshop is cancelled');
      if (error instanceof Error && error.message === 'WORKSHOP_FULL') return reply.conflict('Workshop is full');
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) return reply.conflict('Member is already registered');
      throw error;
    }
  });

  app.post('/workshops/:id/cancel', async (request, reply) => {
    requireApiKey(request, apiKey);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    try {
      const count = db.cancelWorkshop(params.id);
      return { cancelled: true, notificationsCreated: count };
    } catch (error) {
      if (error instanceof Error && error.message === 'WORKSHOP_NOT_FOUND') return reply.notFound('Workshop not found');
      if (error instanceof Error && error.message === 'WORKSHOP_ALREADY_CANCELLED') return reply.conflict('Workshop is already cancelled');
      throw error;
    }
  });

  app.get('/workshops/:id/registrations', async (request) => {
    requireApiKey(request, apiKey);
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    return { registrations: db.listRegistrations(params.id) };
  });

  app.get('/notifications', async (request) => {
    requireApiKey(request, apiKey);
    const query = z.object({ status: z.enum(['PENDING', 'IN_PROGRESS', 'SENT', 'DEAD']).optional() }).parse(request.query);
    return { notifications: db.listNotifications(query.status) };
  });

  app.post('/notifications/requeue', async (request) => {
    requireApiKey(request, apiKey);
    return { requeued: db.requeueDead() };
  });

  return app;
}
