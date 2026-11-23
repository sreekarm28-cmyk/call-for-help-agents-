export function up(pgm) {
  pgm.sql(`
    CREATE TABLE call_attempts (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id bigint NOT NULL REFERENCES service_requests ON DELETE CASCADE,
      google_place_id text NOT NULL,
      phone_call_id text UNIQUE,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'calling', 'no_answer', 'declined', 'offer_received', 'failed', 'cancelled')),
      started_at timestamptz,
      ended_at timestamptz,
      transcript text,
      summary text,
      UNIQUE (request_id, id)
    );
    CREATE UNIQUE INDEX call_attempts_one_active_per_request
      ON call_attempts (request_id) WHERE status IN ('queued', 'calling');

    CREATE TABLE provider_offers (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id bigint NOT NULL,
      call_attempt_id bigint NOT NULL UNIQUE,
      visit_at timestamptz NOT NULL,
      visit_fee numeric(12,2) NOT NULL CHECK (visit_fee >= 0),
      repair_cost_notes text,
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (request_id, id),
      FOREIGN KEY (request_id, call_attempt_id) REFERENCES call_attempts (request_id, id) ON DELETE CASCADE
    );

    CREATE TABLE bookings (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      request_id bigint NOT NULL,
      offer_id bigint NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'awaiting_provider_confirmation'
        CHECK (status IN ('awaiting_provider_confirmation', 'confirmed', 'cancelled', 'no_show', 'completed')),
      created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      status_changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (request_id, offer_id) REFERENCES provider_offers (request_id, id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX bookings_one_active_per_request
      ON bookings (request_id) WHERE status IN ('awaiting_provider_confirmation', 'confirmed');
  `);
}

export function down(pgm) {
  pgm.dropTable('bookings');
  pgm.dropTable('provider_offers');
  pgm.dropTable('call_attempts');
}
