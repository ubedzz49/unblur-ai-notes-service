import { describe, expect, it } from "vitest";
import { InMemoryDeliveriesRepository } from "./repository.js";

const USER_A = "11111111-1111-1111-1111-111111111111";
const USER_B = "22222222-2222-2222-2222-222222222222";
const REF_ID = "33333333-3333-3333-3333-333333333333";

describe("InMemoryDeliveriesRepository", () => {
  it("creates a new delivery in pending status", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const delivery = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    expect(delivery.status).toBe("pending");
    expect(delivery.userId).toBe(USER_A);
    expect(delivery.transcriptText).toBeNull();
    expect(delivery.notesText).toBeNull();
  });

  it("is idempotent -- calling findOrCreate twice for the same (user, referenceType, referenceId) returns the same row", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const first = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    const second = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    expect(second.id).toBe(first.id);
    const all = await repo.listByUser(USER_A);
    expect(all).toHaveLength(1);
  });

  it("creates separate rows for different users on the same session", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const a = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    const b = await repo.findOrCreate({ userId: USER_B, referenceType: "booking", referenceId: REF_ID });
    expect(a.id).not.toBe(b.id);
  });

  it("creates separate rows for the same user across different reference types", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const booking = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    const seminar = await repo.findOrCreate({ userId: USER_A, referenceType: "seminar", referenceId: REF_ID });
    expect(booking.id).not.toBe(seminar.id);
  });

  it("markGenerated sets transcript/notes text and status", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const delivery = await repo.findOrCreate({ userId: USER_A, referenceType: "gd", referenceId: REF_ID });
    const updated = await repo.markGenerated(delivery.id, "cleaned transcript", "structured notes");
    expect(updated?.status).toBe("generated");
    expect(updated?.transcriptText).toBe("cleaned transcript");
    expect(updated?.notesText).toBe("structured notes");
  });

  it("markSent sets status and sentAt", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const delivery = await repo.findOrCreate({ userId: USER_A, referenceType: "gd", referenceId: REF_ID });
    const updated = await repo.markSent(delivery.id);
    expect(updated?.status).toBe("sent");
    expect(updated?.sentAt).not.toBeNull();
  });

  it("markFailed sets status to failed", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const delivery = await repo.findOrCreate({ userId: USER_A, referenceType: "gd", referenceId: REF_ID });
    const updated = await repo.markFailed(delivery.id);
    expect(updated?.status).toBe("failed");
  });

  it("returns null from markGenerated/markSent/markFailed for an unknown id", async () => {
    const repo = new InMemoryDeliveriesRepository();
    expect(await repo.markGenerated("does-not-exist", "a", "b")).toBeNull();
    expect(await repo.markSent("does-not-exist")).toBeNull();
    expect(await repo.markFailed("does-not-exist")).toBeNull();
  });

  it("listAll with no status returns everything, filters when given one", async () => {
    const repo = new InMemoryDeliveriesRepository();
    const d1 = await repo.findOrCreate({ userId: USER_A, referenceType: "booking", referenceId: REF_ID });
    await repo.findOrCreate({ userId: USER_B, referenceType: "booking", referenceId: REF_ID });
    await repo.markFailed(d1.id);

    expect(await repo.listAll()).toHaveLength(2);
    expect(await repo.listAll("failed")).toHaveLength(1);
    expect(await repo.listAll("pending")).toHaveLength(1);
  });

  it("getById returns null for an unknown id", async () => {
    const repo = new InMemoryDeliveriesRepository();
    expect(await repo.getById("does-not-exist")).toBeNull();
  });
});
