export function up(pgm) {
  pgm.sql(`
    ALTER TABLE bookings ADD COLUMN confirmation_role text NOT NULL DEFAULT 'primary'
      CHECK (confirmation_role IN ('primary', 'backup'));
    UPDATE bookings b SET confirmation_role = 'backup' WHERE EXISTS (
      SELECT 1 FROM bookings original WHERE original.request_id = b.request_id
        AND original.backup_offer_id = b.offer_id AND original.id < b.id);
    ALTER TABLE call_attempts ADD COLUMN available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
  `);
}
export const down = false;
