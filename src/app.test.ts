import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { InMemoryDeliveriesRepository } from "./deliveries/repository.js";
import { FakeUserClient } from "./users/client.js";
import { FakeAuditLogClient } from "./admin/audit-log-client.js";

const INTERNAL_TOKEN = "test-internal-token";
const ENABLED_USER = "11111111-1111-1111-1111-111111111111";
const DISABLED_USER = "22222222-2222-2222-2222-222222222222";
const OTHER_USER = "33333333-3333-3333-3333-333333333333";
const ADMIN_USER = "admin";
const REF_ID = "44444444-4444-4444-4444-444444444444";

function setup() {
  const repo = new InMemoryDeliveriesRepository();
  const userClient = new FakeUserClient();
  userClient.seed({ id: ENABLED_USER, email: "enabled@example.com", name: "Enabled User", aiNotesAndTranscriptsEnabled: true });
  userClient.seed({ id: DISABLED_USER, email: "disabled@example.com", name: "Disabled User", aiNotesAndTranscriptsEnabled: false });
  const auditLogClient = new FakeAuditLogClient();
  // no fake queue passed by default -- tests that don't care about enqueueing just omit it
  const app = buildApp(repo, userClient, INTERNAL_TOKEN, undefined, auditLogClient);
  return { app, repo, userClient, auditLogClient };
}

describe("GET /healthz", () => {
  it("returns ok status with no auth required", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});

describe("auth", () => {
  it("401s a user-facing route with no X-User-Id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/ai-notes/my" });
    expect(res.statusCode).toBe(401);
  });

  it("401s an internal route with no service token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "POST", url: "/internal/ai-notes/trigger", payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it("401s an internal route with a wrong service token", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": "wrong" },
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });
});

function triggerPayload(overrides: Record<string, unknown> = {}) {
  return {
    referenceType: "booking",
    referenceId: REF_ID,
    participantUserIds: [ENABLED_USER, DISABLED_USER],
    ...overrides,
  };
}

describe("POST /internal/ai-notes/trigger", () => {
  it("rejects an invalid referenceType", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload({ referenceType: "not-a-real-type" }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a missing referenceId", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload({ referenceId: undefined }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an empty participantUserIds array", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload({ participantUserIds: [] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects participantUserIds containing a non-string entry", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload({ participantUserIds: [ENABLED_USER, 12345] }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("accepts an empty body with Content-Type: application/json set (real client behavior)", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN, "content-type": "application/json" },
      payload: "",
    });
    expect(res.statusCode).toBe(400);
  });

  it("creates a delivery only for the participant with ai_notes_and_transcripts_enabled = true", async () => {
    const { app, repo } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload(),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().deliveryIds).toHaveLength(1);

    const enabledUserDeliveries = await repo.listByUser(ENABLED_USER);
    const disabledUserDeliveries = await repo.listByUser(DISABLED_USER);
    expect(enabledUserDeliveries).toHaveLength(1);
    expect(disabledUserDeliveries).toHaveLength(0);
  });

  it("is idempotent -- triggering twice for the same session doesn't create duplicate rows", async () => {
    const { app, repo } = setup();
    await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload(),
    });
    await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload(),
    });
    const deliveries = await repo.listByUser(ENABLED_USER);
    expect(deliveries).toHaveLength(1);
  });

  it("creates zero deliveries when no participant has the setting enabled", async () => {
    const { app, repo } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/ai-notes/trigger",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: triggerPayload({ participantUserIds: [DISABLED_USER] }),
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().deliveryIds).toHaveLength(0);
    expect(await repo.listByUser(DISABLED_USER)).toHaveLength(0);
  });
});

describe("GET /ai-notes/my", () => {
  it("lists only the caller's own deliveries", async () => {
    const { app, repo } = setup();
    await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    await repo.findOrCreate({ userId: OTHER_USER, referenceType: "booking", referenceId: REF_ID });

    const res = await app.inject({ method: "GET", url: "/ai-notes/my", headers: { "x-user-id": ENABLED_USER } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });
});

describe("GET /ai-notes/:id -- ownership check", () => {
  it("404s for an unknown delivery id", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/ai-notes/does-not-exist", headers: { "x-user-id": ENABLED_USER } });
    expect(res.statusCode).toBe(404);
  });

  it("200s and returns the delivery for its owning user", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    const res = await app.inject({
      method: "GET",
      url: `/ai-notes/${delivery.id}`,
      headers: { "x-user-id": ENABLED_USER },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(delivery.id);
  });

  it("403s a different user trying to read someone else's delivery (privacy boundary)", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    const res = await app.inject({
      method: "GET",
      url: `/ai-notes/${delivery.id}`,
      headers: { "x-user-id": OTHER_USER },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /admin/ai-notes", () => {
  it("403s a non-admin caller", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/admin/ai-notes", headers: { "x-user-id": ENABLED_USER } });
    expect(res.statusCode).toBe(403);
  });

  it("lists all deliveries for an admin caller with no status filter", async () => {
    const { app, repo } = setup();
    await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    const res = await app.inject({
      method: "GET",
      url: "/admin/ai-notes",
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("filters by status=failed", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    await repo.markFailed(delivery.id);
    await repo.findOrCreate({ userId: OTHER_USER, referenceType: "booking", referenceId: "55555555-5555-5555-5555-555555555555" });

    const res = await app.inject({
      method: "GET",
      url: "/admin/ai-notes?status=failed",
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
  });

  it("400s an invalid status", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "GET",
      url: "/admin/ai-notes?status=bogus",
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /admin/ai-notes/:id/retry", () => {
  it("403s a non-admin caller", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    await repo.markFailed(delivery.id);
    const res = await app.inject({
      method: "POST",
      url: `/admin/ai-notes/${delivery.id}/retry`,
      headers: { "x-user-id": ENABLED_USER },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404s an unknown delivery", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/admin/ai-notes/does-not-exist/retry",
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("409s retrying a delivery that isn't failed", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    const res = await app.inject({
      method: "POST",
      url: `/admin/ai-notes/${delivery.id}/retry`,
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin" },
    });
    expect(res.statusCode).toBe(409);
  });

  it("202s, re-enqueues a failed delivery, and records an audit entry", async () => {
    const { app, repo, auditLogClient } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    await repo.markFailed(delivery.id);
    const res = await app.inject({
      method: "POST",
      url: `/admin/ai-notes/${delivery.id}/retry`,
      headers: { "x-user-id": ADMIN_USER, "x-user-role": "admin", "x-user-username": "boss" },
    });
    expect(res.statusCode).toBe(202);
    expect(auditLogClient.calls).toHaveLength(1);
    expect(auditLogClient.calls[0]).toMatchObject({ action: "retry_ai_notes_delivery", adminUsername: "boss", targetId: delivery.id });
  });

  it("allows a superadmin caller, not just admin", async () => {
    const { app, repo } = setup();
    const delivery = await repo.findOrCreate({ userId: ENABLED_USER, referenceType: "booking", referenceId: REF_ID });
    await repo.markFailed(delivery.id);
    const res = await app.inject({
      method: "POST",
      url: `/admin/ai-notes/${delivery.id}/retry`,
      headers: { "x-user-id": "super-1", "x-user-role": "superadmin" },
    });
    expect(res.statusCode).toBe(202);
  });
});

describe("log level management", () => {
  it("rejects without a valid internal token", async () => {
    const { app } = setup();
    const res = await app.inject({ method: "GET", url: "/internal/log-level" });
    expect(res.statusCode).toBe(401);
  });

  it("reads and changes the runtime log level, then resets it", async () => {
    const { app } = setup();
    const get = await app.inject({ method: "GET", url: "/internal/log-level", headers: { "x-internal-service-token": INTERNAL_TOKEN } });
    expect(get.json().level).toBe("info");

    const set = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "debug" },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().level).toBe("debug");

    await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "info" },
    });
  });

  it("rejects an unrecognized level", async () => {
    const { app } = setup();
    const res = await app.inject({
      method: "POST",
      url: "/internal/log-level",
      headers: { "x-internal-service-token": INTERNAL_TOKEN },
      payload: { level: "verbose" },
    });
    expect(res.statusCode).toBe(400);
  });
});
