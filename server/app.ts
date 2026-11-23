import { randomBytes } from 'node:crypto';
import connectPgSimple from 'connect-pg-simple';
import express from 'express';
import session from 'express-session';
import type { Pool } from 'pg';
import { registerCallTranscriptRoute } from './call-transcripts';
import { registerAuthRoutes } from './routes/auth';
import { registerDashboardRoutes } from './routes/dashboard';
import { registerProviderRoutes } from './routes/providers';
import { registerBookingRoutes } from './routes/bookings';
import { registerRequestRoutes } from './routes/requests';

declare module 'express-session' {
  interface SessionData {
    userId: string;
    email: string;
  }
}

export function createApp(pool: Pool) {
  const app = express();
  const PgSessionStore = connectPgSimple(session);
  const sessionSecret = process.env.SESSION_SECRET ?? randomBytes(32).toString('hex');
  registerCallTranscriptRoute(app, pool);
  app.use(express.json({ limit: '100kb' }));
  app.use(session({
    store: new PgSessionStore({
      pool,
      tableName: 'user_sessions',
    }),
    name: 'helpfully.sid',
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
  }));

  registerAuthRoutes(app, pool);
  app.get('/api/health', async (_request, response) => {
    await pool.query('SELECT 1');
    response.json({ status: 'ok' });
  });
  registerDashboardRoutes(app, pool);
  registerProviderRoutes(app, pool);
  registerBookingRoutes(app, pool);
  registerRequestRoutes(app, pool);

  const handleApiError: express.ErrorRequestHandler = (error, _request, response, next) => {
    console.error('api_request_failed');
    if (response.headersSent) {
      next(new Error('API request failed.'));
      return;
    }
    const status = error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 500;
    response.status(status).json({ error: status === 500 ? 'Something went wrong. Please try again.' : 'Invalid request body.' });
  };
  app.use(handleApiError);
  return app;
}
