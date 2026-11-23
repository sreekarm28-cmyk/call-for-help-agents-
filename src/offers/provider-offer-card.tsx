import type { Offer, Booking } from './types';
import { confirmationLabel } from '../confirmation-status';
import { mapsLink, visitLabel, rupees, offerState } from './format';

type CardProps = {
  offer: Offer;
  booking?: Booking;
  firstChoiceId?: string;
  backupChoiceId?: string | null;
  selecting: string | null;
  retrying: boolean;
  recalling: string | null;
  primaryPlace?: string | null;
  backupPlace?: string | null;
  hasPrimary: boolean;
  onOpen: (offer: Offer) => void;
  onPrimary: (placeId: string) => void;
  onBackup: (placeId: string) => void;
  callAgain: (offer: Offer) => Promise<void>;
  changeChoices: () => Promise<void>;
  retryConfirmation: () => Promise<void>;
};

export function ProviderOfferCard({ offer, booking, firstChoiceId, backupChoiceId, selecting, retrying, recalling, primaryPlace, backupPlace, hasPrimary, onOpen, onPrimary, onBackup, callAgain, changeChoices, retryConfirmation }: CardProps) {
  return (
    <li className="workspace-booking-offer" key={offer.id}
      data-choice={firstChoiceId === offer.id ? 'primary' : backupChoiceId === offer.id ? 'backup' : undefined}>
      <div className="workspace-booking-offer-provider">
      {(firstChoiceId === offer.id || backupChoiceId === offer.id) &&
        <span className="workspace-offer-choice-badge">
          <span aria-hidden="true">{firstChoiceId === offer.id ? '★' : '◇'}</span>
          {firstChoiceId === offer.id ? 'First choice' : 'Backup choice'}
        </span>}
      <h3><button type="button" className="workspace-offer-open" data-offer-id={offer.callAttemptId} onClick={() => onOpen(offer)}>{offer.provider?.name ?? 'Provider name unavailable'}</button></h3>
      {offer.provider?.area && <p>{offer.provider.area}</p>}
      {offer.provider?.rating != null && (
        <p>{offer.provider.rating}/5{offer.provider.ratingCount != null && ` · ${offer.provider.ratingCount} reviews`}</p>
      )}
      <a href={mapsLink(offer)} target="_blank" rel="noreferrer" className="workspace-offer-map">Google Maps ↗</a>
      </div>
      <div className="workspace-booking-offer-terms">
      {offer.extractionStatus === 'pending' ? <p>Pending · Reviewing call details</p>
        : offer.extractionStatus === 'failed' ? <p>Could not review the call. Transcript available.</p>
        : <>
          {offer.providerResponse === 'declined' && <p>Provider declined</p>}
          {offer.providerResponse === 'no_answer' && <p>No answer</p>}
          {offer.providerResponse === 'needs_clarification' && <p>Answer was not clear</p>}
          <p>{offer.visitFee == null ? 'Visit fee unavailable' : <><strong>{rupees.format(Number(offer.visitFee))}</strong> visit fee</>}</p>
          {offer.feeCovers && <p>{offer.feeCovers}</p>}
          <p>{visitLabel(offer)}</p>
          {offer.repairFeeMin != null && offer.repairFeeMax != null && <p>
            Repair quote {rupees.format(Number(offer.repairFeeMin))}
            {offer.repairFeeMin !== offer.repairFeeMax && '–' + rupees.format(Number(offer.repairFeeMax))}
          </p>}
          {offer.repairCostNotes && <p>{offer.repairCostNotes}</p>}
        </>}
        {(offer.providerResponse === 'needs_clarification' || booking?.offerId === offer.id && booking.confirmation?.decision === 'needs_clarification') &&
          <details className="workspace-inline-transcript" open>
            <summary>Read the call transcript</summary>
            <pre>{booking?.offerId === offer.id && booking.confirmation?.decision === 'needs_clarification'
              ? booking.confirmation.transcript || 'No transcript is available for this call.'
              : offer.transcript || 'No transcript is available for this call.'}</pre>
          </details>}
      </div>
      <div className="workspace-booking-offer-choice">
      {!booking && <>
        <p className="workspace-offer-state" data-ready={offer.selectable}>
          <span aria-hidden="true">{offerState(offer).icon}</span> {offerState(offer).label}
        </p>
        {offerState(offer).note && <p className="workspace-offer-selection-note" id={`offer-note-${offer.callAttemptId}`}>{offerState(offer).note}</p>}
      </>}
      {booking?.offerId === offer.id && <p><strong>
        {confirmationLabel(booking.status, booking.confirmation)}
      </strong></p>}
      {booking?.offerId === offer.id && booking.status !== 'confirmed' &&
        (booking.confirmation?.decision === 'needs_clarification' || booking.confirmation?.status === 'failed' || booking.confirmation?.extractionStatus === 'failed') &&
        <div className="workspace-offer-actions">
          <button type="button" disabled={selecting !== null || retrying} onClick={() => void changeChoices()}>Change first choice / backup</button>
        </div>}
      {booking?.offerId === offer.id && booking.confirmation?.attemptLimit &&
        <p className="workspace-offer-selection-note">Confirmation attempt {booking.confirmation.attemptCount} of {booking.confirmation.attemptLimit}</p>}
      {booking?.offerId === offer.id && booking.confirmation?.canRetry && <>
        <p>The last call did not confirm the booking. Your backup has not been called.</p>
        <div className="workspace-offer-actions">
          <button type="button" disabled={retrying} onClick={() => void retryConfirmation()}>
            {retrying ? 'Queuing call…' : 'Retry confirmation'}
          </button>
        </div>
      </>}
      {booking?.offerId === offer.id && ['queued', 'calling'].includes(booking.confirmation?.status ?? '') &&
        <p role="status">{booking.confirmation?.status === 'calling' ? 'Calling your selected provider…' : 'Confirmation call queued.'}</p>}
      {booking?.backupOfferId === offer.id && <p><strong>Backup choice</strong></p>}
      {!booking && <div className="workspace-offer-actions">
        <button type="button" aria-pressed={primaryPlace === offer.placeId} disabled={selecting !== null || recalling !== null}
          onClick={() => onPrimary(offer.placeId)}><span aria-hidden="true">★ </span>First choice</button>
        <button type="button" aria-pressed={backupPlace === offer.placeId} disabled={!hasPrimary || primaryPlace === offer.placeId || selecting !== null || recalling !== null}
          onClick={() => onBackup(offer.placeId)}>Backup</button>
        <button type="button" className="workspace-recall-provider"
          disabled={!!offer.recallBlockedReason || recalling !== null || selecting !== null}
          title={offer.recallBlockedReason ?? 'Ask this provider for the details again'}
          onClick={() => void callAgain(offer)}>
          <span aria-hidden="true">↻ </span>{recalling === offer.callAttemptId ? 'Queuing…' : 'Call again'}
        </button>
        {offer.recallBlockedReason && <small>{offer.recallBlockedReason}</small>}
      </div>}
      {booking && booking.offerId !== offer.id && booking.backupOfferId !== offer.id &&
        <p className="workspace-offer-selection-note">A booking is already selected for this request.</p>}
      </div>
    </li>
  );
}
