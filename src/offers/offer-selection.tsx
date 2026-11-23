import type { Offer } from './types';
import { visitLabel } from './format';

export function OfferSelection({ primaryOffer, backupOffer, readyToBook, selecting, loading, recalling, onClear, onConfirm }: {
  primaryOffer: Offer; backupOffer?: Offer; readyToBook: boolean; selecting: string | null;
  loading: boolean; recalling: string | null; onClear: () => void; onConfirm: () => void;
}) {
  return (
    <div className="workspace-offer-confirm">
      <p>{readyToBook ? 'Request this booking with ' : 'Save your first choice as '}<strong>{primaryOffer.provider?.name ?? visitLabel(primaryOffer)}</strong>?
        {backupOffer && <> Backup <strong>{backupOffer.provider?.name ?? visitLabel(backupOffer)}</strong>.</>}
      </p>
      <div className="workspace-offer-actions">
        <button type="button" disabled={selecting !== null} onClick={onClear}>No, keep comparing</button>
        <button type="button" className="workspace-primary" disabled={loading || selecting !== null || recalling !== null}
          onClick={onConfirm}>
          {selecting ? 'Saving…' : readyToBook ? 'Yes, request booking' : 'Save choices — clarify details'}
        </button>
      </div>
    </div>
  );
}
