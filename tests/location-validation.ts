import assert from 'node:assert/strict';
import { test } from 'node:test';
import { distanceMetres, readPin, readLocationChoice, resolveServiceLocation } from '../server/requests/location.js';

const address = { latitude: 12.934827, longitude: 77.537381 };
test('distance uses metres, includes 500m boundary, and handles identical and antipodal points', () => {
  assert.equal(distanceMetres(address, address), 0);
  for (const metres of [499.9, 500, 500.1]) {
    const pin = { latitude: metres / 6371000 * 180 / Math.PI, longitude: 0 };
    const result = resolveServiceLocation({ latitude: 0, longitude: 0 }, pin, null);
    assert.ok(Math.abs(result.distanceMetres - metres) < 0.000001);
    assert.equal(result.needsChoice, metres > 500);
  }
  assert.ok(Number.isFinite(distanceMetres({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 180 })));
});
test('nearby pins are used; distant pins require a choice and each choice uses the correct coordinates', () => {
  const nearby = { latitude: 12.934922, longitude: 77.537875 };
  const far = { latitude: 12.985682, longitude: 77.478913 };
  const accepted = resolveServiceLocation(address, nearby, null);
  assert.equal(accepted.needsChoice, false);
  if (!accepted.needsChoice) { assert.equal(accepted.source, 'pin'); assert.deepEqual(accepted.coordinates, nearby); }
  assert.equal(resolveServiceLocation(address, far, null).needsChoice, true);
  for (const choice of ['pin', 'address'] as const) {
    const result = resolveServiceLocation(address, far, choice);
    assert.equal(result.needsChoice, false);
    if (!result.needsChoice) assert.deepEqual(result.coordinates, choice === 'pin' ? far : address);
  }
});
test('rejects absent, string, non-finite, and out-of-range pins and invalid choices', () => {
  for (const pin of [undefined, null, {}, { latitude: '12', longitude: 77 }, { latitude: NaN, longitude: 0 },
    { latitude: Infinity, longitude: 0 }, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }]) {
    assert.throws(() => readPin(pin), /Select a valid location/);
  }
  assert.deepEqual(readPin({ latitude: 0, longitude: 0 }), { latitude: 0, longitude: 0 });
  assert.throws(() => readLocationChoice('anything'), /Choose/);
});
