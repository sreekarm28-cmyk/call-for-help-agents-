import assert from 'node:assert/strict';
import { filterProviders, type ProviderCandidate } from '../server/providers/filter-providers.js';

function vendor(id: number, rating: number, ratingCount: number | null, distanceMeters = 1000): ProviderCandidate {
  return { placeId: String(id), phoneNumber: '+9198765000' + String(id).padStart(2, '0'),
    serviceMatch: 'match', rating, ratingCount, distanceMeters, businessStatus: 'OPERATIONAL' };
}
const ids = (providers: ProviderCandidate[]) => filterProviders(providers, {
  preferredRadiusMeters: 5000,
}).selected.map(({ placeId }) => placeId);

assert.deepEqual(ids([vendor(1, 4.9, 10), vendor(2, 4.5, 200)]), ['2', '1']);
assert.deepEqual(ids([vendor(1, 4.5, 200), vendor(2, 4.9, 200)]), ['2', '1']);
assert.deepEqual(ids([vendor(1, 4.8, 100, 2000), vendor(2, 4.8, 100, 1000)]), ['2', '1']);
assert.deepEqual(ids([vendor(1, 4.8, null), vendor(2, 4.8, 20), vendor(3, 4.8, -10)]), ['2', '1', '3']);
assert.deepEqual(ids([vendor(1, 4.5, 20), vendor(2, 4.9, 2000, 6000)]), ['1', '2']);
const grouped = filterProviders([vendor(1, 4.5, 20), vendor(2, 3.8, 2000)], {
  priority: ({ rating }) => (rating ?? 0) >= 4 ? 0 : 1,
}).selected;
assert.deepEqual(grouped.map(({ placeId }) => placeId), ['1', '2']);
console.log('PASS review count ranks first within rating and nearby groups; rating and distance break ties.');
