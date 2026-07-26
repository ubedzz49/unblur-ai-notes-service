import Queue from "bull";
import { DeliveriesRepository } from "./deliveries/repository.js";
import { TranscriptProvider } from "./transcripts/provider.js";
import { LlmClient } from "./llm/client.js";
import { EmailSender } from "./email/sender.js";
import { buildAiNotesEmail } from "./email/ai-notes-email.js";
import { NotificationClient } from "./notifications/client.js";
import { UserClient } from "./users/client.js";
import { DeliveryJobData } from "./queue/delivery-queue.js";
import { logger } from "./logger.js";

export interface WorkerDeps {
  deliveriesRepository: DeliveriesRepository;
  transcriptProvider: TranscriptProvider;
  llmClient: LlmClient;
  emailSender: EmailSender;
  notificationClient: NotificationClient;
  userClient: UserClient;
  webAppBaseUrl: string;
}

// processes one "generate and send" job for a single delivery row. every step is wrapped so a
// failure anywhere marks the delivery failed and logs a warning rather than throwing -- a
// crashed worker process would stall every other queued delivery behind it, and per
// 12_implementation section 7 a failed generation/send is expected, retryable state, not a
// crash-worthy bug
export async function processDeliveryJob(job: Queue.Job<DeliveryJobData>, deps: WorkerDeps): Promise<void> {
  const { deliveryId, providerRoomId } = job.data;
  const delivery = await deps.deliveriesRepository.getById(deliveryId);
  if (!delivery) {
    logger.warn({ deliveryId }, "ai-notes worker: delivery row not found, skipping");
    return;
  }

  // Resolution/Seminar/GD services don't yet expose an endpoint to map a booking/seminar/gd id
  // to its Daily room name (that lookup is a separate follow-up task in those services' repos,
  // not this one) -- so providerRoomId only ever arrives if the caller of
  // POST /internal/ai-notes/trigger happened to pass it through. Missing it is an expected,
  // graceful-failure case for now, not a bug in this service.
  if (!providerRoomId) {
    logger.warn({ deliveryId }, "ai-notes worker: no providerRoomId supplied, marking delivery failed");
    await deps.deliveriesRepository.markFailed(deliveryId);
    return;
  }

  let rawTranscript: string;
  try {
    const transcripts = await deps.transcriptProvider.listTranscripts(providerRoomId);
    if (transcripts.length === 0) {
      logger.warn({ deliveryId, providerRoomId }, "ai-notes worker: no transcript available for room, marking failed");
      await deps.deliveriesRepository.markFailed(deliveryId);
      return;
    }
    rawTranscript = await deps.transcriptProvider.getTranscriptText(transcripts[0].transcriptId);
  } catch (err) {
    logger.warn({ deliveryId, providerRoomId, err }, "ai-notes worker: failed to fetch transcript");
    await deps.deliveriesRepository.markFailed(deliveryId);
    return;
  }

  let cleanedTranscript: string;
  let notesText: string;
  try {
    const generated = await deps.llmClient.generateNotes(rawTranscript);
    cleanedTranscript = generated.cleanedTranscript;
    notesText = generated.notesText;
  } catch (err) {
    logger.warn({ deliveryId, err }, "ai-notes worker: llm generation failed");
    await deps.deliveriesRepository.markFailed(deliveryId);
    return;
  }

  const generatedDelivery = await deps.deliveriesRepository.markGenerated(deliveryId, cleanedTranscript, notesText);
  if (!generatedDelivery) {
    logger.warn({ deliveryId }, "ai-notes worker: delivery row disappeared after generation, aborting send");
    return;
  }

  try {
    const enabledUsers = await deps.userClient.getEnabledUsers([generatedDelivery.userId]);
    const user = enabledUsers[0];
    if (user) {
      const { subject, text } = buildAiNotesEmail(deliveryId, deps.webAppBaseUrl);
      await deps.emailSender.send(user.email, subject, text);
    } else {
      // user may have turned the setting off between trigger and now -- notes still get stored,
      // just not emailed/notified
      logger.warn({ deliveryId }, "ai-notes worker: user no longer enabled or not found, skipping email");
    }
    await deps.notificationClient.sendAiNotesReady({
      userId: generatedDelivery.userId,
      referenceId: deliveryId,
      title: "Your AI notes are ready",
      body: "Tap to view your session's transcript and notes.",
    });
    await deps.deliveriesRepository.markSent(deliveryId);
    logger.info({ deliveryId }, "ai-notes worker: delivery sent");
  } catch (err) {
    logger.warn({ deliveryId, err }, "ai-notes worker: send step failed");
    await deps.deliveriesRepository.markFailed(deliveryId);
  }
}

export function startWorker(queue: Queue.Queue<DeliveryJobData>, deps: WorkerDeps): void {
  queue.process(async (job) => {
    // never let a thrown error surface here -- processDeliveryJob already catches everything it
    // can, this is a last-resort net so a genuinely unexpected error still doesn't crash the
    // Fastify process the worker is embedded in
    try {
      await processDeliveryJob(job, deps);
    } catch (err) {
      logger.error({ deliveryId: job.data.deliveryId, err }, "ai-notes worker: unhandled error processing job");
    }
  });
}
