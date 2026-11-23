export function up(pgm) {
  pgm.sql(`ALTER TABLE call_extractions ADD COLUMN confirmation_decision text
    CHECK (confirmation_decision IN ('confirmed', 'declined', 'needs_clarification'))`);
}

export function down(pgm) {
  pgm.dropColumn('call_extractions', 'confirmation_decision');
}
