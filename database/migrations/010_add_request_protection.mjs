export function up(pgm) {
  pgm.addColumns('service_requests', { submission_id: { type: 'uuid' } });
  pgm.addConstraint('service_requests', 'service_requests_user_submission_unique', {
    unique: ['user_id', 'submission_id'],
  });
  pgm.createTable('request_rate_limits', {
    key: { type: 'text', primaryKey: true },
    count: { type: 'integer', notNull: true },
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('request_rate_limits', 'expires_at');
}

export function down(pgm) {
  pgm.dropTable('request_rate_limits');
  pgm.dropConstraint('service_requests', 'service_requests_user_submission_unique');
  pgm.dropColumns('service_requests', 'submission_id');
}
