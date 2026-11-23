import { useState, type FormEvent } from 'react';
import type { UserProfile } from '../types/user';

export function AuthPage({ onAuthenticated }: { onAuthenticated: (user: UserProfile) => void }) {
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [authError, setAuthError] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setIsAuthenticating(true);
    setAuthError('');

    try {
      const response = await fetch(`/api/auth/${authMode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.get('email'),
          password: formData.get('password'),
        }),
      });
      const result = await response.json() as { user?: { email: string }; error?: string };

      if (!response.ok || !result.user) {
        throw new Error(result.error ?? 'Could not continue.');
      }

      const profileResponse = await fetch('/api/auth/me');
      const profileResult = await profileResponse.json() as { user: UserProfile };
      onAuthenticated(profileResult.user);
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : 'Could not continue.');
    } finally {
      setIsAuthenticating(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <span className="wordmark">helpfully.</span>
      </header>
      <main className="login-page">
        <section className="request-card" aria-labelledby="login-title">
          <h1 id="login-title">{authMode === 'login' ? 'Sign in' : 'Create account'}</h1>
          <p className="login-instructions">
            {authMode === 'login'
              ? 'Enter your email and password to continue.'
              : 'Create one account for your email to save service requests.'}
          </p>
          <form onSubmit={authenticate}>
            <label className="field">
              Email address
              <input name="email" type="email" placeholder="you@example.com" required />
            </label>
            <label className="field">
              Password
              <input
                name="password"
                type="password"
                placeholder="At least 8 characters"
                autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                minLength={8}
                maxLength={72}
                required
              />
            </label>
            <button className="submit-button" type="submit" disabled={isAuthenticating}>
              {isAuthenticating
                ? 'Please wait…'
                : authMode === 'login' ? 'Sign in' : 'Create account'}
            </button>
            {authError && <div className="error-message" role="alert">{authError}</div>}
          </form>
          <button
            className="auth-switch"
            type="button"
            onClick={() => {
              setAuthMode(authMode === 'login' ? 'register' : 'login');
              setAuthError('');
            }}
          >
            {authMode === 'login' ? 'Create a new account' : 'I already have an account'}
          </button>
        </section>
      </main>
    </div>
  );
}
