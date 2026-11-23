export function up(pgm) {
  pgm.addColumns('scheduled_jobs', {
    attempt_count: { type: 'integer', notNull: true, default: 0 },
    lease_expires_at: { type: 'timestamptz' },
  });
  pgm.sql("UPDATE scheduled_jobs SET lease_expires_at = CURRENT_TIMESTAMP WHERE status = 'running'");
  pgm.createIndex('scheduled_jobs', ['lease_expires_at'], {
    name: 'scheduled_jobs_running_lease_idx',
    where: "status = 'running'",
  });
}

export function down(pgm) {
  pgm.dropIndex('scheduled_jobs', ['lease_expires_at'], { name: 'scheduled_jobs_running_lease_idx' });
  pgm.dropColumns('scheduled_jobs', ['attempt_count', 'lease_expires_at']);
}
