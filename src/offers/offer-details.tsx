import type { Offer } from './types';

export function OfferDetails({ detailOffer, detailTab, setDetailTab }: {
  detailOffer: Offer;
  detailTab: 'summary' | 'transcript';
  setDetailTab: (tab: 'summary' | 'transcript') => void;
}) {
  return (
    <div className="workspace-offer-detail">
      <div className="workspace-offer-tabs" role="group" aria-label="Call details">
        <button type="button" aria-pressed={detailTab === 'summary'} onClick={() => setDetailTab('summary')}>Summary</button>
        <button type="button" aria-pressed={detailTab === 'transcript'} onClick={() => setDetailTab('transcript')}>Transcript</button>
      </div>
      <div className="workspace-offer-text" key={detailTab} data-view={detailTab} aria-label={detailTab === 'summary' ? 'Call summary' : 'Call transcript'}>
        {detailTab === 'summary'
          ? detailOffer.summary || (detailOffer.extractionStatus === 'pending' ? 'Pending · Reviewing call details' : 'No summary available for this call.')
          : detailOffer.transcript || 'No transcript available for this call.'}
      </div>
    </div>
  );
}
