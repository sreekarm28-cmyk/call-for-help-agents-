import { useEffect, useState } from 'react';

type Choice = { placeId: string; name?: string | null; area?: string | null };
type Choices = { bookingId: string; primary: Choice; backup: Choice | null };

function mapsLink(choice: Choice) {
  return 'https://www.google.com/maps/search/?' + new URLSearchParams({
    api: '1', query: choice.name || choice.placeId, query_place_id: choice.placeId,
  });
}

export function BookingChoices({ requestId, booking }: {
  requestId: number;
  booking: { id: string; status: string; primaryPlaceId: string; backupPlaceId: string | null };
}) {
  const [choices, setChoices] = useState<Choices | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const response = await fetch(`/api/me/requests/${requestId}/booking-choices`, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load choices.');
        const result: Choices = await response.json();
        if (!controller.signal.aborted && result.bookingId === booking.id) setChoices(result);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
    // Fetch names when the selection changes, not on every dashboard poll.
  }, [requestId, booking.id, booking.primaryPlaceId, booking.backupPlaceId, refresh]);

  const current = choices?.bookingId === booking.id ? choices : null;
  const primary = current?.primary ?? { placeId: booking.primaryPlaceId };
  const backup = current?.backup ?? (booking.backupPlaceId ? { placeId: booking.backupPlaceId } : null);
  function provider(choice: Choice) {
    return <>
      <a href={mapsLink(choice)} target="_blank" rel="noreferrer">
        {choice.name || (loading ? 'Loading provider…' : 'View selected provider')} <span aria-hidden="true">↗</span>
      </a>
      {choice.area && <small>{choice.area}</small>}
    </>;
  }
  return <div className="workspace-booking-choices">
    <dl>
      <div>
        <dt>First choice</dt>
        <dd>{provider(primary)}</dd>
      </div>
      <div>
        <dt>Backup {backup && <span>Standby</span>}</dt>
        <dd>{backup ? provider(backup) : <span>No backup selected</span>}</dd>
      </div>
    </dl>
    {error && <button type="button" className="workspace-choice-retry" onClick={() => setRefresh((value) => value + 1)}>Retry loading names</button>}
    {(primary.name || backup?.name) && <small className="provider-attribution" translate="no">Google Maps</small>}
  </div>;
}
