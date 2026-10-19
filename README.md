# Workshop Registration and Notifications

A Fastify/TypeScript workshop API using SQLite WAL mode and a transactional outbox for durable, retryable notifications.

## Architecture

```text
Client --> Fastify API --> SQLite (workshops, registrations, outbox)
                              ^
                              | atomic transaction
                              |
                       Outbox worker --HTTP + timeout--> Mock notifier
                              |                              |
                         leases/retries              dedupe by Idempotency-Key
```

The API and worker run in one process. The mock notifier is a separate process.

## Install and run

Requires Node.js 20 or newer.

```sh
npm install
copy .env.example .env       # Windows
npm run mock                 # terminal 1
npm run dev                  # terminal 2
```

Use `npm run start` for a non-watch backend. `DATABASE_PATH` defaults to `./data/workshops.db`; the directory is created automatically.

## API reference

Organizer endpoints require `x-api-key` matching `API_KEY`.

```sh
curl -X POST http://localhost:3000/workshops -H "x-api-key: change-me" -H "content-type: application/json" ^
  -d "{\"title\":\"TypeScript\",\"description\":\"Backend workshop\",\"capacity\":25,\"startsAt\":\"2030-01-01T10:00:00.000Z\"}"

curl -X POST http://localhost:3000/workshops/WORKSHOP_ID/register -H "content-type: application/json" ^
  -d "{\"memberId\":\"member-1\",\"email\":\"member@example.com\"}"

curl http://localhost:3000/workshops/WORKSHOP_ID/registrations -H "x-api-key: change-me"
curl -X POST http://localhost:3000/workshops/WORKSHOP_ID/cancel -H "x-api-key: change-me"
curl "http://localhost:3000/notifications?status=DEAD" -H "x-api-key: change-me"
curl -X POST http://localhost:3000/notifications/requeue -H "x-api-key: change-me"
```

The mock service exposes `POST /notify`, `POST /admin/down`, `POST /admin/up`, and `GET /received`. Its `ERROR_RATE`, `TIMEOUT_RATE`, and `DELAY_MS` environment variables make failures reproducible in a demo.

## Tests and demo

```sh
npm test
npm run build
npm run demo
```

Start both services before `npm run demo`. The script creates a workshop, registers members, takes the notifier down, demonstrates retries, restores it, and cancels the workshop. To demonstrate restart recovery, stop the backend while rows are pending and start it again; expired leases are reclaimed automatically.

## Reliability design

- **Lost notifications:** registration and its confirmation outbox row are inserted in one SQLite transaction. Cancellation and all cancellation rows are likewise one transaction. A successful HTTP response is not required before the API responds.
- **Retries and backoff:** the worker claims due rows with a lease, uses an `AbortController` timeout, and records errors. Failures use exponential backoff plus jitter. Rows reaching `MAX_ATTEMPTS` become `DEAD`; organizers can requeue them.
- **Duplicate delivery:** delivery is deliberately at-least-once. Every request includes the stable `Idempotency-Key`. The mock notifier deduplicates that key and reports duplicate attempts, avoiding an exactly-once claim at the transport layer.
- **Backend restarts:** `IN_PROGRESS` rows retain a lease. On restart, expired leases are eligible again, so a crash after saving but before sending cannot lose a notification.
- **Isolation:** rows are delivered independently with bounded concurrency; one recipient's timeout or error does not block other recipients.

SQLite polling is simple and suitable for this small service, but a real queue and Postgres provide stronger horizontal scaling. At-least-once delivery plus idempotency is practical and observable; exactly-once delivery is not generally achievable across process/network boundaries. In production I would use Postgres with `SKIP LOCKED`, a message broker, metrics/alerts, distributed tracing, authenticated service-to-service calls, and stronger organizer authentication.
