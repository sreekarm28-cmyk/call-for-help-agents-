export function up(pgm) {
  pgm.sql(`
    CREATE TABLE request_provider_choices (
      request_id bigint PRIMARY KEY REFERENCES service_requests(id) ON DELETE CASCADE,
      primary_place_id text NOT NULL,
      backup_place_id text,
      updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (primary_place_id <> backup_place_id)
    );
    ALTER TABLE call_attempts DROP CONSTRAINT call_attempts_status_check;
    ALTER TABLE call_attempts ADD CONSTRAINT call_attempts_status_check CHECK (status IN
      ('queued','calling','transcript_received','no_answer','rejected','declined','offer_received','confirmed','failed','cancelled'));
  `);
}
export const down = false;
