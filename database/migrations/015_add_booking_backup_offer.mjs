export function up(pgm) {
  pgm.sql(`
    ALTER TABLE bookings ADD COLUMN backup_offer_id bigint;
    ALTER TABLE bookings ADD CONSTRAINT bookings_backup_offer_fk
      FOREIGN KEY (request_id, backup_offer_id) REFERENCES provider_offers (request_id, id);
    ALTER TABLE bookings ADD CONSTRAINT bookings_backup_distinct
      CHECK (backup_offer_id <> offer_id);
  `);
}

export function down(pgm) {
  pgm.dropColumn('bookings', 'backup_offer_id');
}
