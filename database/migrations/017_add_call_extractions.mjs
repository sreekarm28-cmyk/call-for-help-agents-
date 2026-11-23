export function up(pgm) {
  pgm.sql(`
    CREATE TABLE call_extractions (
      call_attempt_id bigint PRIMARY KEY REFERENCES call_attempts(id) ON DELETE CASCADE,
      extraction_status text NOT NULL DEFAULT 'pending'
        CHECK (extraction_status IN ('pending', 'completed', 'failed')),
      provider_response text
        CHECK (provider_response IN ('offer_received', 'needs_clarification', 'declined', 'no_answer')),
      visit_fee numeric(12,2) CHECK (visit_fee >= 0),
      fee_covers text,
      repair_fee_min numeric(12,2) CHECK (repair_fee_min >= 0),
      repair_fee_max numeric(12,2) CHECK (repair_fee_max >= 0),
      repair_cost_notes text,
      visit_date date,
      visit_time time,
      availability_as_said text,
      summary text,
      evidence jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(evidence) = 'array'),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      extracted_at timestamptz,
      CHECK ((repair_fee_min IS NULL) = (repair_fee_max IS NULL)),
      CHECK (repair_fee_min <= repair_fee_max)
    );
  `);
}

export function down(pgm) {
  pgm.dropTable('call_extractions');
}
