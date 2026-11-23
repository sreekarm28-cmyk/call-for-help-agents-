import type { Express } from 'express';
import type { Pool } from 'pg';
import type express from 'express';
import bcrypt from 'bcrypt';
import { consumeLimit, sendRateLimit } from '../rate-limit';
import { text } from '../requests/validation';

export function registerAuthRoutes(app: Express, pool: Pool) {
  type LoginInput = {
    email?: unknown;
    password?: unknown;
  };

  function validateCredentials(body: LoginInput) {
    const email = text(body.email).toLowerCase();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new Error('Enter a valid email address.');
    }
    if (password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('Password must be between 8 and 72 characters.');
    }

    return { email, password };
  }

  function establishSession(
    request: express.Request,
    user: { id: string; email: string },
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      request.session.regenerate((error) => {
        if (error) {
          reject(error);
          return;
        }

        request.session.userId = user.id;
        request.session.email = user.email;
        request.session.save((saveError) => saveError ? reject(saveError) : resolve());
      });
    });
  }

  app.post('/api/auth/register', async (request, response) => {
    const retryAfter = await consumeLimit(pool, 'signup-ip', request.ip ?? 'unknown', 10, 3600);
    if (retryAfter) return sendRateLimit(response, retryAfter);
    let credentials: ReturnType<typeof validateCredentials>;

    try {
      credentials = validateCredentials(request.body as LoginInput);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid account details.' });
      return;
    }

    const passwordHash = await bcrypt.hash(credentials.password, 12);

    try {
      const result = await pool.query<{ id: string; email: string }>(
        `INSERT INTO users (email, password_hash)
         VALUES ($1, $2)
         ON CONFLICT (LOWER(email)) DO UPDATE
           SET password_hash = EXCLUDED.password_hash
           WHERE users.password_hash = 'AUTHENTICATION_PENDING'
         RETURNING id, email`,
        [credentials.email, passwordHash],
      );

      if (result.rowCount !== 1) {
        response.status(409).json({ error: 'An account already exists for this email.' });
        return;
      }

      await establishSession(request, result.rows[0]);
      response.status(201).json({ user: { email: result.rows[0].email } });
    } catch {
      console.error('account_creation_failed');
      response.status(500).json({ error: 'Could not create your account. Please try again.' });
    }
  });

  app.post('/api/auth/login', async (request, response) => {
    const ipRetryAfter = await consumeLimit(pool, 'login-ip', request.ip ?? 'unknown', 30, 900);
    if (ipRetryAfter) return sendRateLimit(response, ipRetryAfter);
    let credentials: ReturnType<typeof validateCredentials>;

    try {
      credentials = validateCredentials(request.body as LoginInput);
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : 'Invalid login details.' });
      return;
    }

    const emailRetryAfter = await consumeLimit(pool, 'login-email', credentials.email.toLowerCase(), 10, 900);
    if (emailRetryAfter) return sendRateLimit(response, emailRetryAfter);

    const result = await pool.query<{ id: string; email: string; password_hash: string }>(
      'SELECT id, email, password_hash FROM users WHERE LOWER(email) = LOWER($1)',
      [credentials.email],
    );
    const user = result.rows[0];
    const passwordMatches = user
      && user.password_hash !== 'AUTHENTICATION_PENDING'
      && await bcrypt.compare(credentials.password, user.password_hash);

    if (!user || !passwordMatches) {
      response.status(401).json({ error: 'Email or password is incorrect.' });
      return;
    }

    await establishSession(request, user);
    response.json({ user: { email: user.email } });
  });

  app.get('/api/auth/me', async (request, response) => {
    if (!request.session.userId || !request.session.email) {
      response.status(401).json({ error: 'Sign in to continue.' });
      return;
    }

    const result = await pool.query(
      `SELECT email, contact_name, contact_phone, service_address
       FROM users
       WHERE id = $1`,
      [request.session.userId],
    );

    if (result.rowCount !== 1) {
      response.status(401).json({ error: 'Sign in to continue.' });
      return;
    }

    response.json({
      user: {
        email: result.rows[0].email,
        contactName: result.rows[0].contact_name,
        contactPhone: result.rows[0].contact_phone,
        serviceAddress: result.rows[0].service_address,
      },
    });
  });

  app.post('/api/auth/logout', (request, response) => {
    request.session.destroy((error) => {
      if (error) {
        response.status(500).json({ error: 'Could not sign out. Please try again.' });
        return;
      }

      response.clearCookie('helpfully.sid');
      response.status(204).end();
    });
  });
}
