export function up(pgm) {
  pgm.sql(`
    ALTER TABLE service_requests
      ADD COLUMN latitude double precision CHECK (latitude BETWEEN -90 AND 90),
      ADD COLUMN longitude double precision CHECK (longitude BETWEEN -180 AND 180),
      ADD CONSTRAINT service_requests_coordinate_pair CHECK ((latitude IS NULL) = (longitude IS NULL));
  `);
}

export function down(pgm) {
  pgm.dropConstraint('service_requests', 'service_requests_coordinate_pair');
  pgm.dropColumns('service_requests', ['latitude', 'longitude']);
}
