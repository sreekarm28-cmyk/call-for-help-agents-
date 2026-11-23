export function up(pgm) {
  pgm.sql(`
    ALTER TABLE call_attempts DROP CONSTRAINT call_attempts_confirmation_booking_id_key;
    ALTER TABLE call_attempts ADD CONSTRAINT call_attempts_booking_attempt_unique
      UNIQUE (confirmation_booking_id, id);
    ALTER TABLE bookings ADD COLUMN confirmation_call_attempt_id bigint;
    UPDATE bookings b SET confirmation_call_attempt_id = latest.id
      FROM (SELECT confirmation_booking_id, max(id) AS id FROM call_attempts
            WHERE confirmation_booking_id IS NOT NULL GROUP BY confirmation_booking_id) latest
      WHERE b.id = latest.confirmation_booking_id;
    ALTER TABLE bookings ADD CONSTRAINT bookings_confirmation_attempt_fk
      FOREIGN KEY (id, confirmation_call_attempt_id)
      REFERENCES call_attempts (confirmation_booking_id, id);
    CREATE UNIQUE INDEX call_attempts_one_active_confirmation ON call_attempts (confirmation_booking_id)
      WHERE confirmation_booking_id IS NOT NULL AND status IN ('queued', 'calling');
  `);
}

// A booking may have several historical attempts after this migration.
export const down = false;
