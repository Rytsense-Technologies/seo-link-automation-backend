// Port of tests/unit/test_crawler_ssrf.py — static URL checks, DNS-resolution checks, connect-time enforcement.
import { describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { Fetcher, FetchError, fetcherConfig } from '../../src/crawler/fetcher.js';
import {
  SSRFError,
  checkIp,
  createGuardedConnect,
  createGuardedDispatcher,
  guardedLookup,
  isSsrfBlock,
  resolvePublic,
  validateUrl,
} from '../../src/crawler/ssrf.js';

const lookupAsync = (lookup, host, options) =>
  new Promise((resolve) => {
    lookup(host, options, (err, address, family) => resolve({ err, address, family }));
  });
const connectAsync = (connect, opts) =>
  new Promise((resolve) => {
    connect(opts, (err, socket) => resolve({ err, socket }));
  });

describe('SSRF protection', () => {
  it.each([
    'http://localhost/',
    'http://LOCALHOST./admin',
    'http://app.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/computeMetadata/v1/',
    'http://127.0.0.1/',
    'http://127.1.2.3/',
    'http://0.0.0.0/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://100.64.0.1/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[fd00:ec2::254]/',
    'http://[::ffff:127.0.0.1]/',
    'http://224.0.0.1/',
    'ftp://example.com/',
    'file:///etc/passwd',
    'gopher://example.com/',
    'https://user:pass@example.com/',
    'https://example.com:8080/',
    'https://example.com:22/',
  ])('validate_url blocks %s', (url) => {
    expect(() => validateUrl(url)).toThrow(SSRFError);
  });

  it.each(['https://rytsensetech.com/', 'http://example.com/a?b=1', 'https://93.184.216.34/'])('validate_url allows %s', (url) => {
    expect(() => validateUrl(url)).not.toThrow();
  });

  it('blocks resolution to private addresses', async () => {
    // DNS answers are checked, not just the hostname.
    await expect(resolvePublic('innocent.example', 443, async () => ['10.1.2.3'])).rejects.toBeInstanceOf(SSRFError);
    // A single private answer among public ones is enough to block.
    await expect(resolvePublic('mixed.example', 443, async () => ['93.184.216.34', '127.0.0.1'])).rejects.toBeInstanceOf(SSRFError);
    await expect(resolvePublic('empty.example', 443, async () => [])).rejects.toBeInstanceOf(SSRFError);
    expect(await resolvePublic('ok.example', 443, async () => ['93.184.216.34'])).toEqual(['93.184.216.34']);
  });

  it('check_ip rejects invalid input', () => {
    expect(() => checkIp('not-an-ip')).toThrow(SSRFError);
  });

  it('the socket only ever receives the validated IP (no re-resolution / DNS rebinding)', async () => {
    let calls = 0;
    // A rebinding resolver: public on the first answer, private afterwards.
    const rebinding = async () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']);
    const lookup = guardedLookup(rebinding);
    const first = await lookupAsync(lookup, 'example.com', { all: true });
    expect(first.err).toBeNull();
    expect(first.address).toEqual([{ address: '93.184.216.34', family: 4 }]);
    // The next connection resolves again and is validated again -> blocked, never connected.
    const second = await lookupAsync(lookup, 'example.com', {});
    expect(isSsrfBlock(second.err)).toBe(true);
    expect(second.address).toBeUndefined();
  });

  it('blocks private resolution, bad ports and unix sockets before connecting', async () => {
    const connect = createGuardedConnect({ resolver: async () => ['192.168.0.10'] });
    const lookup = guardedLookup(async () => ['192.168.0.10']);
    const res = await lookupAsync(lookup, 'rebind.example', {});
    expect(res.err.message).toMatch(/SSRF protection/);
    const port = await connectAsync(connect, { hostname: 'example.com', port: 6379, protocol: 'http:' });
    expect(port.err.message).toMatch(/SSRF protection: port 6379/);
    expect(port.socket).toBeNull();
    const unix = await connectAsync(connect, { hostname: 'x', port: 80, protocol: 'http:', socketPath: '/var/run/docker.sock' });
    expect(unix.err.message).toMatch(/SSRF protection/);
    const literal = await connectAsync(connect, { hostname: '169.254.169.254', port: 80, protocol: 'http:' });
    expect(literal.err.message).toMatch(/SSRF protection/);
  });

  it.each(['http://127.0.0.1:80/', 'http://localhost/', 'http://[::1]/'])(
    'the real dispatcher refuses internal target %s',
    async (url) => {
      // Guards against undici internals changing: the production dispatcher must enforce it.
      const dispatcher = createGuardedDispatcher();
      try {
        const err = await undiciFetch(url, { dispatcher }).then(
          () => null,
          (e) => e,
        );
        expect(err).not.toBeNull();
        expect(isSsrfBlock(err)).toBe(true);
      } finally {
        await dispatcher.close();
      }
    },
  );

  it('fetcher refuses a redirect to an internal address', async () => {
    const requested = [];
    const fetchImpl = async (url) => {
      requested.push(url);
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
    };
    const fetcher = new Fetcher(fetchImpl, fetcherConfig({ userAgent: 't' }));
    const result = await fetcher.fetch('https://example.com/go');
    expect(result.blockedRedirect).toBe('http://169.254.169.254/latest/');
    expect(requested).toEqual(['https://example.com/go']); // the metadata endpoint was never requested
    const err = await fetcher.fetch('http://10.0.0.1/').catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.message).toMatch(/SSRF/);
  });
});
