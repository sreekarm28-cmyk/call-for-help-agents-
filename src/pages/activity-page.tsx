import { useEffect, useState } from 'react';
import { ProviderShortlist } from '../provider-shortlist';
import { ProviderOffers } from '../provider-offers';

type RequestEvent = {
  id: number;
  eventType: string;
  status: string;
  actor: string;
  startedAt: string;
  durationMs: number | string | null;
  message: string;
};

type ServiceRequestSummary = {
  id: number;
  service_type: string;
  custom_service: string | null;
  description: string;
  preferred_date: string;
  preferred_time_window: string;
  booking_permission: string;
  max_visit_fee: string | null;
  created_at: string;
  events: RequestEvent[];
};

function formatDuration(durationMs: number | string | null) {
  const duration = Number(durationMs ?? 0);
  if (duration < 1000) return '<1 sec';
  if (duration < 60_000) return `${Math.round(duration / 1000)} sec`;
  return `${Math.floor(duration / 60_000)} min ${Math.round((duration % 60_000) / 1000)} sec`;
}

function formatLabel(value: string) {
  return value.replaceAll('_', ' ');
}

function PersonalActivity({ requests }: { requests: ServiceRequestSummary[] }) {
  return (
    <section className="activity-card" aria-labelledby="activity-title">
      <div className="card-heading">
        <div>
          <h2 id="activity-title">Your activity</h2>
          <p>Track each request and the time spent on every step.</p>
        </div>
        <span className="activity-count">{requests.length}</span>
      </div>

      {requests.length === 0 ? (
        <p className="empty-activity">Your saved requests will appear here.</p>
      ) : (
        <div className="request-list">
          {requests.map((request) => (
            <article className="request-log" key={request.id}>
              <div className="request-summary">
                <div>
                  <span className="request-label">REQUEST #{request.id}</span>
                  <h3>{request.service_type === 'other' ? request.custom_service : request.service_type}</h3>
                  <p>{request.description}</p>
                </div>
                <span className="status-pill">Saved</span>
              </div>
              <div className="request-meta">
                <span>Visit · {request.preferred_time_window}</span>
                <span>{request.preferred_date}</span>
              </div>
              <div className="timeline">
                {request.events.map((event) => (
                  <div className="timeline-event" key={event.id}>
                    <span className="timeline-dot" aria-hidden="true" />
                    <div className="timeline-content">
                      <div className="event-topline">
                        <strong>{event.message}</strong>
                        <span>{formatDuration(event.durationMs)}</span>
                      </div>
                      <p>{formatLabel(event.eventType)} · {event.actor}</p>
                    </div>
                  </div>
                ))}
              </div>
              {request.events.some((event) => event.eventType === 'provider_search' && event.status === 'completed') && (
                <>
                  <ProviderShortlist requestId={request.id} />
                  <ProviderOffers requestId={request.id} />
                </>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
export function ActivityPage({ email, onSignOut }: { email: string; onSignOut: () => Promise<void> }) {
  const [requests, setRequests] = useState<ServiceRequestSummary[]>([]);

  useEffect(() => {
    fetch('/api/me/requests')
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as { requests: ServiceRequestSummary[] };
        setRequests(result.requests);
      });
  }, []);

  return (
    <div className="app-shell">
      <header className="site-header">
        <a className="wordmark" href="/" aria-label="Helpfully home">
          <span className="brand-symbol">h<span>✳</span></span>
          helpfully<span className="brand-dot">.</span>
        </a>
        <nav className="user-nav" aria-label="Personal navigation">
          <a className="nav-link" href="/">New request</a>
          <a className="nav-link active" href="/activity">My activity</a>
          <button className="submit-button" type="button" onClick={() => void onSignOut()}>Sign out</button>
        </nav>
      </header>
      <main className="activity-page">
        <div className="activity-intro">
          <span className="eyebrow"><span aria-hidden="true">✳</span> PERSONAL ACTIVITY</span>
          <h1>Your requests,<br />all in one place.</h1>
          <p>See what happened and how long each step took.</p>
          <p className="demo-note">Signed in as {email}</p>
        </div>
        <PersonalActivity requests={requests} />
      </main>
    </div>
  );
}
