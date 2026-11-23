import { useEffect, useState } from 'react';
import type { Offer, OfferList, Booking } from './types';

export function useProviderOffers(requestId: number, onSelection?: () => void) {
  const [result, setResult] = useState<OfferList | null>(null);
  const [loading, setLoading] = useState(false);
  const [selecting, setSelecting] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [recalling, setRecalling] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [primary, setPrimary] = useState<string | null | undefined>();
  const [backup, setBackup] = useState<string | null | undefined>();
  const url = `/api/me/requests/${requestId}/offers`;

  useEffect(() => {
    if (!refresh) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let loadedOffers = '';
    async function poll() {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error('Could not load offers.');
        let next: OfferList = await response.json();
        const ids = next.offers.map(({ callAttemptId }) => callAttemptId).join(',');
        if (ids && ids !== loadedOffers) {
          let details = await fetch(url + '?details=true', { signal: controller.signal });
          if (details.status === 429) details = await fetch(url + '?transcripts=true', { signal: controller.signal });
          if (details.ok) {
            next = await details.json() as OfferList;
            loadedOffers = next.offers.map(({ callAttemptId }) => callAttemptId).join(',');
          }
        }
        if (controller.signal.aborted) return;
        setError('');
        setResult((previous) => ({
          ...next,
          offers: next.offers.map((offer) => ({
            ...offer,
            provider: offer.provider ?? previous?.offers.find(({ callAttemptId }) => callAttemptId === offer.callAttemptId)?.provider ?? null,
            transcript: offer.transcript ?? previous?.offers.find(({ callAttemptId }) => callAttemptId === offer.callAttemptId)?.transcript ?? null,
          })),
        }));
        if (next.progress.inProgress || next.offers.some(({ extractionStatus }) => extractionStatus === 'pending')) {
          timer = setTimeout(() => void poll(), 4_000);
        }
      } catch {
        if (!controller.signal.aborted) {
          setError('Could not load offers. Retrying…');
          timer = setTimeout(() => void poll(), 4_000);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, refresh]);

  async function choose(offerId: string) {
    setSelecting(offerId);
    setError('');
    try {
      const response = await fetch(`${url}/${offerId}/select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupOfferId: backupOffer?.id ?? null }),
      });
      const selection = await response.json() as { booking?: Booking; error?: string };
      if (!response.ok || !selection.booking) throw new Error(selection.error ?? 'Could not choose this offer.');
      setResult((current) => current && { ...current, booking: selection.booking });
      onSelection?.();
      setRefresh((count) => count + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not choose this offer.');
    } finally {
      setSelecting(null);
    }
  }

  async function retryConfirmation() {
    const booking = result?.booking;
    if (retrying || !booking?.confirmation?.canRetry) return;
    setRetrying(true);
    setError('');
    try {
      const response = await fetch(`/api/me/requests/${requestId}/bookings/${booking.id}/retry-confirmation`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callAttemptId: booking.confirmation.callAttemptId }),
      });
      const next = await response.json() as { callAttemptId?: string; error?: string };
      if (!response.ok || !next.callAttemptId) throw new Error(next.error ?? 'Could not retry confirmation.');
      setResult((current) => current?.booking ? { ...current, booking: { ...current.booking,
        confirmation: { callAttemptId: next.callAttemptId!, status: 'queued', decision: null,
          extractionStatus: null, canRetry: false } } } : current);
      onSelection?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not retry confirmation.');
    } finally {
      setRetrying(false);
      setRefresh((count) => count + 1);
    }
  }

  async function saveChoices() {
    if (!primaryOffer) return;
    setSelecting(primaryOffer.id);
    setError('');
    try {
      const response = await fetch(`/api/me/requests/${requestId}/provider-choices`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ primaryCallId: primaryOffer.callAttemptId, backupCallId: backupOffer?.callAttemptId ?? null }),
      });
      const data = await response.json() as { preferences?: OfferList['preferences']; error?: string };
      if (!response.ok || !data.preferences) throw new Error(data.error ?? 'Could not save your choices.');
      setResult((current) => current && { ...current, preferences: data.preferences });
      setPrimary(undefined);
      setBackup(undefined);
      setNotice('Your choices are saved. The answer needs clarification; no booking has been confirmed. Use Call again when you want another conversation.');
      onSelection?.();
      setRefresh((count) => count + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save your choices.'); }
    finally { setSelecting(null); }
  }

  async function changeChoices() {
    const booking = result?.booking;
    if (!booking || selecting) return;
    setSelecting(booking.offerId);
    setError('');
    try {
      const response = await fetch(`/api/me/requests/${requestId}/bookings/${booking.id}/end`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'cancelled', findReplacement: false }),
      });
      if (!response.ok) throw new Error('Could not release the pending booking.');
      setResult((current) => current && { ...current, booking: undefined });
      setPrimary(undefined);
      setBackup(undefined);
      setNotice('The pending booking was cancelled. You can now choose a first choice and backup, and save your preferences.');
      onSelection?.();
      setRefresh((count) => count + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not change choices.'); }
    finally { setSelecting(null); }
  }

  async function callAgain(offer: Offer) {
    if (recalling || offer.recallBlockedReason) return;
    setRecalling(offer.callAttemptId);
    setError('');
    setNotice('');
    try {
      const response = await fetch(`/api/me/requests/${requestId}/calls/${offer.callAttemptId}/recall`, { method: 'POST' });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Could not queue another call.');
      setNotice(response.status === 201 ? 'Another call is queued for this provider. No booking has been made.'
        : 'A more recent call already exists for this provider. Refreshing its details.');
      onSelection?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not queue another call.');
    } finally {
      setRecalling(null);
      setRefresh((count) => count + 1);
    }
  }

  function loadOffers() {
    setError('');
    setNotice('');
    setLoading(true);
    setRefresh((count) => count + 1);
  }

  const primaryPlace = primary === undefined ? result?.preferences?.primaryPlaceId : primary;
  const backupPlace = backup === undefined ? result?.preferences?.backupPlaceId : backup;
  const primaryOffer = result?.offers.find((offer) => offer.placeId === primaryPlace);
  const backupOffer = result?.offers.find((offer) => offer.placeId === backupPlace);
  const readyToBook = !!primaryOffer?.selectable && (!backupOffer || backupOffer.selectable);
  const firstChoiceId = result?.booking ? result.booking.offerId : primaryOffer?.id;
  const backupChoiceId = result?.booking ? result.booking.backupOfferId : backupOffer?.id;
  function selectPrimary(placeId: string) {
    setPrimary(placeId);
    if (backupPlace === placeId) setBackup(null);
  }

  function toggleBackup(placeId: string) {
    setBackup(backupPlace === placeId ? null : placeId);
  }

  function clearChoices() {
    setPrimary(null);
    setBackup(null);
    setError('');
  }

  function closeOffers() {
    setRefresh(0);
    setPrimary(undefined);
    setBackup(undefined);
  }

  return {
    result, loading, selecting, retrying, recalling, notice, error,
    primaryPlace, backupPlace, primaryOffer, backupOffer, readyToBook, firstChoiceId, backupChoiceId,
    choose, retryConfirmation, saveChoices, changeChoices, callAgain, loadOffers,
    selectPrimary, toggleBackup, clearChoices, closeOffers,
  };
}
