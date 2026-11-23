import { z } from 'zod';
import { callProviderSearch } from '../mcp/google-places-client.js';
import { coordinates, type Coordinates } from './coordinates.js';
import { filterProviders, type ProviderCandidate } from './filter-providers.js';

const radiusMeters = 10_000;
const preferredRadiusMeters = 5_000;
const candidateLimit = 20;
const strictRating = 4;
const fallbackRating = 3.5;

const providerResponse = z.object({
  providers: z.array(z.object({
    placeId: z.string(),
    name: z.string().nullable(),
    address: z.string().nullable(),
    area: z.string().nullable(),
    phoneNumber: z.string().nullable(),
    rating: z.number().nullable(),
    ratingCount: z.number().nullable(),
    primaryType: z.string().nullable(),
    types: z.array(z.string()).default([]),
    businessStatus: z.string().nullable(),
    location: coordinates.nullable(),
  })),
});
type Provider = z.infer<typeof providerResponse>['providers'][number];

function normalizeService(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function getDistanceMeters(center: Coordinates, location: Coordinates | null) {
  if (!location) return null;
  const radians = Math.PI / 180;
  const a = Math.sin((location.latitude - center.latitude) * radians / 2) ** 2
    + Math.cos(center.latitude * radians) * Math.cos(location.latitude * radians)
    * Math.sin((location.longitude - center.longitude) * radians / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(Math.min(1, a)));
}

function evaluateProviders(
  providers: readonly Provider[],
  serviceType: string,
  center: Coordinates,
  target = 5,
  customService = false,
) {
  const requestedTrade = normalizeService(serviceType);
  const candidates = providers.map((provider) => {
    const name = normalizeService(provider.name ?? '');
    const matchesService = [provider.primaryType ?? '', ...provider.types].some(
      (type) => normalizeService(type) === requestedTrade,
    )
      || (customService && requestedTrade !== '' && ` ${name} `.includes(` ${requestedTrade} `));
    const serviceMatch: ProviderCandidate['serviceMatch'] =
      matchesService ? 'match' : 'unclear';
    return { ...provider, serviceMatch, distanceMeters: getDistanceMeters(center, provider.location) };
  });
  const inRadius = candidates.filter(
    ({ distanceMeters }) => distanceMeters !== null && distanceMeters <= radiusMeters,
  );
  const options = { limit: target, preferredRadiusMeters };
  const strict = filterProviders(
    inRadius.filter(({ rating }) => rating !== null && rating >= strictRating),
    options,
  );

  let picks = strict;
  if (picks.selected.length < target && inRadius.length > 0) {
    const priority = ({ rating }: Provider) => {
      if (rating === null) return 3;
      if (rating >= strictRating) return 0;
      return rating >= fallbackRating ? 1 : 2;
    };
    picks = filterProviders(
      inRadius.filter(({ rating }) => rating !== null && rating >= fallbackRating),
      { ...options, priority },
    );
    if (picks.selected.length < target) {
      picks = filterProviders(inRadius, { ...options, priority });
    }
  }
  const ratingCutoff = picks.selected.some(({ rating }) => rating === null || rating < fallbackRating)
    ? null
    : picks.selected.some(({ rating }) => rating !== null && rating < strictRating)
      ? fallbackRating
      : strictRating;

  return {
    fetched: candidates.length,
    withinRadius: inRadius.length,
    strictPassCount: strict.eligibleCount,
    strictPassRate: candidates.length ? strict.eligibleCount / candidates.length : null,
    ratingCutoff,
    eligibleCount: picks.eligibleCount,
    target,
    shortfall: target - picks.selected.length,
    selected: picks.selected,
    candidates,
  };
}

export async function searchProvidersAt(
  serviceType: string,
  center: Coordinates,
  target = 5,
  customService = false,
  excludedPlaceIds: readonly string[] = [],
) {
  const result = await callProviderSearch({
    serviceType, ...center, radiusMeters, maxResults: candidateLimit,
  });
  const { providers } = providerResponse.parse(result);
  const excluded = new Set(excludedPlaceIds);
  return evaluateProviders(
    providers.filter(({ placeId }) => !excluded.has(placeId)),
    serviceType, center, target, customService,
  );
}
