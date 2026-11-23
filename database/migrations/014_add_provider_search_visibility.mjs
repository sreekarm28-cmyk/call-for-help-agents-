export function up(pgm) {
  pgm.addColumn('service_requests', {
    providers_hidden_at: { type: 'timestamptz' },
  });
}

export function down(pgm) {
  pgm.dropColumn('service_requests', 'providers_hidden_at');
}
