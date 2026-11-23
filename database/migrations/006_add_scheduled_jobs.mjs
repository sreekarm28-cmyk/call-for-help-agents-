export function up(pgm) {
  pgm.createTable('scheduled_jobs', {
    id: {
      type: 'bigint',
      primaryKey: true,
      identity: { always: true },
    },
    run_at: {
      type: 'timestamptz',
      notNull: true,
    },
    status: {
      type: 'text',
      notNull: true,
      default: 'pending',
      check: "status IN ('pending', 'running', 'completed', 'failed')",
    },
    message: {
      type: 'text',
      notNull: true,
    },
  });

  pgm.createIndex('scheduled_jobs', ['run_at', 'id'], {
    name: 'scheduled_jobs_pending_run_at_idx',
    where: "status = 'pending'",
  });
}

export function down(pgm) {
  pgm.dropTable('scheduled_jobs');
}
