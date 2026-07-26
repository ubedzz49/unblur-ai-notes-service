import { describe, expect, it } from "vitest";
import Queue from "bull";
import { processDeliveryJob, WorkerDeps } from "./worker.js";
import { InMemoryDeliveriesRepository } from "./deliveries/repository.js";
import { FakeTranscriptProvider } from "./transcripts/provider.js";
import { FakeLlmClient, ThrowingLlmClient } from "./llm/client.js";
import { RecordingEmailSender } from "./email/sender.js";
import { FakeNotificationClient, ThrowingNotificationClient } from "./notifications/client.js";
import { FakeUserClient } from "./users/client.js";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const REF_ID = "22222222-2222-2222-2222-222222222222";
const ROOM_NAME = "resolution-room-abc";

function fakeJob(deliveryId: string, providerRoomId?: string): Queue.Job<{ deliveryId: string; providerRoomId?: string }> {
  return { data: { deliveryId, providerRoomId } } as Queue.Job<{ deliveryId: string; providerRoomId?: string }>;
}

async function setup() {
  const deliveriesRepository = new InMemoryDeliveriesRepository();
  const transcriptProvider = new FakeTranscriptProvider();
  const llmClient = new FakeLlmClient();
  const emailSender = new RecordingEmailSender();
  const notificationClient = new FakeNotificationClient();
  const userClient = new FakeUserClient();
  userClient.seed({ id: USER_ID, email: "user@example.com", name: "Test User", aiNotesAndTranscriptsEnabled: true });

  const delivery = await deliveriesRepository.findOrCreate({ userId: USER_ID, referenceType: "booking", referenceId: REF_ID });

  transcriptProvider.transcriptsByRoom.set(ROOM_NAME, [{ transcriptId: "t1", status: "ready" }]);
  transcriptProvider.textByTranscriptId.set("t1", "raw transcript text goes here");

  const deps: WorkerDeps = {
    deliveriesRepository,
    transcriptProvider,
    llmClient,
    emailSender,
    notificationClient,
    userClient,
    webAppBaseUrl: "https://app.unblur.example",
  };

  return { deliveriesRepository, transcriptProvider, llmClient, emailSender, notificationClient, userClient, delivery, deps };
}

describe("processDeliveryJob -- happy path", () => {
  it("generates notes, sends an email and a notification, and marks the delivery sent", async () => {
    const { deliveriesRepository, delivery, deps, emailSender, notificationClient } = await setup();

    await processDeliveryJob(fakeJob(delivery.id, ROOM_NAME), deps);

    const updated = await deliveriesRepository.getById(delivery.id);
    expect(updated?.status).toBe("sent");
    expect(updated?.sentAt).not.toBeNull();
    expect(updated?.transcriptText).toBe("raw transcript text goes here");
    expect(updated?.notesText).toContain("Summary");

    expect(emailSender.sent).toHaveLength(1);
    expect(emailSender.sent[0].to).toBe("user@example.com");
    expect(emailSender.sent[0].text).toContain(delivery.id);

    expect(notificationClient.calls).toHaveLength(1);
    expect(notificationClient.calls[0].userId).toBe(USER_ID);
  });
});

describe("processDeliveryJob -- graceful failure", () => {
  it("marks the delivery failed (not a crash) when providerRoomId is missing", async () => {
    const { deliveriesRepository, delivery, deps } = await setup();

    await expect(processDeliveryJob(fakeJob(delivery.id, undefined), deps)).resolves.toBeUndefined();

    const updated = await deliveriesRepository.getById(delivery.id);
    expect(updated?.status).toBe("failed");
  });

  it("marks the delivery failed when the room has no transcripts yet", async () => {
    const { deliveriesRepository, delivery, deps } = await setup();

    await processDeliveryJob(fakeJob(delivery.id, "some-other-room-with-no-transcripts"), deps);

    const updated = await deliveriesRepository.getById(delivery.id);
    expect(updated?.status).toBe("failed");
  });

  it("marks the delivery failed (not a crash) when the LLM call throws", async () => {
    const { deliveriesRepository, delivery, deps } = await setup();
    deps.llmClient = new ThrowingLlmClient();

    await expect(processDeliveryJob(fakeJob(delivery.id, ROOM_NAME), deps)).resolves.toBeUndefined();

    const updated = await deliveriesRepository.getById(delivery.id);
    expect(updated?.status).toBe("failed");
  });

  it("marks the delivery failed (not a crash) when the notification send fails after generation", async () => {
    const { deliveriesRepository, delivery, deps } = await setup();
    deps.notificationClient = new ThrowingNotificationClient();

    await expect(processDeliveryJob(fakeJob(delivery.id, ROOM_NAME), deps)).resolves.toBeUndefined();

    const updated = await deliveriesRepository.getById(delivery.id);
    // notes were generated before the send step failed -- still marked failed overall, but the
    // generated content isn't lost, an admin retry can pick up from here
    expect(updated?.status).toBe("failed");
    expect(updated?.notesText).not.toBeNull();
  });

  it("does nothing (no throw) when the delivery row no longer exists", async () => {
    const { deps } = await setup();
    await expect(processDeliveryJob(fakeJob("does-not-exist", ROOM_NAME), deps)).resolves.toBeUndefined();
  });
});
