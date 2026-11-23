import type { Offer } from './types';

const visitDate = new Intl.DateTimeFormat('en-IN', {
  dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata',
});
export const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' });

export function offerState(offer: Offer) {
  if (offer.callStatus === 'queued') return { icon: '↻', label: 'Call queued', note: 'Waiting to call this provider.' };
  if (offer.callStatus === 'calling') return { icon: '↻', label: 'Calling', note: 'A call to this provider is in progress.' };
  if (offer.extractionStatus === 'pending') return { icon: '◷', label: 'Reviewing call', note: 'The call details are being reviewed.' };
  if (offer.callStatus === 'rejected') return { icon: '!', label: 'Call rejected', note: 'The phone call was rejected. This does not tell us whether the provider accepts the job.' };
  if (offer.selectable) return { icon: '✓', label: 'Ready to book', note: '' };
  if (offer.providerResponse === 'declined') return { icon: '×', label: 'Provider declined', note: 'You can ask the provider again if you wish.' };
  if (offer.extractionStatus === 'failed') return { icon: '!', label: 'Review failed', note: 'Call details could not be extracted. You can request another call.' };
  if (offer.callStatus === 'failed' || offer.callStatus === 'no_answer') return { icon: '!', label: 'Call not completed', note: 'No confirmed offer was collected.' };
  if (offer.visitAt && Date.parse(offer.visitAt) <= Date.now()) return { icon: '◷', label: 'Visit time passed', note: 'Call again to ask for a new visit time.' };
  const missing = [offer.visitFee == null && 'visit fee', !offer.visitDate && 'visit date', !offer.visitTime && 'exact visit time'].filter(Boolean);
  return { icon: '!', label: 'Answer was not clear', note: missing.length
    ? `Not confirmed: ${missing.join(', ')}. Call again to ask this provider.` : 'The provider has not clearly confirmed an offer. You can call again.' };
}

export function visitLabel(offer: Offer) {
  if (offer.visitAt) return visitDate.format(new Date(offer.visitAt));
  return [offer.visitDate, offer.visitTime].filter(Boolean).join(' at ') ||
    offer.availabilityAsSaid || 'Visit time unavailable';
}

export function mapsLink(offer: Offer) {
  const query = new URLSearchParams({
    api: '1',
    query: [offer.provider?.name, offer.provider?.area].filter(Boolean).join(', ') || offer.placeId,
    query_place_id: offer.placeId,
  });
  return 'https://www.google.com/maps/search/?' + query;
}

