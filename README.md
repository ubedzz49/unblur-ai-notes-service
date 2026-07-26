# ai-notes-service

Generates and delivers AI notes and transcripts for users who've enabled
`ai_notes_and_transcripts_enabled`, after a booking (1-on-1), seminar, or GD session ends. Owns
the `ai_notes_deliveries` table -- one row per user per session.

## Flow

1. Resolution/Seminar/GD Service calls `POST /internal/ai-notes/trigger` after a session ends,
   with `referenceType`, `referenceId`, and the session's `participantUserIds`.
2. This service calls User Service (per participant, see "User Service lookup gap" below) to
   filter down to users with the setting enabled.
3. For each enabled user, idempotently creates (or finds) a `pending` delivery row and enqueues a
   Bull job with its id.
4. The in-process worker (see below) fetches the session's transcript, calls the LLM to produce
   cleaned transcript text and structured notes, stores both (`generated`), then emails the user
   and sends an in-app notification before marking the row `sent`.
5. Any failure at any step marks the row `failed` with a structured warning log -- the worker
   never throws or crashes the process.

## In-process worker

The Bull worker runs inside the same Fastify process as the HTTP server (`src/index.ts` calls
`startWorker()` right after `buildApp()`), not as a separate deployable. Session volume here is
one job per enabled participant per session -- modest enough that a second ECS
service/task-definition for a standalone worker isn't worth the extra deploy surface yet. Revisit
if job volume or LLM latency ever risks blocking the HTTP event loop.

## Known gaps (follow-up tasks, not done here)

- **`providerRoomId` resolution.** Resolution/Seminar/GD services don't yet expose an endpoint
  that maps a `referenceId` (booking/seminar/gd id) to its Daily room name. `POST
  /internal/ai-notes/trigger` accepts an optional `providerRoomId` passed straight through by the
  caller; if it's missing, the worker (`src/worker.ts`, `processDeliveryJob`) marks the delivery
  `failed` with a clear log line instead of crashing. Wiring the real lookup is a separate task in
  those services' repos.
- **User Service per-user lookup.** User Service has no bulk "these ids, filtered to
  `ai_notes_and_transcripts_enabled`" endpoint, and no internal per-user GET at all today (see
  `src/users/client.ts` for what was actually checked in `user-service/src/app.ts`). This service
  calls a documented-but-not-yet-implemented `GET /internal/users/:id` once per participant,
  sequentially. Adding that endpoint to user-service is a separate follow-up task.
- **Daily transcription enablement.** Meeting Service creates rooms with `enable_recording:
  "cloud"` (`meeting-service/src/provider/daily-provider.ts`, in `createRoom`'s `properties`
  object) but not `enable_transcription_storage: true`. Without that, Daily's transcript endpoints
  this service calls (`src/transcripts/provider.ts`) will simply have nothing to return. Adding
  that flag is a separate PR in meeting-service's repo, out of scope here.

## APIs

Internal (internal-service-token gated):
- `POST /internal/ai-notes/trigger` -- body `{ referenceType, referenceId, participantUserIds[],
  providerRoomId? }`. Returns `202 { deliveryIds[] }`.

Client-facing (trusts gateway-verified `X-User-Id`):
- `GET /ai-notes/my` -- caller's own deliveries.
- `GET /ai-notes/:id` -- a single delivery; 403 if the caller isn't the delivery's owner, 404 if
  it doesn't exist. This is the privacy-critical path from section 7 of the design doc -- see the
  comment on the ownership check in `src/app.ts`.

Admin (`X-User-Role: admin`):
- `GET /admin/ai-notes?status=failed` -- list deliveries, optionally filtered by status.
- `POST /admin/ai-notes/:id/retry` -- re-enqueues a `failed` delivery; 409 on anything else.

## Environment variables

See `.env.example`. Notable ones:
- `OPENROUTER_API_KEY`, `AI_NOTES_LLM_MODEL` (default `anthropic/claude-3.5-haiku` -- fast/cheap,
  fine for a summarize-and-structure task, a real OpenRouter model slug as of writing).
- `DAILY_API_KEY` -- for the transcript provider.
- `SENDGRID_API_KEY`, `SENDGRID_FROM_EMAIL` -- for the "your AI notes are ready" email.
- `REDIS_HOST`/`REDIS_PORT`/`REDIS_AUTH_TOKEN`/`REDIS_TLS` -- same ElastiCache cluster
  doubt-service uses, new queue name (`ai-notes-delivery`).
- `USER_SERVICE_URL`, `NOTIFICATION_SERVICE_URL` -- other services this one calls.
- `WEB_APP_BASE_URL` -- used to build the `/ai-notes/:id` link in the notification email.
- `INTERNAL_SERVICE_TOKEN` -- shared secret for `/internal/*` routes; service refuses to start if
  unset.

## Migration lock id

`src/db/migrate.ts` uses advisory lock id `7264997`. Every other service's migrate.ts on this RDS
instance was grepped for `MIGRATION_LOCK_ID` before picking it: 7264991
(user-service)/7264992 (matching)/7264993 (doubt)/7264994 (resolution)/7264995
(payment)/7264996 (recording-service and notification-service -- an existing collision between
those two, not this service's to fix). 7264997 was the next integer not already claimed.

## Local development

```bash
cp .env.example .env.local
npm install
npm run dev
```

## Scripts

- `npm run dev` -- local dev server
- `npm run build` -- production build
- `npm run migrate` -- run pending migrations
- `npm test` -- unit tests (Vitest)
