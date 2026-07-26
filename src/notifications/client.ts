// mirrors notification-service's POST /internal/notifications shape exactly (see
// notification-service/src/app.ts) -- referenceType/referenceId here point back at this
// service's own delivery row, so tapping the in-app notification deep-links to GET /ai-notes/:id
export interface SendNotificationInput {
  userId: string;
  referenceId: string;
  title: string;
  body?: string;
}

export interface NotificationClient {
  sendAiNotesReady(input: SendNotificationInput): Promise<void>;
}

const REQUEST_TIMEOUT_MS = 2000;

export class HttpNotificationClient implements NotificationClient {
  private baseUrl: string;
  private internalToken: string;

  constructor(baseUrl = process.env.NOTIFICATION_SERVICE_URL ?? "", internalToken = process.env.INTERNAL_SERVICE_TOKEN ?? "") {
    this.baseUrl = baseUrl;
    this.internalToken = internalToken;
  }

  async sendAiNotesReady(input: SendNotificationInput): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL("/internal/notifications", this.baseUrl);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Internal-Service-Token": this.internalToken,
        },
        body: JSON.stringify({
          userId: input.userId,
          type: "ai_notes_ready",
          referenceType: "ai_notes_delivery",
          referenceId: input.referenceId,
          title: input.title,
          body: input.body,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`notification service returned ${res.status} sending ai-notes-ready notification`);
      }
    } finally {
      clearTimeout(timeout);
    }
  }
}

// test-only
export class FakeNotificationClient implements NotificationClient {
  public calls: SendNotificationInput[] = [];

  async sendAiNotesReady(input: SendNotificationInput): Promise<void> {
    this.calls.push(input);
  }
}

// test-only -- simulates notification-service being unreachable, to prove the worker's send
// step degrades gracefully rather than crashing
export class ThrowingNotificationClient implements NotificationClient {
  async sendAiNotesReady(): Promise<void> {
    throw new Error("notification service unreachable");
  }
}
