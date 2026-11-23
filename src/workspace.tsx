import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ProviderOffers } from './provider-offers';
import { BookingChoices } from './booking-choices';
import { confirmationLabel } from './confirmation-status';

const tabs = ['Current bookings', 'Booking history', 'Providers found'] as const;
type Booking = {
  id: string; status: string; visitAt: string; visitFee: string;
  primaryPlaceId: string; backupPlaceId: string | null;
  confirmationDecision?: string | null; confirmationCallStatus?: string;
  confirmationExtractionStatus?: string | null; confirmationAttemptCount?: number; confirmationAttemptLimit?: number;
};
type Request = {
  id: number;
  description: string;
  preferredVisitDate: string;
  providersHidden: boolean;
  currentBookingHidden: boolean;
  canHideProviders: boolean;
  events: { eventType: string; status: string }[];
  bookings: Booking[];
  preferences?: { primaryPlaceId: string; backupPlaceId: string | null } | null;
  providerSearch: { status: string; providerCount: number | null; errorCode: string | null } | null;
  callDetailsStatus: 'pending' | 'calling' | 'completed' | 'failed' | null;
  callWorkRemaining: boolean;
};
const searchPending = (request: Request) =>
  request.providerSearch?.status === 'pending' || request.providerSearch?.status === 'running';

function providerSearchMessage(request: Request) {
  const search = request.providerSearch;
  if (searchPending(request)) return 'Looking for nearby providers…';
  if (search?.status === 'failed') {
    return search.errorCode === 'address_unresolved'
      ? 'We could not locate the service address.'
      : 'The provider search failed.';
  }
  if (search?.providerCount === 0) return 'No matching providers found.';
  if (search?.providerCount) return `${search.providerCount} providers found.`;
  return null;
}
type Provider = { name: string | null; area: string | null; rating: number | null; ratingCount: number | null; phone: string | null };
const date = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' });
const visitDay = new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeZone: 'UTC' });
const active = (booking: Booking) => ['confirmed', 'awaiting_provider_confirmation'].includes(booking.status);
const statuses: Record<string, string> = {
  confirmed: 'Confirmed', awaiting_provider_confirmation: 'Awaiting provider confirmation',
  cancelled: 'Cancelled', no_show: 'No-show', completed: 'Completed',
};

function Icon({ kind }: { kind: 'dashboard' | 'booking' | 'sidebar' }) {
  const paths = {
    dashboard: 'M3 3h7v7H3zm11 0h7v7h-7zM3 14h7v7H3zm11 0h7v7h-7z',
    booking: 'M4 6h16v15H4zm0 5h16M8 3v6m8-6v6',
    sidebar: 'M3 4h18v16H3zm6 0v16',
  };
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]} /></svg>;
}

function RequestProviders({ requestId, description, providerCount }: {
  requestId: number; description: string; providerCount: number | null;
}) {
  const [providers, setProviders] = useState<(Provider | null)[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const activeLoad = useRef<AbortController | null>(null);

  useEffect(() => {
    if (dialog.current?.open) void load();
    return () => activeLoad.current?.abort();
  }, [requestId, providerCount]);

  async function load() {
    activeLoad.current?.abort();
    const controller = new AbortController();
    activeLoad.current = controller;
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/me/requests/' + requestId + '/providers?contact=true', { signal: controller.signal });
      const data = await response.json() as { providers?: (Provider | null)[]; error?: string };
      if (!response.ok || !data.providers) throw new Error(data.error || 'Could not load providers.');
      if (!controller.signal.aborted) setProviders(data.providers);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load providers.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }

  return <>
    <button className="workspace-show-providers" type="button" aria-haspopup="dialog" onClick={() => {
      dialog.current?.showModal();
      void load();
    }}>View providers <span aria-hidden="true">↗</span></button>
    <dialog className="workspace-provider-dialog" ref={dialog} aria-labelledby={titleId}>
      <div className="workspace-provider-dialog-header">
        <div><h2 id={titleId}>Providers found</h2><p>{description}</p></div>
        <button type="button" autoFocus aria-label="Close providers" onClick={() => dialog.current?.close()}>×</button>
      </div>
      {loading && <p role="status">Loading providers…</p>}
      {error && <div><p role="alert">{error}</p><button type="button" onClick={() => void load()}>Try again</button></div>}
      {providers?.length === 0 && <p>No providers available for this request. The shortlist may have expired.</p>}
      {!!providers?.length && <ul className="workspace-provider-list">
        {providers.map((provider, index) => {
          const number = provider?.phone?.replace(/[() .-]/g, '');
          return <li key={index}>
            <h3>{provider?.name ?? 'Business name unavailable'}</h3>
            {provider?.area && <p>{provider.area}</p>}
            {provider?.rating != null ? <p className="workspace-provider-rating">
              <span aria-hidden="true">★</span> {provider.rating}/5{provider.ratingCount != null && ` · ${provider.ratingCount} reviews`}
            </p> : <p>Rating unavailable</p>}
            <div className="workspace-provider-dialog-contact">
              {number && /^\+?\d{7,15}$/.test(number)
                ? <a href={'tel:' + number}>Call myself <span>{provider?.phone}</span></a>
                : <p>Phone number unavailable.</p>}
            </div>
          </li>;
        })}
      </ul>}
      {providers?.some(Boolean) && <small className="workspace-provider-source provider-attribution" translate="no">Google Maps</small>}
    </dialog>
  </>;
}

function DeleteRequestCard({ request, section, onDelete }: {
  request: Request; section: 'providers' | 'current-booking'; onDelete: (id: number) => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function deleteCard() {
    setDeleting(true);
    setError('');
    try {
      const response = await fetch(`/api/me/requests/${request.id}/${section}`, { method: 'DELETE' });
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(result?.error ?? 'Could not delete this card. Try again.');
      }
      onDelete(request.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not delete this card. Try again.');
    } finally {
      setDeleting(false);
    }
  }

  return <div className="workspace-card-delete">
    <button className="workspace-delete-provider-card" type="button"
      aria-label={deleting ? 'Deleting request card' : 'Delete card for ' + request.description}
      disabled={deleting} onClick={() => void deleteCard()}>{deleting ? 'Deleting…' : 'Delete'}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

function ProviderRequestCard({ request, hasProviders, onDelete }: {
  request: Request; hasProviders: boolean; onDelete: (id: number) => void;
}) {
  const titleId = useId();
  const status = providerSearchMessage(request);

  return <article className="workspace-provider-card" aria-labelledby={titleId}>
    <header className="workspace-provider-card-header">
      <span className="workspace-provider-card-icon" aria-hidden="true"><Icon kind="booking" /></span>
      <div>
        <h2 id={titleId}>{request.description}</h2>
        <p>Requested visit <time dateTime={request.preferredVisitDate}>
          {visitDay.format(new Date(request.preferredVisitDate + 'T00:00:00Z'))}
        </time></p>
      </div>
      {request.canHideProviders && <DeleteRequestCard request={request} section="providers" onDelete={onDelete} />}
    </header>
    {status && <p className="workspace-provider-card-status" role="status" data-status={request.providerSearch?.status}>{status}</p>}
    {hasProviders && <div className="workspace-card-action">
      <RequestProviders requestId={request.id} description={request.description}
        providerCount={request.providerSearch?.providerCount ?? null} />
    </div>}
  </article>;
}

export function Workspace({ email, onSignOut, children }: {
  email: string; onSignOut: () => Promise<void>; children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(() => window.matchMedia('(max-width: 620px)').matches);
  const [screen, setScreen] = useState<'dashboard' | 'booking'>('dashboard');
  const [tab, setTab] = useState<typeof tabs[number]>('Current bookings');
  const [requests, setRequests] = useState<Request[] | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (screen !== 'dashboard') return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    setError('');
    async function loadRequests() {
      let checkAgain = false;
      try {
        const response = await fetch('/api/me/requests', { signal: controller.signal });
        if (response.status === 401) {
          if (!controller.signal.aborted) setError('Sign in again to view your requests.');
          return;
        }
        if (!response.ok) throw new Error('Could not load your dashboard.');
        const data = await response.json() as { requests: Request[] };
        if (controller.signal.aborted) return;
        setRequests(data.requests);
        setError('');
        checkAgain = data.requests.some(searchPending) ||
          (tab === 'Current bookings' && data.requests.some((request) => !request.currentBookingHidden &&
            (request.callDetailsStatus === 'pending' || request.callWorkRemaining)));
      } catch {
        if (controller.signal.aborted) return;
        setError('Could not load your dashboard. Retrying…');
        checkAgain = true;
      }
      if (checkAgain) timer = setTimeout(() => void loadRequests(), 2_000);
    }
    void loadRequests();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [screen, tab, refresh]);

  const searched = requests?.filter(({ events }) => events.some(
    (event) => event.eventType === 'provider_search' && (event.status === 'completed' || event.status === 'running'),
  )) ?? [];
  const providerRequests = requests?.filter((request) => request.providerSearch || searched.includes(request)) ?? [];
  const visibleProviderRequests = providerRequests.filter((request) => !request.providersHidden);
  const currentRequests = requests?.filter((request) => !request.currentBookingHidden &&
    (request.bookings.some(active) || providerRequests.includes(request))) ?? [];
  const bookings = requests?.flatMap((request) => request.bookings
    .filter((booking) => tab !== 'Current bookings' && !active(booking))
    .map((booking) => ({ booking, description: request.description })))
    .sort((a, b) => Date.parse(b.booking.visitAt) - Date.parse(a.booking.visitAt)) ?? [];

  return <div className={'workspace' + (collapsed ? ' workspace-collapsed' : '')}>
    <header className="workspace-header">
      <span className="workspace-avatar" aria-hidden="true">{email.charAt(0).toUpperCase()}</span>
      <span className="workspace-preview">{email}</span>
      <button type="button" onClick={() => void onSignOut()}>Sign out</button>
    </header>
    <aside className="workspace-sidebar">
      <div className="workspace-brand">
        <span className="workspace-mark" aria-hidden="true">✳</span>
        <span className="workspace-wordmark">Helpfully</span>
        <button className="workspace-toggle" type="button" aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed} aria-controls="workspace-nav" onClick={() => setCollapsed(!collapsed)}><Icon kind="sidebar" /></button>
      </div>
      <nav className="workspace-nav" id="workspace-nav" aria-label="Main navigation">
        {(['dashboard', 'booking'] as const).map((item) => {
          const label = item === 'dashboard' ? 'Dashboard' : 'Service booking';
          return <button key={item} type="button" title={label} aria-label={label}
            aria-current={screen === item ? 'page' : undefined} onClick={() => {
              setScreen(item);
              if (window.matchMedia('(max-width: 620px)').matches) setCollapsed(true);
            }}><Icon kind={item} /><span>{label}</span></button>;
        })}
      </nav>
    </aside>
    <main className={screen === 'booking' ? 'workspace-content workspace-booking' : 'workspace-content'}>
      <h1 className={screen === 'dashboard' ? 'workspace-sr-only' : undefined}>
        {screen === 'dashboard' ? tab : 'Service booking'}
      </h1>
      <div hidden={screen !== 'booking'}>{children}</div>
      {screen === 'dashboard' && <>
        <nav className="workspace-tabs" aria-label="Dashboard sections">
          {tabs.map((item) => <button type="button" key={item} aria-pressed={item === tab}
            onClick={() => setTab(item)}>{item}</button>)}
        </nav>
        <section className={requests && !error && (
          (tab === 'Providers found' && visibleProviderRequests.length) || (tab === 'Current bookings' && currentRequests.length))
          ? (tab === 'Current bookings' ? 'workspace-provider-grid workspace-booking-grid' : 'workspace-provider-grid') : 'workspace-panel'} aria-label={tab}>
          {error ? <><p role="alert">{error}</p><button type="button" onClick={() => setRefresh(refresh + 1)}>Try again</button></>
            : requests === null ? <p role="status">Loading your dashboard…</p>
            : tab === 'Providers found' ? visibleProviderRequests.length ? visibleProviderRequests.map((request) =>
              <ProviderRequestCard key={request.id} request={request}
                hasProviders={searched.includes(request) && request.providerSearch?.providerCount !== 0}
                onDelete={(id) => {
                  setRequests((current) => current?.map((item) => item.id === id ? { ...item, providersHidden: true } : item) ?? null);
                  setRefresh((value) => value + 1);
                }} />) : <p>No provider searches to show.</p>
            : tab === 'Current bookings' && currentRequests.length ? currentRequests.map((request) => {
              const booking = request.bookings.find(active);
              return <article className="workspace-provider-card workspace-booking-card" key={request.id}>
                <header className="workspace-provider-card-header">
                  <span className="workspace-provider-card-icon" aria-hidden="true"><Icon kind="booking" /></span>
                  <div>
                    <span className="workspace-booking-eyebrow">Service request</span>
                    <h2 title={request.description}>{request.description}</h2>
                  </div>
                  {request.canHideProviders && <DeleteRequestCard request={request} section="current-booking" onDelete={(id) => {
                    setRequests((current) => current?.map((item) => item.id === id ? { ...item, currentBookingHidden: true } : item) ?? null);
                    setRefresh((value) => value + 1);
                  }} />}
                </header>
                <p className="workspace-provider-card-status workspace-booking-status" role="status" data-status={booking?.status ?? request.callDetailsStatus ?? request.providerSearch?.status}>
                  {booking ? confirmationLabel(booking.status, { status: booking.confirmationCallStatus,
                    decision: booking.confirmationDecision, extractionStatus: booking.confirmationExtractionStatus,
                    attemptCount: booking.confirmationAttemptCount, attemptLimit: booking.confirmationAttemptLimit }) :
                    request.preferences ? 'Choices saved — clarification needed' :
                    request.callDetailsStatus === 'pending' ? 'Pending · Reviewing call details' :
                    request.callDetailsStatus === 'calling' ? 'Calling a provider' :
                    request.callDetailsStatus === 'completed' ? 'Call details ready' :
                    request.callDetailsStatus === 'failed' ? 'Could not review the call' : providerSearchMessage(request)}
                </p>
                <div className="workspace-booking-meta">
                  <div><span>{booking ? 'Scheduled visit' : 'Requested visit'}</span>
                    <strong>{booking ? date.format(new Date(booking.visitAt))
                      : visitDay.format(new Date(request.preferredVisitDate + 'T00:00:00Z'))}</strong></div>
                  <div><span>Visit fee</span><strong>{booking ? '₹' + Number(booking.visitFee).toLocaleString('en-IN') : 'See call details'}</strong></div>
                </div>
                {booking ? <BookingChoices requestId={request.id} booking={booking} /> : request.preferences ?
                  <BookingChoices requestId={request.id} booking={{ id: `preferences-${request.id}`,status: 'preference',...request.preferences }} /> :
                  <div className="workspace-booking-choices workspace-booking-choices-empty">
                    <dl>
                      <div><dt>First choice</dt><dd><span>No provider selected</span><small>Review offers to choose your provider.</small></dd></div>
                      <div><dt>Backup <span>Optional</span></dt><dd><span>No backup selected</span><small>Choose a different eligible provider.</small></dd></div>
                    </dl>
                  </div>}
                {(booking || request.callDetailsStatus != null || searched.includes(request) && request.providerSearch?.providerCount !== 0) &&
                  <div className="workspace-card-action">
                    {searched.includes(request) && request.providerSearch?.providerCount !== 0 &&
                      <RequestProviders requestId={request.id} description={request.description}
                        providerCount={request.providerSearch?.providerCount ?? null} />}
                    {(booking || request.callDetailsStatus != null) &&
                      <ProviderOffers requestId={request.id} description={request.description} onSelection={() => setRefresh((value) => value + 1)} />}
                  </div>}
              </article>;
            }) : <>
              {!bookings.length && <div className="workspace-empty">
                <span className="workspace-empty-icon"><Icon kind="booking" /></span>
                <h2>{tab === 'Current bookings' ? 'No current bookings' : 'No booking history yet'}</h2>
                {tab === 'Current bookings' && <button className="workspace-primary" type="button"
                  onClick={() => { setScreen('booking'); if (window.matchMedia('(max-width: 620px)').matches) setCollapsed(true); }}>
                  Book a service <span aria-hidden="true">↗</span>
                </button>}
              </div>}
              {bookings.map(({ booking, description }) => <div className="workspace-row" key={booking.id}>
                <div><h2>{description}</h2><p>{date.format(new Date(booking.visitAt))} · ₹{booking.visitFee} visit fee</p></div>
                <span className="workspace-badge">{statuses[booking.status] ?? booking.status}</span>
              </div>)}
            </>}
        </section>
      </>}
    </main>
  </div>;
}
