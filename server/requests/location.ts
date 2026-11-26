import { coordinates, type Coordinates } from '../providers/coordinates.js';

export const locationToleranceMetres = 500;
export type LocationChoice = 'pin' | 'address';

export function readPin(value: unknown): Coordinates {
  const result = coordinates.safeParse(value);
  if (!result.success) throw new Error('Select a valid location on the map.');
  return result.data;
}

export function readLocationChoice(value: unknown): LocationChoice | null {
  if (value === undefined || value === null) return null;
  if (value !== 'pin' && value !== 'address') throw new Error('Choose the pin or address location.');
  return value;
}

export function distanceMetres(a: Coordinates, b: Coordinates) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const lat = radians(b.latitude - a.latitude);
  const lng = radians(b.longitude - a.longitude);
  const h = Math.sin(lat / 2) ** 2 + Math.cos(radians(a.latitude))
    * Math.cos(radians(b.latitude)) * Math.sin(lng / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

export function resolveServiceLocation(address: Coordinates, pin: Coordinates, choice: LocationChoice | null) {
  const distance = distanceMetres(address, pin);
  if (distance > locationToleranceMetres && choice === null) {
    return { needsChoice: true as const, distanceMetres: distance, address, pin };
  }
  const source = choice ?? 'pin';
  return { needsChoice: false as const, distanceMetres: distance, source,
    coordinates: source === 'pin' ? pin : address, address, pin };
}
