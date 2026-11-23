import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { UserProfile } from '../types/user';
import { ProviderShortlist } from '../provider-shortlist';
import { ProviderOffers } from '../provider-offers';

const services = [
  { name: 'Plumber', icon: '↳' },
  { name: 'Electrician', icon: 'ϟ' },
  { name: 'Other', icon: '+' },
];

const commonIssues: Record<string, string[]> = {
  Plumber: ['Leaking tap', 'Blocked drain', 'Low water pressure'],
  Electrician: ['Socket stopped working', 'Light keeps flickering', 'Breaker keeps tripping'],
  Other: ['Installation needed', 'Repair needed', 'Maintenance visit'],
};

function localDate(offset: number) {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

export function ServiceBookingForm({
  savedDetails,
  onSignOut,
  embedded = false,
  onProfileSaved,
}: {
  savedDetails: UserProfile;
  onSignOut: () => Promise<void>;
  embedded?: boolean;
  onProfileSaved?: (profile: UserProfile) => void;
}) {
  const savedAddress = savedDetails.serviceAddress ?? '';
  const savedAddressLines = savedAddress.split('\n');
  const hasDoorAddress = savedAddressLines.length === 4 && /^[1-9]\d{5}$/.test(savedAddressLines[3]);
  const hasStructuredAddress = savedAddressLines.length === 3 && /^[1-9]\d{5}$/.test(savedAddressLines[2]);
  const savedAreaCity = hasDoorAddress ? savedAddressLines[2] : hasStructuredAddress ? savedAddressLines[1] : '';
  const savedPinCode = hasDoorAddress ? savedAddressLines[3] : hasStructuredAddress ? savedAddressLines[2] : '';
  const [service, setService] = useState('Plumber');
  const [bookingMode, setBookingMode] = useState('approval');
  const [description, setDescription] = useState('');
  const [visitDate, setVisitDate] = useState('');
  const [feeChoice, setFeeChoice] = useState('');
  const [requestId, setRequestId] = useState<number | null>(null);
  const [searchMessage, setSearchMessage] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [shortlistedRequestId, setShortlistedRequestId] = useState<number | null>(null);
  const [editedDetails, setEditedDetails] = useState<Record<string, string>>({});
  const savedFields: Record<string, string> = {
    name: savedDetails.contactName ?? '', phone: savedDetails.contactPhone ?? '',
    addressDoor: hasDoorAddress ? savedAddressLines[0] : '',
    addressStreet: hasDoorAddress ? savedAddressLines[1] : '',
    addressAreaCity: savedAreaCity, addressPinCode: savedPinCode,
  };
  const showRememberDetails = !hasDoorAddress || !savedFields.name || !savedFields.phone
    || Object.entries(editedDetails).some(([name, value]) => value.trim() !== savedFields[name]?.trim());
  const submissionInFlight = useRef(false);
  const pendingSubmission = useRef<{ body: string; id: string } | null>(null);

  useEffect(() => {
    if (requestId === null) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function checkSearch() {
      try {
        const response = await fetch(`/api/me/requests/${requestId}/provider-search`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error('Could not check provider search.');
        const search = await response.json() as {
          status: 'pending' | 'running' | 'completed' | 'failed';
          providerCount: number | null;
          shortfall: number | null;
          ratingFallbackUsed: boolean | null;
          errorCode: string | null;
        };
        if (controller.signal.aborted) return;
        if (search.status === 'completed') {
          const count = search.providerCount ?? 0;
          if (count === 0) {
            setSearchMessage('No matching providers were found.');
          } else {
            setShortlistedRequestId(requestId);
            const target = search.shortfall ? ` out of ${count + search.shortfall}` : '';
            const fallback = search.ratingFallbackUsed ? ' The search used a lower rating requirement.' : '';
            setSearchMessage(`Shortlisted ${count}${target} ${count === 1 ? 'provider' : 'providers'}.${fallback}`);
          }
        } else if (search.status === 'failed') {
          setSearchMessage(search.errorCode === 'address_unresolved'
            ? 'We could not locate the service address. Check the street, city, and postal code.'
            : 'The provider search failed.');
        } else {
          setSearchMessage('Looking for providers near your service address…');
          timer = setTimeout(() => void checkSearch(), 2_000);
        }
      } catch {
        if (!controller.signal.aborted) {
          setSearchMessage('Could not check the provider search status.');
        }
      }
    }
    void checkSearch();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [requestId]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submissionInFlight.current) return;
    const fields = event.currentTarget.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      'input, select, textarea',
    );
    for (const field of fields) {
      if (!field.reportValidity()) return;
    }
    const formData = new FormData(event.currentTarget);
    const budget = String(formData.get('budget') ?? '').trim();

    const body = JSON.stringify({
      serviceType: service.toLowerCase(),
      customService: service === 'Other' ? formData.get('customService') : null,
      description: formData.get('description'),
      contactName: formData.get('name'),
      contactPhone: formData.get('phone'),
      addressDoor: formData.get('addressDoor'),
      addressStreet: formData.get('addressStreet'),
      addressAreaCity: formData.get('addressAreaCity'),
      addressPinCode: formData.get('addressPinCode'),
      preferredDate: formData.get('date'),
      preferredTimeWindow: formData.get('time'),
      maxVisitFee: budget ? Number(budget) : null,
      shareName: formData.has('shareName'),
      sharePhone: formData.has('sharePhone'),
      shareAddress: formData.has('shareAddress'),
      bookingPermission: bookingMode,
      rememberDetails: formData.has('rememberDetails'),
    });
    if (pendingSubmission.current?.body !== body) {
      pendingSubmission.current = { body, id: crypto.randomUUID() };
    }
    submissionInFlight.current = true;
    setIsSaving(true);
    setSubmitError('');
    setRequestId(null);

    try {
      const response = await fetch('/api/service-requests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pendingSubmission.current.id },
        body,
      });

      const result = await response.json() as { requestId?: number; error?: string };

      if (!response.ok || result.requestId === undefined) {
        throw new Error(result.error ?? 'Could not save your request.');
      }

      pendingSubmission.current = null;
      if (formData.has('rememberDetails') && onProfileSaved) {
        void fetch('/api/auth/me').then(async (profileResponse) => {
          if (profileResponse.ok) onProfileSaved((await profileResponse.json() as { user: UserProfile }).user);
        }).catch(() => {});
      }
      setSearchMessage('Looking for providers near your service address…');
      setRequestId(result.requestId);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Could not save your request.');
    } finally {
      submissionInFlight.current = false;
      setIsSaving(false);
    }
  }

  return (
    <div className={embedded ? 'workspace-booking-form' : 'app-shell request-shell'}>
      {!embedded && <header className="site-header compact-header">
        <a className="wordmark" href="./" aria-label="Helpfully home">
          <span className="brand-symbol" aria-hidden="true">h<span>✳</span></span>
          helpfully<span className="brand-dot">.</span>
        </a>
        <nav className="user-nav" aria-label="Personal navigation">
          <a className="nav-link" href="/activity">My activity</a>
          <button className="submit-button" type="button" onClick={() => void onSignOut()}>Sign out</button>
        </nav>
      </header>}

      <div className="request-page">
        <section className="request-card" aria-label={embedded ? 'Service request form' : undefined}
          aria-labelledby={embedded ? undefined : 'form-title'}>
          {!embedded && <h1 id="form-title" className="request-title">New service request</h1>}

          <form noValidate onSubmit={handleSubmit} onChange={(event) => {
            setRequestId(null);
            setSubmitError('');
            const field = event.target;
            if (field instanceof HTMLInputElement && Object.hasOwn(savedFields, field.name)) {
              setEditedDetails((previous) => ({ ...previous, [field.name]: field.value }));
            }
          }}>
            <div className="workspace-form">
            <fieldset>
            <legend>Service and visit</legend>
            <label>Service
              <select name="service" value={service} onChange={(event) => {
                if (commonIssues[service].includes(description)) setDescription('');
                setService(event.target.value);
              }}>
                {services.map(({ name }) => <option key={name}>{name}</option>)}
              </select>
            </label>

            <label htmlFor={service === 'Other' ? 'custom-service' : 'problem'}>
              {service === 'Other' ? 'Service needed' : 'What needs fixing?'}
            </label>
            <div className="quick-choices problem-options">
              {service === 'Other' ? (
                <>
                  <input id="custom-service" name="customService" list="other-services" placeholder="Choose or type a service" required maxLength={100} />
                  <datalist id="other-services"><option value="AC repair" /><option value="Carpentry" /><option value="Appliance repair" /></datalist>
                </>
              ) : commonIssues[service].map(issue => <button key={issue} type="button" aria-pressed={description === issue}
                onClick={() => { setDescription(issue); setRequestId(null); setSubmitError(''); }}>{issue}</button>)}
            </div>
            <label className="field">
              <textarea id="problem" name="description" aria-label="Problem description" value={description} onChange={event => setDescription(event.target.value)} placeholder={service === 'Other' ? 'Describe what you need help with' : 'Choose a problem above or describe your own'} required maxLength={2000} rows={2} />
            </label>

            <div className="workspace-fields">
              <label>Visit date
                <input name="date" type="date" value={visitDate} onChange={event => setVisitDate(event.target.value)} min={localDate(0)} required />
              </label>
              <label>Visit time
                <select name="time" required defaultValue="">
                  <option value="" disabled>Select a visit window</option>
                  <option value="morning">Morning · 9 am – 12 pm</option>
                  <option value="afternoon">Afternoon · 12 pm – 4 pm</option>
                  <option value="evening">Evening · 4 pm – 8 pm</option>
                  <option value="any">Any time</option>
                </select>
              </label>
            </div>
            <div className="workspace-booking-preferences">
              <label className="field budget-field">Maximum visit fee
                <div className="budget-controls">
                  <select name={feeChoice === 'custom' ? undefined : 'budget'} value={feeChoice} onChange={event => setFeeChoice(event.target.value)} required={bookingMode === 'automatic'}>
                    <option value="">{bookingMode === 'automatic' ? 'Choose a limit' : 'No limit specified'}</option>
                    {[250, 500, 750, 1000, 1500].map(amount => <option key={amount} value={amount}>₹{amount.toLocaleString('en-IN')}</option>)}
                    <option value="custom">Enter another amount…</option>
                  </select>
                  {feeChoice === 'custom' && <input aria-label="Custom visit fee limit in rupees" name="budget" type="number" inputMode="numeric" placeholder="Amount in ₹" min="1" step="1" max="1000000" required />}
                </div>
              </label>
              <label>Booking permission
                <select name="bookingPermission" value={bookingMode} onChange={event => setBookingMode(event.target.value)}>
                  <option value="approval">Ask me before confirming</option>
                  <option value="automatic">Book within my preferences</option>
                </select>
              </label>
            </div>
            </fieldset>
            <fieldset>
            <legend>Contact and address</legend>
            {!showRememberDetails && <p className="workspace-muted">Using your saved details</p>}
            <div className="workspace-fields">
              <label className="field">Your name<input name="name" autoComplete="name" defaultValue={savedDetails.contactName ?? ''} placeholder="Full name" required maxLength={100} /></label>
              <label className="field">Phone number<input name="phone" type="tel" autoComplete="tel" defaultValue={savedDetails.contactPhone ?? ''} placeholder="e.g. +91 98765 43210" required pattern="[+0-9() .-]{7,25}" title="Enter a phone number using 7–25 digits, spaces, or phone punctuation." /></label>
            </div>

            {savedAddress && !hasDoorAddress && (
              <p className="field-hint">Previously saved address: {savedAddress}</p>
            )}
            <label className="field">Door or flat and building
              <input name="addressDoor" placeholder="Flat 302, Lakshmi Apartments"
                defaultValue={hasDoorAddress ? savedAddressLines[0] : ''} required maxLength={150} />
            </label>
            <label className="field">Street or road
              <input name="addressStreet" placeholder="5th Main Road"
                defaultValue={hasDoorAddress ? savedAddressLines[1] : ''} required maxLength={200} />
            </label>
            <div className="address-grid">
              <label className="field">Area, city, and state if known
                <input name="addressAreaCity" autoComplete="address-level2" placeholder="Indiranagar, Bengaluru"
                  defaultValue={savedAreaCity} required maxLength={140} />
              </label>
              <label className="field">PIN code
                <input name="addressPinCode" autoComplete="postal-code" inputMode="numeric" placeholder="560038"
                  defaultValue={savedPinCode} required pattern="[1-9][0-9]{5}" maxLength={6}
                  title="Enter a six-digit PIN code." />
              </label>
            </div>

            {showRememberDetails && <label className="remember-details">
              <input type="checkbox" name="rememberDetails" />
              <span>
                <strong>Save my details for next time</strong>
                <small>Name, phone, and address</small>
              </span>
            </label>}

            <fieldset className="workspace-sharing">
              <legend>What can we share with the provider?</legend>
              <div className="share-options">
                <label className="workspace-check"><input type="checkbox" name="shareName" /> My name</label>
                <label className="workspace-check"><input type="checkbox" name="sharePhone" /> Phone number</label>
                <label className="workspace-check"><input type="checkbox" name="shareAddress" /> Service address</label>
              </div>
            </fieldset>
            </fieldset>
            </div>
            <div className="form-footer">
              <div className="request-actions">
              <button className="submit-button workspace-primary" type="submit" disabled={isSaving}>
                {isSaving ? 'Saving…' : 'Submit request'} <span aria-hidden="true">→</span>
              </button>
              </div>
            </div>
            {requestId !== null && <div className="success-message" role="status">Request #{requestId} saved. {searchMessage}</div>}
            {requestId !== null && requestId === shortlistedRequestId && (
              <div key={requestId}>
                <ProviderShortlist requestId={requestId} />
                <ProviderOffers requestId={requestId} />
              </div>
            )}
            {submitError && <div className="error-message" role="alert">{submitError}</div>}
          </form>
        </section>
      </div>
    </div>
  );
}
