export function up(pgm) {
  pgm.addColumn('service_requests', {
    preferred_language: {
      type: 'text',
      check: "preferred_language = btrim(preferred_language) AND length(preferred_language) > 0",
    },
  });
}

export function down(pgm) {
  pgm.dropColumn('service_requests', 'preferred_language');
}
