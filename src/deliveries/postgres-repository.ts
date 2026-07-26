import { Pool } from "pg";
import {
  CreateDeliveryInput,
  Delivery,
  DeliveriesRepository,
  DeliveryStatus,
  ReferenceType,
} from "./repository.js";

interface DeliveryRow {
  id: string;
  user_id: string;
  reference_type: ReferenceType;
  reference_id: string;
  transcript_text: string | null;
  notes_text: string | null;
  status: DeliveryStatus;
  sent_at: string | null;
  created_at: string;
}

function toDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    userId: row.user_id,
    referenceType: row.reference_type,
    referenceId: row.reference_id,
    transcriptText: row.transcript_text,
    notesText: row.notes_text,
    status: row.status,
    sentAt: row.sent_at,
    createdAt: row.created_at,
  };
}

export class PostgresDeliveriesRepository implements DeliveriesRepository {
  constructor(private readonly pool: Pool) {}

  async findOrCreate(input: CreateDeliveryInput): Promise<Delivery> {
    // ON CONFLICT DO NOTHING + a follow-up select rather than a raw catch on the unique
    // violation -- avoids a round trip through an exception for what's a routine, expected path
    // (a session's trigger firing more than once), same idempotency shape as the retry logic
    // elsewhere in this org
    const inserted = await this.pool.query<DeliveryRow>(
      `INSERT INTO ai_notes_deliveries (user_id, reference_type, reference_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, reference_type, reference_id) DO NOTHING
       RETURNING *`,
      [input.userId, input.referenceType, input.referenceId],
    );
    if (inserted.rows[0]) return toDelivery(inserted.rows[0]);

    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT * FROM ai_notes_deliveries WHERE user_id = $1 AND reference_type = $2 AND reference_id = $3`,
      [input.userId, input.referenceType, input.referenceId],
    );
    return toDelivery(rows[0]);
  }

  async getById(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query<DeliveryRow>("SELECT * FROM ai_notes_deliveries WHERE id = $1", [id]);
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  async listByUser(userId: string): Promise<Delivery[]> {
    const { rows } = await this.pool.query<DeliveryRow>(
      "SELECT * FROM ai_notes_deliveries WHERE user_id = $1 ORDER BY created_at DESC",
      [userId],
    );
    return rows.map(toDelivery);
  }

  async listAll(status?: DeliveryStatus): Promise<Delivery[]> {
    const { rows } = status
      ? await this.pool.query<DeliveryRow>(
          "SELECT * FROM ai_notes_deliveries WHERE status = $1 ORDER BY created_at DESC",
          [status],
        )
      : await this.pool.query<DeliveryRow>("SELECT * FROM ai_notes_deliveries ORDER BY created_at DESC");
    return rows.map(toDelivery);
  }

  async markGenerated(id: string, transcriptText: string, notesText: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE ai_notes_deliveries SET transcript_text = $2, notes_text = $3, status = 'generated'
       WHERE id = $1 RETURNING *`,
      [id, transcriptText, notesText],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  async markSent(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE ai_notes_deliveries SET status = 'sent', sent_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }

  async markFailed(id: string): Promise<Delivery | null> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `UPDATE ai_notes_deliveries SET status = 'failed' WHERE id = $1 RETURNING *`,
      [id],
    );
    return rows[0] ? toDelivery(rows[0]) : null;
  }
}
