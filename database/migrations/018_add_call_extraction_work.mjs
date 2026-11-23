export function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_attempts DROP CONSTRAINT call_attempts_status_check;
    ALTER TABLE call_attempts ADD CHECK (status IN
      ('queued', 'calling', 'transcript_received', 'no_answer', 'declined', 'offer_received', 'confirmed', 'failed', 'cancelled'));
    ALTER TABLE call_extractions
      ADD COLUMN attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
    CREATE INDEX call_extractions_pending ON call_extractions (available_at, call_attempt_id)
      WHERE extraction_status = 'pending';
  `);
}

export const down = false;
