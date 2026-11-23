export function up(pgm) {
  pgm.addColumn('service_requests', {
    agent_call_time_window: {
      type: 'varchar(20)',
      notNull: true,
      default: 'any',
    },
  });

  pgm.addConstraint('service_requests', 'requests_agent_call_time_window_valid', {
    check: "agent_call_time_window IN ('morning', 'afternoon', 'evening', 'any')",
  });
}

export function down(pgm) {
  pgm.dropConstraint('service_requests', 'requests_agent_call_time_window_valid');
  pgm.dropColumn('service_requests', 'agent_call_time_window');
}
