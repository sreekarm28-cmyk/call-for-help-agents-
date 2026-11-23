import { useState } from 'react';

type Provider = { name: string | null; area: string | null };

export function ProviderShortlist({ requestId }: { requestId: number }) {
  const [providers, setProviders] = useState<(Provider | null)[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/me/requests/${requestId}/providers`);
      const result = await response.json() as { providers?: (Provider | null)[]; error?: string };
      if (!response.ok || !result.providers) throw new Error(result.error ?? 'Could not load providers.');
      setProviders(result.providers);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load providers.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="provider-shortlist" aria-label="Shortlisted providers">
      {providers === null && (
        <button className="submit-button" type="button" disabled={loading} onClick={() => void load()}>
          {loading ? 'Loading providers…' : 'Show providers'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
      {providers?.length === 0 && <p>No provider details available.</p>}
      {!!providers?.length && (
        <>
          <ol>
            {providers.map((provider, index) => (
              <li key={index}>
                {provider?.name ?? 'Business name unavailable'}{provider?.area && <> · {provider.area}</>}
              </li>
            ))}
          </ol>
          {providers.some(Boolean) && <small className="provider-attribution" translate="no">Google Maps</small>}
        </>
      )}
    </section>
  );
}
