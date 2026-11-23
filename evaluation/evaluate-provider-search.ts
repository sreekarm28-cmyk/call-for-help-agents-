import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { coordinates } from '../server/providers/coordinates.js';
import { searchProvidersAt } from '../server/providers/search-providers.js';
const candidateLimit = 20;

async function main() {
  const [service = 'plumber', latitude = '12.97830', longitude = '77.63865', targetArg = '5'] =
    process.argv.slice(2);
  const serviceType = z.enum(['plumber', 'electrician', 'locksmith', 'painter', 'roofing_contractor'])
    .parse(service);
  const center = coordinates.parse({ latitude: Number(latitude), longitude: Number(longitude) });
  const target = z.coerce.number().int().min(5).max(candidateLimit).parse(targetArg);
  const { selected, candidates, strictPassRate, ...summary } =
    await searchProvidersAt(serviceType, center, target);

  console.log({
    serviceType,
    radiusKm: 10,
    ...summary,
    strictPassRate: strictPassRate === null ? 'N/A' : `${(strictPassRate * 100).toFixed(0)}%`,
    ratingCutoff: summary.ratingCutoff ?? 'fallback: any rating, including unrated',
    selectedCount: selected.length,
  });
  console.table(candidates.map((provider) => {
    const pickIndex = selected.findIndex((pick) => pick.placeId === provider.placeId);
    return {
      name: provider.name,
      phone: provider.phoneNumber,
      category: provider.primaryType,
      businessStatus: provider.businessStatus,
      rating: provider.rating,
      ratingCount: provider.ratingCount,
      distanceKm: provider.distanceMeters === null ? null : (provider.distanceMeters / 1_000).toFixed(2),
      pick: pickIndex < 0 ? null : pickIndex + 1,
    };
  }));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
