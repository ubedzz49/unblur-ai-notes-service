export type ReferenceType = "booking" | "seminar" | "gd";
export type DeliveryStatus = "pending" | "generated" | "sent" | "failed";

export interface Delivery {
  id: string;
  userId: string;
  referenceType: ReferenceType;
  referenceId: string;
  transcriptText: string | null;
  notesText: string | null;
  status: DeliveryStatus;
  sentAt: string | null;
  createdAt: string;
}

export interface CreateDeliveryInput {
  userId: string;
  referenceType: ReferenceType;
  referenceId: string;
}

export interface DeliveriesRepository {
  // idempotent -- returns the existing row if (userId, referenceType, referenceId) already has
  // one, per the "only one ai_notes_delivery row per user per session" rule
  findOrCreate(input: CreateDeliveryInput): Promise<Delivery>;
  getById(id: string): Promise<Delivery | null>;
  listByUser(userId: string): Promise<Delivery[]>;
  // admin-only -- omit status to list every delivery regardless of state
  listAll(status?: DeliveryStatus): Promise<Delivery[]>;
  markGenerated(id: string, transcriptText: string, notesText: string): Promise<Delivery | null>;
  markSent(id: string): Promise<Delivery | null>;
  markFailed(id: string): Promise<Delivery | null>;
}

// test-only -- avoids CI needing real Postgres
export class InMemoryDeliveriesRepository implements DeliveriesRepository {
  private deliveries = new Map<string, Delivery>();
  private byKey = new Map<string, string>();

  private key(userId: string, referenceType: ReferenceType, referenceId: string): string {
    return `${userId}:${referenceType}:${referenceId}`;
  }

  async findOrCreate(input: CreateDeliveryInput): Promise<Delivery> {
    const key = this.key(input.userId, input.referenceType, input.referenceId);
    const existingId = this.byKey.get(key);
    if (existingId) return this.deliveries.get(existingId)!;

    const delivery: Delivery = {
      id: crypto.randomUUID(),
      userId: input.userId,
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      transcriptText: null,
      notesText: null,
      status: "pending",
      sentAt: null,
      createdAt: new Date().toISOString(),
    };
    this.deliveries.set(delivery.id, delivery);
    this.byKey.set(key, delivery.id);
    return delivery;
  }

  async getById(id: string): Promise<Delivery | null> {
    return this.deliveries.get(id) ?? null;
  }

  async listByUser(userId: string): Promise<Delivery[]> {
    return Array.from(this.deliveries.values())
      .filter((d) => d.userId === userId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listAll(status?: DeliveryStatus): Promise<Delivery[]> {
    return Array.from(this.deliveries.values())
      .filter((d) => (status ? d.status === status : true))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async markGenerated(id: string, transcriptText: string, notesText: string): Promise<Delivery | null> {
    const existing = this.deliveries.get(id);
    if (!existing) return null;
    const updated: Delivery = { ...existing, transcriptText, notesText, status: "generated" };
    this.deliveries.set(id, updated);
    return updated;
  }

  async markSent(id: string): Promise<Delivery | null> {
    const existing = this.deliveries.get(id);
    if (!existing) return null;
    const updated: Delivery = { ...existing, status: "sent", sentAt: new Date().toISOString() };
    this.deliveries.set(id, updated);
    return updated;
  }

  async markFailed(id: string): Promise<Delivery | null> {
    const existing = this.deliveries.get(id);
    if (!existing) return null;
    const updated: Delivery = { ...existing, status: "failed" };
    this.deliveries.set(id, updated);
    return updated;
  }
}
