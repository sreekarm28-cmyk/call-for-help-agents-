export function up(pgm) {
  pgm.createTable('request_events', {
    id: {
      type: 'bigint',
      primaryKey: true,
      notNull: true,
      identity: { always: true },
    },
    request_id: {
      type: 'bigint',
      notNull: true,
      references: 'service_requests',
      onDelete: 'CASCADE',
    },
    event_type: {
      type: 'varchar(60)',
      notNull: true,
    },
    status: {
      type: 'varchar(20)',
      notNull: true,
    },
    actor: {
      type: 'varchar(20)',
      notNull: true,
    },
    started_at: {
      type: 'timestamptz',
      notNull: true,
    },
    ended_at: {
      type: 'timestamptz',
    },
    duration_ms: {
      type: 'bigint',
    },
    message: {
      type: 'text',
    },
    metadata: {
      type: 'jsonb',
      notNull: true,
      default: '{}',
    },
    created_at: {
      type: 'timestamptz',
      notNull: true,
      default: pgm.func('CURRENT_TIMESTAMP'),
    },
  });

  pgm.createIndex('request_events', ['request_id', { name: 'created_at', sort: 'DESC' }], {
    name: 'request_events_request_created_idx',
  });
}

export function down(pgm) {
  pgm.dropTable('request_events');
}
