import { z } from 'zod';
import { coordinates } from './coordinates.js';
import { fetchGoogle, TemporaryGoogleError } from './google-request.js';
import { languageForState } from './state-language.js';
import type { Coordinates } from './coordinates.js';

export type VerifiedServiceAddress = Coordinates & { state: string | null; preferredLanguage: string };

function verifiedAddress(location: Coordinates, state: string | null): VerifiedServiceAddress {
  return { ...location, state, preferredLanguage: languageForState(state) };
}

export class UnresolvedAddressError extends Error {
  constructor() {
    super('We could not locate the service address. Check the street, city, and postal code.');
  }
}

const geocodingResponse = z.object({
  status: z.string(),
  results: z.array(z.object({
    partial_match: z.boolean().optional(),
    address_components: z.array(z.object({ long_name: z.string(), types: z.array(z.string()) })).optional(),
    geometry: z.object({ location: z.object({ lat: z.number(), lng: z.number() }) }),
  })).optional(),
});

const placeAddressResponse = z.object({
  places: z.array(z.object({
    formattedAddress: z.string().optional(),
    types: z.array(z.string()).optional(),
    location: coordinates.optional(),
    addressComponents: z.array(z.object({ longText: z.string(), types: z.array(z.string()) })).optional(),
  })).optional(),
  nextPageToken: z.string().optional(),
});
const precisePlaceTypes = new Set(['street_address', 'premise', 'subpremise', 'point_of_interest', 'establishment']);

async function resolveWithPlaces(address: string, postalCode: string | undefined) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) throw new Error('A Google Places API key is required.');

  const response = await fetchGoogle('Google Places address lookup', 'https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'places.location,places.formattedAddress,places.types,places.addressComponents,nextPageToken',
    },
    body: JSON.stringify({ textQuery: address, pageSize: 2, regionCode: 'IN', languageCode: 'en' }),
  });

  const data = placeAddressResponse.parse(await response.json());
  const [place] = data.places ?? [];
  const postalCodeMatches = !!postalCode
    && !!place?.formattedAddress?.match(/\b[1-9]\d{5}\b/g)?.includes(postalCode);
  const preciseMatch = place?.types?.some((type) => precisePlaceTypes.has(type));
  // A verified street is sufficient to center a nearby-provider search.
  const streetMatch = postalCodeMatches && place?.types?.includes('route');
  if (data.places?.length !== 1 || data.nextPageToken || !place?.location
      || (!preciseMatch && !streetMatch) || (postalCode && !postalCodeMatches)) {
    throw new UnresolvedAddressError();
  }
  const state = place.addressComponents?.find((part) => part.types.includes('administrative_area_level_1'))?.longText ?? null;
  return verifiedAddress(place.location, state);
}

async function resolveAddress(query: string, postalCode: string | undefined) {
  const apiKey = process.env.GOOGLE_GEOCODING_API_KEY?.trim();
  if (!apiKey) return resolveWithPlaces(query, postalCode);

  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.search = new URLSearchParams({ address: query, region: 'in', language: 'en', key: apiKey }).toString();
  const response = await fetchGoogle('Google Geocoding', url, {});

  const data = geocodingResponse.parse(await response.json());
  if (data.status === 'ZERO_RESULTS') throw new UnresolvedAddressError();
  if (data.status === 'UNKNOWN_ERROR' || data.status === 'OVER_QUERY_LIMIT') {
    throw new TemporaryGoogleError(`Google Geocoding returned ${data.status}.`);
  }
  if (data.status !== 'OK') throw new Error(`Google Geocoding returned ${data.status}.`);
  if (data.results?.length !== 1 || data.results[0].partial_match
      || (postalCode && !data.results[0].address_components?.some(
        (part) => part.types.includes('postal_code') && part.long_name === postalCode,
      ))) {
    throw new UnresolvedAddressError();
  }
  const { lat, lng } = data.results[0].geometry.location;
  const state = data.results[0].address_components?.find((part) => part.types.includes('administrative_area_level_1'))?.long_name ?? null;
  return verifiedAddress(coordinates.parse({ latitude: lat, longitude: lng }), state);
}

export async function verifyServiceAddress(address: string) {
  const lines = address.split('\n');
  if (lines.length === 4 && /^[1-9]\d{5}$/.test(lines[3])) {
    const [, street, areaCity, pinCode] = lines;
    return resolveAddress(`${street}, ${areaCity} ${pinCode}, India`, pinCode);
  }
  const structuredPin = lines.length === 3 && /^[1-9]\d{5}$/.test(lines[2]) ? lines[2] : undefined;
  if (!structuredPin) return resolveAddress(address, address.match(/\b[1-9]\d{5}\b/)?.[0]);

  const [street, areaCity] = lines;
  const locality = `${areaCity} ${structuredPin}, India`;
  try {
    return await resolveAddress(`${street}, ${locality}`, structuredPin);
  } catch (error) {
    if (!(error instanceof UnresolvedAddressError)) throw error;
    // Preserve numbered roads (for example "5th Main") and strip only a leading house number.
    const streetOnly = street.replace(/^(?:(?:house|flat|door)\s+(?:no\.?\s*)?|no\.?\s*|#\s*)?\d+[a-z]?(?:[/-]\d+[a-z]?)*(?:\s*,\s*|\s+)/i, '').trim();
    if (!streetOnly || streetOnly === street || /^\d/.test(streetOnly) && !street.includes(',')) throw error;
    return resolveAddress(`${streetOnly}, ${locality}`, structuredPin);
  }
}

export async function geocodeServiceAddress(address: string): Promise<Coordinates> {
  const { latitude, longitude } = await verifyServiceAddress(address);
  return { latitude, longitude };
}
