import { buildApp } from "./app.js";
import { buildDbPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { PostgresDeliveriesRepository } from "./deliveries/postgres-repository.js";
import { HttpUserClient } from "./users/client.js";
import { DailyTranscriptProvider } from "./transcripts/provider.js";
import { OpenRouterLlmClient } from "./llm/client.js";
import { SendgridEmailSender } from "./email/sendgrid-sender.js";
import { HttpNotificationClient } from "./notifications/client.js";
import { buildDeliveryQueue } from "./queue/delivery-queue.js";
import { startWorker } from "./worker.js";
import { logger } from "./logger.js";

const port = Number(process.env.PORT ?? 3010);
const webAppBaseUrl = process.env.WEB_APP_BASE_URL ?? "";

// fail closed, same philosophy as every other service's INTERNAL_SERVICE_TOKEN check -- an unset
// token would otherwise mean this service silently accepts any internal request
if (!process.env.INTERNAL_SERVICE_TOKEN) {
  logger.fatal("INTERNAL_SERVICE_TOKEN is not set, refusing to start");
  process.exit(1);
}

const dbPool = buildDbPool();
const deliveriesRepository = new PostgresDeliveriesRepository(dbPool);
const deliveryQueue = buildDeliveryQueue();

runMigrations(dbPool)
  .then(() => {
    const app = buildApp(
      deliveriesRepository,
      new HttpUserClient(),
      process.env.INTERNAL_SERVICE_TOKEN,
      deliveryQueue,
    );

    // worker runs in-process alongside the Fastify server (documented in README) -- keeps
    // deployment to a single ECS task/service rather than standing up a separate worker fleet
    // for what's a modest job volume (one job per enabled participant per session)
    startWorker(deliveryQueue, {
      deliveriesRepository,
      transcriptProvider: new DailyTranscriptProvider(),
      llmClient: new OpenRouterLlmClient(),
      emailSender: new SendgridEmailSender(),
      notificationClient: new HttpNotificationClient(),
      userClient: new HttpUserClient(),
      webAppBaseUrl,
    });

    return app.listen({ port, host: "0.0.0.0" }).then(() => app.log.info({ port }, "ai-notes-service listening"));
  })
  .catch((err) => {
    logger.error({ err }, "ai-notes-service failed to start");
    process.exit(1);
  });
