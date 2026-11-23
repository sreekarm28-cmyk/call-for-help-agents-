export type ProviderCandidate = {
  placeId: string;
  phoneNumber: string | null;
  serviceMatch: 'match' | 'unclear' | 'mismatch';
  businessStatus?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  distanceMeters?: number | null;
};

const shortlistLimit = 5;
const priorRating = 4;
const priorRatingCount = 20;

function normalizePhone(phone: string | null) {
  const trimmed = phone?.trim() ?? '';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;

  // The app serves India. Match local and international formats for the same number.
  if (/^91\d{10}$/.test(digits)) return `+${digits}`;
  if (/^0?\d{10}$/.test(digits)) return `+91${digits.slice(-10)}`;
  return digits;
}

function ratingScore({ rating, ratingCount }: ProviderCandidate) {
  if (rating == null || rating < 1 || rating > 5 || !Number.isFinite(rating)
      || ratingCount == null || !Number.isInteger(ratingCount) || ratingCount < 1) {
    return priorRating;
  }
  // Move ratings based on only a few votes toward the baseline.
  return priorRating + (rating - priorRating) * (ratingCount / (ratingCount + priorRatingCount));
}

export function filterProviders<T extends ProviderCandidate>(
  candidates: readonly T[],
  { limit = shortlistLimit, preferredRadiusMeters, priority }: {
    limit?: number;
    preferredRadiusMeters?: number;
    priority?: (provider: T) => number;
  } = {},
) {
  const selected: T[] = [];
  let eligibleCount = 0;
  const seenPhones = new Set<string>();
  const seenPlaces = new Set<string>();
  const ranked = candidates
    .filter((provider) =>
      provider.serviceMatch !== 'mismatch' &&
      provider.businessStatus !== 'CLOSED_TEMPORARILY' &&
      provider.businessStatus !== 'CLOSED_PERMANENTLY',
    )
    .map((provider) => ({
      provider, phone: normalizePhone(provider.phoneNumber), score: ratingScore(provider),
      reviewCount: Number.isInteger(provider.ratingCount) && (provider.ratingCount ?? 0) > 0
        ? provider.ratingCount! : 0,
      priority: priority?.(provider) ?? 0,
    }))
    .filter(({ phone }) => phone !== '')
    .sort((a, b) => {
      if (a.provider.serviceMatch !== b.provider.serviceMatch) {
        return a.provider.serviceMatch === 'match' ? -1 : 1;
      }
      if (a.priority !== b.priority) return a.priority - b.priority;
      if (preferredRadiusMeters !== undefined) {
        const aIsNearby = (a.provider.distanceMeters ?? Infinity) <= preferredRadiusMeters;
        const bIsNearby = (b.provider.distanceMeters ?? Infinity) <= preferredRadiusMeters;
        if (aIsNearby !== bIsNearby) return aIsNearby ? -1 : 1;
      }
      return b.reviewCount - a.reviewCount || b.score - a.score ||
        (a.provider.distanceMeters ?? Infinity) - (b.provider.distanceMeters ?? Infinity);
    });

  for (const { provider, phone } of ranked) {
    if (seenPhones.has(phone) || seenPlaces.has(provider.placeId)) continue;
    seenPhones.add(phone);
    seenPlaces.add(provider.placeId);

    if (provider.serviceMatch === 'match') {
      eligibleCount += 1;
      if (selected.length < limit) selected.push(provider);
    }
  }

  return { selected, eligibleCount };
}
