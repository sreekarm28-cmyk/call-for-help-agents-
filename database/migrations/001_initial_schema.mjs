import { readFileSync } from 'node:fs';

const schema = readFileSync(new URL('../001_initial_schema.sql', import.meta.url), 'utf8')
  .replace(/^\s*BEGIN;\s*/i, '')
  .replace(/\s*COMMIT;\s*$/i, '');

export function up(pgm) {
  pgm.sql(schema);
}

export function down(pgm) {
  pgm.sql('DROP TABLE IF EXISTS public.service_requests');
  pgm.sql('DROP TABLE IF EXISTS public.users');
}
