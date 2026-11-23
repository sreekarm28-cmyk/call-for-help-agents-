export type Offer = {
  id: string;
  callAttemptId: string;
  placeId: string;
  visitAt: string | null;
  visitFee: string | null;
  feeCovers: string | null;
  repairFeeMin: string | null;
  repairFeeMax: string | null;
  visitDate: string | null;
  visitTime: string | null;
  availabilityAsSaid: string | null;
  providerResponse: string | null;
  extractionStatus: 'pending' | 'completed' | 'failed' | null;
  repairCostNotes: string | null;
  summary: string | null;
  transcript: string | null;
  selectable: boolean;
  callStatus: string;
  recallBlockedReason: string | null;
  provider: { name: string | null; area: string | null; rating: number | null; ratingCount: number | null } | null;
};
export type Booking = {
  id: string; offerId: string; backupOfferId: string | null; status: string;
  confirmation?: { callAttemptId: string; status: string; decision: string | null;
    extractionStatus: string | null; canRetry: boolean; attemptCount?: number; attemptLimit?: number;
    availableAt?: string; transcript?: string | null } | null;
};
export type OfferList = {
  offers: Offer[];
  progress: { shortlisted: number; attempted: number; inProgress: boolean };
  booking?: Booking;
  preferences?: { primaryPlaceId: string; backupPlaceId: string | null };
};

