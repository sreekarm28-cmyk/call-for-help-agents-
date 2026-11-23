export function up(pgm) {
  pgm.createTable('user_sessions', {
    sid: {
      type: 'varchar',
      primaryKey: true,
      notNull: true,
    },
    sess: {
      type: 'json',
      notNull: true,
    },
    expire: {
      type: 'timestamp(6)',
      notNull: true,
    },
  });

  pgm.createIndex('user_sessions', 'expire', {
    name: 'user_sessions_expire_idx',
  });
}

export function down(pgm) {
  pgm.dropTable('user_sessions');
}
