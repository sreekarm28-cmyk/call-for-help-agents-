export class TemporaryGoogleError extends Error {}

export async function fetchGoogle(service: string, url: string | URL, options: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });
  } catch (error) {
    throw new TemporaryGoogleError(`${service} could not be reached.`, { cause: error });
  }
  if (response.ok) return response;

  const message = `${service} returned HTTP ${response.status}.`;
  if ([408, 429].includes(response.status) || response.status >= 500) {
    throw new TemporaryGoogleError(message);
  }
  throw new Error(message);
}
