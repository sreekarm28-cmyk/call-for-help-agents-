export function up(pgm) {
  pgm.addColumns('users', {
    contact_name: {
      type: 'varchar(100)',
    },
    contact_phone: {
      type: 'varchar(25)',
    },
    service_address: {
      type: 'varchar(500)',
    },
  });
}

export function down(pgm) {
  pgm.dropColumns('users', ['contact_name', 'contact_phone', 'service_address']);
}
