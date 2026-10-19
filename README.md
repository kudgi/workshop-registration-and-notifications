# Workshop Registration and Notifications

A Fastify/TypeScript workshop API using SQLite WAL mode and a transactional outbox for durable, retryable notifications.

## Architecture

```mermaid
flowchart LR
  Client --> API[Fastify API]
  API --> DB[(SQLite WAL)]
  DB --> Worker[Outbox worker]
  Worker -->|HTTP timeout + Idempotency-Key| Mock[Mock notification service]
  Mock --> Received[/received]
```

The API and worker run in one process. The mock notifier is a separate process.

## Install and run

Requires Node.js 20 or newer.

```sh
npm install
cp .env.example .env
npm run build
npm run mock                 # terminal 1
npm start                    # terminal 2
```

For development, use `npm run dev` instead of `npm start`. The database directory is created automatically.

### Windows PowerShell note

Use `npm.cmd` if PowerShell blocks `npm.ps1`, and use `Copy-Item .env.example .env` instead of `cp`. For example:

```powershell
Copy-Item .env.example .env
npm.cmd run build
npm.cmd run mock
npm.cmd start
```

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `API_KEY` | `change-me` | Organizer endpoint key |
| `PORT` | `3000` | Backend API port |
| `DATABASE_PATH` | `./data/workshops.db` | SQLite database file |
| `MAX_ATTEMPTS` | `5` | Attempts before `DEAD` |
| `BACKOFF_BASE_MS` | `250` | Initial retry backoff |
| `BACKOFF_MAX_MS` | `30000` | Maximum retry delay |
| `LEASE_DURATION_MS` | `1500` | Outbox claim lease |
| `POLL_INTERVAL_MS` | `250` | Worker polling interval |
| `WORKER_CONCURRENCY` | `4` | Maximum concurrent deliveries |
| `NOTIFIER_URL` | `http://localhost:4000` | Mock notifier base URL |
| `NOTIFY_TIMEOUT_MS` | `1000` | HTTP delivery timeout |
| `ERROR_RATE` | `0` | Mock HTTP error probability, from 0 to 1 |
| `TIMEOUT_RATE` | `0` | Mock timeout probability, from 0 to 1 |
| `DELAY_MS` | `0` | Mock response delay |

## API reference

Organizer endpoints require `x-api-key` matching `API_KEY`.

```sh
curl -X POST http://localhost:3000/workshops \
  -H 'x-api-key: change-me' \
  -H 'content-type: application/json' \
  -d '{"title":"TypeScript","description":"Backend workshop","capacity":25,"startsAt":"2030-01-01T10:00:00.000Z"}'

curl -X POST http://localhost:3000/workshops/WORKSHOP_ID/register \
  -H 'content-type: application/json' \
  -d '{"memberId":"member-1","email":"member@example.com"}'

curl http://localhost:3000/workshops/WORKSHOP_ID/registrations \
  -H 'x-api-key: change-me'

curl -X POST http://localhost:3000/workshops/WORKSHOP_ID/cancel \
  -H 'x-api-key: change-me'

curl 'http://localhost:3000/notifications?status=DEAD' \
  -H 'x-api-key: change-me'

curl -X POST http://localhost:3000/notifications/requeue \
  -H 'x-api-key: change-me'
```

### Status codes

| Status | Meaning |
|---:|---|
| `201` | Workshop or registration created |
| `409` | Duplicate registration, full workshop, or cancelled workshop |
| `401` | Missing or invalid organizer API key |
| `400` | Invalid JSON, validation input, UUID, email, or query filter |
| `404` | Workshop not found |

`GET /notifications?status=PENDING|IN_PROGRESS|SENT|DEAD` filters durable outbox rows. `POST /notifications/requeue` resets all dead rows for delivery.

The mock service exposes `POST /notify`, `POST /admin/down`, `POST /admin/up`, and `GET /received`. `GET /received` returns delivered messages and duplicate attempts:

```json
{
  "count": 2,
  "duplicates": 1,
  "messages": [{ "idempotencyKey": "confirm:1", "type": "CONFIRMATION" }]
}
```

## Tests and demo

```sh
npm test
npm run build
npm run demo
```

Run `npm run build` before `npm run demo`; the demo starts the compiled backend and mock processes. It prints numbered steps for initial confirmations, outage retries, SIGKILL restart recovery, and cancellation, followed by `FINAL RESULT: PASS`.

Example:

```text
1. START SERVICES
3. REGISTER MEMBERS; CONFIRMATIONS ARRIVE
5. NOTIFIER UP; RETRIES RECOVER
6. RESTART RECOVERY: CREATE PENDING ROWS, SIGKILL BACKEND, RESTART
7. CANCEL WORKSHOP; EVERY MEMBER IS NOTIFIED
FINAL RESULT: PASS
```

### What the tests prove

- Duplicate registration returns `409` and creates one confirmation row.
- Full/failed registration creates no additional confirmation.
- Registration and its outbox row roll back together on an outbox failure.
- Failed delivery retries and eventually succeeds.
- One failing recipient does not block another.
- Cancellation notifies every member; a second cancellation creates no rows.
- A fresh worker delivers an expired `IN_PROGRESS` lease.
- Repeated failure reaches `DEAD`; requeue returns it to `PENDING`.
- Duplicate delivery uses one delivered message and counts one duplicate attempt.

## Reliability design

- **Lost notifications:** registration and its confirmation outbox row are inserted in one SQLite transaction. Cancellation and all cancellation rows are likewise one transaction.
- **Retries and backoff:** the worker claims due rows with a lease, uses an `AbortController` timeout, records errors, and applies capped exponential backoff with jitter. Rows reaching `MAX_ATTEMPTS` become `DEAD`; organizers can requeue them.
- **Duplicate delivery:** delivery is deliberately at-least-once. Every request includes a stable `Idempotency-Key`. The mock deduplicates that key and reports duplicate attempts.
- **Backend restarts:** `IN_PROGRESS` rows retain a lease. On restart, expired leases are eligible again, so a crash after saving but before sending cannot lose a notification.
- **Isolation:** rows are delivered independently with bounded concurrency; one recipient timeout does not block other recipients.

SQLite polling is simple for this service, while Postgres with `SKIP LOCKED` would scale better. At-least-once delivery plus idempotency is practical; exactly-once delivery is not generally achievable across process/network boundaries. Production improvements would include Postgres, a message broker, metrics/alerts, distributed tracing, and stronger organizer authentication.
