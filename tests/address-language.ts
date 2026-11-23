import assert from 'node:assert/strict';
import { verifyServiceAddress, geocodeServiceAddress } from '../server/providers/geocode-address.js';
import { callLanguage, languageForState } from '../server/providers/state-language.js';

const originalFetch = globalThis.fetch;
process.env.GOOGLE_MAPS_API_KEY = 'test-key';
process.env.GOOGLE_GEOCODING_API_KEY = '';
let state: string | null = 'Karnataka';
globalThis.fetch = async (input, init) => {
  if (String(input).startsWith('https://places.googleapis.com')) {
    assert.match(new Headers(init?.headers).get('x-goog-fieldmask') ?? '', /places.addressComponents/);
    return Response.json({ places: [{ types: ['street_address'], location: { latitude: 12, longitude: 77 },
      addressComponents: state ? [{ longText: state, types: ['administrative_area_level_1'] }] : [] }] });
  }
  assert.ok(String(input).startsWith('https://maps.googleapis.com/maps/api/geocode/json'));
  return Response.json({ status: 'OK', results: [{ geometry: { location: { lat: 12, lng: 77 } },
    address_components: state ? [{ long_name: state, types: ['administrative_area_level_1'] }] : [] }] });
};

try {
  for (const [region, expected] of [['Karnataka', 'kn'], ['Andhra Pradesh', 'te'], ['Telangana', 'te'],
    ['Tamil Nadu', 'ta'], ['Kerala', 'ml'], ['Delhi', 'hi'], ['Unknown state', 'en'], [null, 'en']] as const) {
    state = region;
    assert.equal((await verifyServiceAddress('Test address')).preferredLanguage, expected);
    assert.equal(languageForState(region), expected);
  }
  process.env.GOOGLE_GEOCODING_API_KEY = 'test-geocoding-key';
  state = 'Tamil Nadu';
  assert.equal((await verifyServiceAddress('Test address')).preferredLanguage, 'ta');
  assert.deepEqual(await geocodeServiceAddress('Test address'), { latitude: 12, longitude: 77 });
  assert.equal(languageForState('  KARNATAKA '), 'kn');
  assert.deepEqual(callLanguage(null), { preferredLanguage: 'en', languageName: 'English' });
  assert.equal(callLanguage('constructor').preferredLanguage, 'en');
  console.log('PASS both Google lookup paths infer language, retain coordinate compatibility, and handle unknown states.');
} finally {
  globalThis.fetch = originalFetch;
}
