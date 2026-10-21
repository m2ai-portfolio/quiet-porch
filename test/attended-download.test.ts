import { afterEach, expect, it, vi } from 'vitest';
import { downloadImageAt } from '../src/ring.ts';
afterEach(() => vi.unstubAllGlobals());
function pending(signal: AbortSignal) {
  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), {
      once: true,
    });
  });
}
it('disarm cancels the Ring image request before any media transfer', async () => {
  const stop = new AbortController();
  const request = vi.fn(async (_url: string, init: RequestInit) =>
    pending(init.signal as AbortSignal),
  );
  vi.stubGlobal('fetch', request);
  const result = downloadImageAt('fixture-token', 'fixture-cam', 1000, {
    keepImage: true,
    signal: stop.signal,
  });
  stop.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).toHaveBeenCalledTimes(1);
});
it('disarm during media transfer cancels it without returning evidence', async () => {
  const stop = new AbortController();
  const request = vi.fn(async (url: string, init: RequestInit) =>
    url.includes('api.amazonvision.com')
      ? new Response(null, { status: 303, headers: { location: 'https://media.test/image' } })
      : pending(init.signal as AbortSignal),
  );
  vi.stubGlobal('fetch', request);
  const result = downloadImageAt('fixture-token', 'fixture-cam', 1000, {
    keepImage: true,
    signal: stop.signal,
  });
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  stop.abort();
  await expect(result).rejects.toMatchObject({ name: 'AbortError' });
});
