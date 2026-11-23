import 'dotenv/config';
import pg from 'pg';
import { createApp } from './app';
import { shutdownTracing } from './instrumentation';

const { Pool } = pg;

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required. Add it to the .env file.');
}

const pool = new Pool({ connectionString: databaseUrl });
setInterval(() => {
  void pool.query('DELETE FROM request_rate_limits WHERE expires_at <= CURRENT_TIMESTAMP')
    .catch(() => console.error('rate_limit_cleanup_failed'));
}, 3_600_000).unref();
const app = createApp(pool);
const port = Number(process.env.API_PORT ?? 3001);

const server = app.listen(port, '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') {
    console.log(`API listening at http://127.0.0.1:${address.port}`);
  }
});

let stopping = false;
function stopServer() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    void Promise.all([shutdownTracing(), pool.end()]).catch(() => {
      console.error('api_shutdown_failed');
      process.exitCode = 1;
    });
  });
}
process.once('SIGINT', stopServer);
process.once('SIGTERM', stopServer);
