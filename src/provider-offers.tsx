import { useEffect, useId, useRef, useState } from 'react';
import { useProviderOffers } from './offers/use-provider-offers';
import { ProviderOfferCard } from './offers/provider-offer-card';
import { OfferDetails } from './offers/offer-details';
import { OfferSelection } from './offers/offer-selection';

export function ProviderOffers({ requestId, description, onSelection }: {
  requestId: number; description?: string; onSelection?: () => void;
}) {
  const {
    result, loading, selecting, retrying, recalling, notice, error,
    primaryPlace, backupPlace, primaryOffer, backupOffer, readyToBook, firstChoiceId, backupChoiceId,
    choose, retryConfirmation, saveChoices, changeChoices, callAgain, loadOffers,
    selectPrimary, toggleBackup, clearChoices, closeOffers,
  } = useProviderOffers(requestId, onSelection);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailTab, setDetailTab] = useState<'summary' | 'transcript'>('summary');
  const dialog = useRef<HTMLDialogElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const lastDetailId = useRef<string | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (detailId) back.current?.focus();
    else if (dialog.current?.open && lastDetailId.current) {
      dialog.current.querySelector<HTMLButtonElement>(`[data-offer-id="${CSS.escape(lastDetailId.current)}"]`)?.focus();
    }
  }, [detailId]);

  const detailOffer = result?.offers.find((offer) => offer.callAttemptId === detailId);

  return <>
    <button className="workspace-show-providers" type="button" aria-haspopup="dialog" onClick={() => {
      dialog.current?.showModal();
      loadOffers();
    }}>View offers <span aria-hidden="true">↗</span></button>
    <dialog className="workspace-provider-dialog workspace-booking-offers-dialog" ref={dialog} aria-labelledby={titleId}
      onClose={() => { closeOffers(); setDetailId(null); lastDetailId.current = null; }}>
      <div className="workspace-provider-dialog-header">
        <div>
          {detailOffer && <button ref={back} type="button" className="workspace-offer-back"
            onClick={() => setDetailId(null)}>← All offers</button>}
          <h2 id={titleId}>{detailOffer ? detailOffer.provider?.name ?? 'Offer details' : 'Booking offers'}</h2>
          {description && <p>{description}</p>}
        </div>
        <button type="button" autoFocus aria-label="Close booking offers" onClick={() => dialog.current?.close()}>×</button>
      </div>
      {loading && <p role="status">Loading offers…</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p className="workspace-call-notice" role="status">{notice}</p>}
      {error && !result && <button type="button" onClick={loadOffers}>Try again</button>}
      {detailOffer ? <OfferDetails detailOffer={detailOffer} detailTab={detailTab} setDetailTab={setDetailTab} /> : result && (
        <>
          <p role="status">
            {result.progress.attempted} of {result.progress.shortlisted} providers called.
            {result.offers.some(({ extractionStatus }) => extractionStatus === 'pending') ? ' Reviewing call details.'
              : result.progress.inProgress ? ' Provider outreach is in progress.' : ''}
            {!result.offers.length ? ' No offers received yet.' : ''}
          </p>
          <ul className="workspace-booking-offer-list">
            {result.offers.map((offer) => (
              <ProviderOfferCard key={offer.id} offer={offer} booking={result.booking}
                firstChoiceId={firstChoiceId} backupChoiceId={backupChoiceId}
                selecting={selecting} retrying={retrying} recalling={recalling}
                primaryPlace={primaryPlace} backupPlace={backupPlace} hasPrimary={!!primaryOffer}
                onOpen={(selected) => {
                  lastDetailId.current = selected.callAttemptId;
                  setDetailTab('summary');
                  setDetailId(selected.callAttemptId);
                }}
                onPrimary={selectPrimary}
                onBackup={toggleBackup}
                callAgain={callAgain} changeChoices={changeChoices} retryConfirmation={retryConfirmation} />
            ))}
          </ul>
          {result.offers.some(({ provider }) => provider) && <small className="provider-attribution" translate="no">Google Maps</small>}
          {!result.booking && primaryOffer && <OfferSelection
            primaryOffer={primaryOffer} backupOffer={backupOffer} readyToBook={readyToBook}
            selecting={selecting} loading={loading} recalling={recalling}
            onClear={clearChoices}
            onConfirm={() => void (readyToBook ? choose(primaryOffer.id) : saveChoices())} />}
        </>
      )}
    </dialog>
  </>;
}
