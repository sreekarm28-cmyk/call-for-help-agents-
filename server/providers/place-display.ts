export type AddressComponent = { longText?: string; types?: string[] };

export function placeArea(components: AddressComponent[] = []) {
  const types = ['neighborhood', 'sublocality_level_1', 'sublocality', 'locality', 'postal_town'];
  for (const type of types) {
    const name = components.find((part) => part.types?.includes(type) && part.longText?.trim())?.longText;
    if (name) return name.trim();
  }
  return null;
}

export async function fetchPlaceDisplay(placeId: string, includeRatings = false, includePhone = false) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) return null;
  const url = 'https://places.googleapis.com/v1/places/' + encodeURIComponent(placeId);
  const response = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': 'displayName,addressComponents' + (includeRatings ? ',rating,userRatingCount' : '')
        + (includePhone ? ',internationalPhoneNumber,nationalPhoneNumber' : ''),
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) return null;
  const place: {
    displayName?: { text?: string }; addressComponents?: AddressComponent[];
    rating?: number; userRatingCount?: number;
    internationalPhoneNumber?: string; nationalPhoneNumber?: string;
  } = await response.json();
  const display = {
    name: place.displayName?.text?.trim() || null,
    area: placeArea(place.addressComponents),
    ...(includePhone ? { phone: place.internationalPhoneNumber ?? place.nationalPhoneNumber ?? null } : {}),
  };
  return includeRatings
    ? { ...display, rating: place.rating ?? null, ratingCount: place.userRatingCount ?? null }
    : display;
}
