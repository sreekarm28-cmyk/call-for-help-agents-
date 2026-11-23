import { useEffect, useState } from 'react';
import type { UserProfile } from './types/user';
import { Workspace } from './workspace';
import { ServiceBookingForm } from './components/service-booking-form';
import { AuthPage } from './pages/auth-page';
import { ActivityPage } from './pages/activity-page';

export function App() {
  const [user, setUser] = useState<UserProfile | null>(null);
  const path = window.location.pathname.replace(/\/$/, '');
  const [isCheckingSession, setIsCheckingSession] = useState(true);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { user: UserProfile };
        setUser(result.user);
      })
      .finally(() => setIsCheckingSession(false));
  }, []);

  async function signOut() {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    if (response.ok) {
      setUser(null);
    }
  }

  if (user) {
    return path === '/activity' ? <ActivityPage email={user.email} onSignOut={signOut} />
      : <Workspace email={user.email} onSignOut={signOut}>
          <ServiceBookingForm savedDetails={user} onSignOut={signOut} embedded
            onProfileSaved={(profile) => setUser(profile)} />
        </Workspace>;
  }
  if (isCheckingSession) return <div className="session-loading">Loading…</div>;
  return <AuthPage onAuthenticated={setUser} />;
}
