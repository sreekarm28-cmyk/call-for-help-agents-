export function up(pgm) {
  pgm.addColumn('scheduled_jobs', {
    request_id: {
      type: 'bigint',
      references: 'service_requests',
      onDelete: 'CASCADE',
      unique: true,
    },
  });
}

export function down(pgm) {
  pgm.dropColumn('scheduled_jobs', 'request_id');
}
