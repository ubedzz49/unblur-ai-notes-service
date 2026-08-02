import Fastify, { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Queue from "bull";
import { DeliveriesRepository, DeliveryStatus, InMemoryDeliveriesRepository, ReferenceType } from "./deliveries/repository.js";
import { UserClient, FakeUserClient } from "./users/client.js";
import { DeliveryJobData } from "./queue/delivery-queue.js";
import { AuditLogClient, FakeAuditLogClient } from "./admin/audit-log-client.js";
import { logger } from "./logger.js";

const VALID_REFERENCE_TYPES: ReferenceType[] = ["booking", "seminar", "gd"];
const VALID_STATUSES: DeliveryStatus[] = ["pending", "generated", "sent", "failed"];

interface TriggerBody {
  referenceType?: string;
  referenceId?: string;
  participantUserIds?: string[];
  providerRoomId?: string;
}

interface ListAdminQuery {
  status?: string;
}

export function buildApp(
  deliveriesRepository: DeliveriesRepository = new InMemoryDeliveriesRepository(),
  userClient: UserClient = new FakeUserClient(),
  internalServiceToken: string | undefined = process.env.INTERNAL_SERVICE_TOKEN,
  deliveryQueue?: Queue.Queue<DeliveryJobData>,
  auditLogClient: AuditLogClient = new FakeAuditLogClient(),
): FastifyInstance {
  const app = Fastify(
    process.env.NODE_ENV === "test"
      ? { logger: false }
      : { loggerInstance: logger as unknown as FastifyBaseLogger },
  );

  // Fastify's default JSON parser rejects an empty body when Content-Type: application/json is
  // set, even for no-body calls -- real clients send that header unconditionally, so this bites
  // any no-body call otherwise (see ARCHITECTURE_DECISIONS.md)
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    if (body === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // internal routes are only ever called by other services (Resolution/Seminar/GD after a
  // session ends), never the frontend directly
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith("/internal/")) return;
    const token = request.headers["x-internal-service-token"];
    if (!token || token !== internalServiceToken) {
      request.log.warn("rejected internal request with missing/invalid service token");
      return reply.code(401).send({ error: "invalid internal service token" });
    }
  });

  const VALID_LOG_LEVELS = ["info", "debug", "error"];

  // runtime-mutable logging verbosity, no redeploy needed -- see src/logger.ts for the custom
  // info<debug<error severity ordering this project uses (not pino's default trace<debug<info<
  // warn<error<fatal). Gated the same as every other /internal/ route.
  app.get("/internal/log-level", async (_request, reply) => {
    return reply.send({ level: logger.level });
  });

  app.post<{ Body: { level?: string } }>("/internal/log-level", async (request, reply) => {
    const { level } = request.body ?? {};
    if (typeof level !== "string" || !VALID_LOG_LEVELS.includes(level)) {
      return reply.code(400).send({ error: `level must be one of ${VALID_LOG_LEVELS.join(", ")}` });
    }
    logger.level = level;
    request.log.info({ level }, "log level changed at runtime");
    return reply.send({ level: logger.level });
  });

  // user-facing routes trust the gateway-verified X-User-Id header, same pattern every other
  // service in this project uses -- this service never verifies JWTs itself
  app.addHook("preHandler", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.startsWith("/internal/") || request.url === "/healthz") return;
    const userId = request.headers["x-user-id"];
    if (!userId || Array.isArray(userId)) {
      return reply.code(401).send({ error: "missing X-User-Id header" });
    }
  });

  function requireAdminRole(request: FastifyRequest, reply: FastifyReply): boolean {
    const role = request.headers["x-user-role"];
    if (role !== "admin" && role !== "superadmin") {
      reply.code(403).send({ error: "admin access required" });
      return false;
    }
    return true;
  }

  function requireUserId(request: FastifyRequest): string {
    // preHandler above already rejected anything missing/malformed -- this just narrows the type
    return request.headers["x-user-id"] as string;
  }

  app.post<{ Body: TriggerBody }>("/internal/ai-notes/trigger", async (request, reply) => {
    const { referenceType, referenceId, participantUserIds, providerRoomId } = request.body ?? {};

    if (typeof referenceType !== "string" || !VALID_REFERENCE_TYPES.includes(referenceType as ReferenceType)) {
      return reply.code(400).send({ error: `referenceType must be one of ${VALID_REFERENCE_TYPES.join(", ")}` });
    }
    if (typeof referenceId !== "string" || referenceId.length === 0) {
      return reply.code(400).send({ error: "referenceId is required" });
    }
    if (!Array.isArray(participantUserIds) || participantUserIds.length === 0) {
      return reply.code(400).send({ error: "participantUserIds must be a non-empty array" });
    }
    if (!participantUserIds.every((id) => typeof id === "string" && id.length > 0)) {
      return reply.code(400).send({ error: "participantUserIds must all be non-empty strings" });
    }

    // filter to users who currently have the setting on -- per section 7 of the design doc, a
    // participant who never enabled it gets no row at all, not a pending one that silently never
    // generates
    const enabledUsers = await userClient.getEnabledUsers(participantUserIds);

    const deliveryIds: string[] = [];
    for (const user of enabledUsers) {
      // idempotent -- calling trigger twice for the same session must not create duplicate rows
      // or duplicate queue jobs per user
      const delivery = await deliveriesRepository.findOrCreate({
        userId: user.id,
        referenceType: referenceType as ReferenceType,
        referenceId,
      });
      deliveryIds.push(delivery.id);

      if (delivery.status === "pending" && deliveryQueue) {
        await deliveryQueue.add({ deliveryId: delivery.id, providerRoomId });
      }
    }

    request.log.info({ referenceType, referenceId, deliveryCount: deliveryIds.length }, "ai-notes trigger processed");
    return reply.code(202).send({ deliveryIds });
  });

  app.get("/ai-notes/my", async (request, reply) => {
    const callerUserId = requireUserId(request);
    const deliveries = await deliveriesRepository.listByUser(callerUserId);
    return reply.send(deliveries);
  });

  app.get<{ Params: { id: string } }>("/ai-notes/:id", async (request, reply) => {
    const callerUserId = requireUserId(request);
    const delivery = await deliveriesRepository.getById(request.params.id);
    if (!delivery) {
      return reply.code(404).send({ error: "delivery not found" });
    }
    // privacy-critical: this row holds a transcript and notes of a real session -- only the
    // participant the row was generated for may ever read it. matching a caller-supplied path
    // param against the row's own userId, never trusting anything else on the request, is the
    // entire access-control boundary here
    if (delivery.userId !== callerUserId) {
      return reply.code(403).send({ error: "not authorized to view this delivery" });
    }
    return reply.send(delivery);
  });

  app.get<{ Querystring: ListAdminQuery }>("/admin/ai-notes", async (request, reply) => {
    if (!requireAdminRole(request, reply)) return;

    const { status } = request.query ?? {};
    if (status !== undefined && !VALID_STATUSES.includes(status as DeliveryStatus)) {
      return reply.code(400).send({ error: `status must be one of ${VALID_STATUSES.join(", ")}` });
    }

    const deliveries = await deliveriesRepository.listAll(status as DeliveryStatus | undefined);
    return reply.send(deliveries);
  });

  app.post<{ Params: { id: string } }>("/admin/ai-notes/:id/retry", async (request, reply) => {
    if (!requireAdminRole(request, reply)) return;

    const delivery = await deliveriesRepository.getById(request.params.id);
    if (!delivery) {
      return reply.code(404).send({ error: "delivery not found" });
    }
    if (delivery.status !== "failed") {
      return reply.code(409).send({ error: "only a failed delivery can be retried" });
    }

    if (deliveryQueue) {
      await deliveryQueue.add({ deliveryId: delivery.id });
    }
    await auditLogClient.record({
      adminUserId: (request.headers["x-user-id"] as string) ?? "unknown",
      adminUsername: (request.headers["x-user-username"] as string) ?? "unknown",
      action: "retry_ai_notes_delivery",
      targetType: "ai_notes_delivery",
      targetId: delivery.id,
    });
    request.log.info({ deliveryId: delivery.id }, "ai-notes delivery re-enqueued by admin");
    return reply.code(202).send({ deliveryId: delivery.id });
  });

  return app;
}
