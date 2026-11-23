export function up(pgm) {
  pgm.addColumn('service_requests', { current_booking_hidden_at: { type: 'timestamptz' } });
}

export function down(pgm) {
  pgm.dropColumn('service_requests', 'current_booking_hidden_at');
}
