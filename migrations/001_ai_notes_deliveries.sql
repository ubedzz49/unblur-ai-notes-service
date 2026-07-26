-- Shares the same RDS instance and database as the other unblur services (pragmatic reuse of
-- existing infra) -- this service owns and only touches this table.
CREATE TABLE IF NOT EXISTS ai_notes_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- soft reference to user-service's users.id -- same physical DB, different service's table,
  -- no cross-db FK, same pattern as recording-service's complaints.complainant_user_id
  user_id UUID NOT NULL,
  -- which service's session this delivery is for -- booking (resolution), seminar, or gd
  reference_type TEXT NOT NULL CHECK (reference_type IN ('booking', 'seminar', 'gd')),
  reference_id UUID NOT NULL,
  transcript_text TEXT NULL,
  notes_text TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'generated', 'sent', 'failed')),
  sent_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- one delivery row per user per session -- a trigger call fired twice for the same session
  -- (retry, duplicate webhook) must not create a second row, per the idempotency rule in
  -- 12_implementation_ai_notes_transcripts_service.txt section 7
  UNIQUE (user_id, reference_type, reference_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_notes_deliveries_user ON ai_notes_deliveries (user_id);
CREATE INDEX IF NOT EXISTS idx_ai_notes_deliveries_status ON ai_notes_deliveries (status);
