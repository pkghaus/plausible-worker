import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from './test-server.js'
import worker from './worker.js'

const SCRIPT_BODY = 'console.log("plausible")'
// Test hostnames are RFC 2606 reserved domains. They are only ever used as
// routing keys (the worker looks them up in PLAUSIBLE); the only real fetch is
// to plausible.io, which msw intercepts. Each test that exercises the cache
// uses its own hostname so cache keys never collide across tests.
const multiSiteConfig = {
  'example.com': 'https://plausible.io/js/pa-abc123.js',
  'example.net': 'https://plausible.io/js/pa-def456.js',
  'sub.example.net': 'https://plausible.io/js/pa-ghi789.js',
  'cache.example': 'https://plausible.io/js/pa-cache.js',
}
const testEnv = {
  ...env,
  PLAUSIBLE: JSON.stringify(multiSiteConfig),
}

async function callWorker(url, opts = {}) {
  const request = new Request(url, opts)
  const ctx = createExecutionContext()
  const response = await worker.fetch(request, testEnv, ctx)
  await waitOnExecutionContext(ctx)
  return response
}

describe('routing', () => {
  it('returns 404 for unmatched paths', async () => {
    const response = await callWorker('https://example.com/')
    expect(response.status).toBe(404)
  })

  it('returns 404 for partial path matches', async () => {
    const response = await callWorker('https://example.com/zk/js/')
    expect(response.status).toBe(404)
  })
})

describe('GET /zk/js/script.js (no env var for host)', () => {
  it('returns 404 when hostname is not in PLAUSIBLE config', async () => {
    const request = new Request('https://unknown.example/zk/js/script.js')
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, { ...env, PLAUSIBLE: undefined }, ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(404)
  })
})

describe('GET /zk/js/script.js', () => {
  it('proxies the plausible script for a known host', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-abc123.js', () => {
        return new HttpResponse(SCRIPT_BODY, {
          headers: { 'content-type': 'text/javascript' },
        })
      })
    )

    const response = await callWorker('https://example.com/zk/js/script.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(SCRIPT_BODY)
  })

  it('returns 404 for an unknown host', async () => {
    const response = await callWorker('https://unknown.example/zk/js/script.js')
    expect(response.status).toBe(404)
  })

  // An upstream that ERRORS is different from one that answers 502: the fetch
  // itself throws, and unhandled that surfaced as a 500 from this Worker,
  // blaming us for plausible.io being down. The timeout added alongside this
  // reaches the same path.
  //
  // The rejection is injected by replacing fetch rather than with msw's
  // HttpResponse.error(). That helper makes its interceptor reject a promise
  // nothing awaits, so vitest counts an unhandled error and fails the run
  // with all tests passing, which is a confusing way to assert this.
  it('an upstream that throws is a 502, not an uncaught 500', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')))
    try {
      const response = await callWorker('https://sub.example.net/zk/js/script.js')
      expect(response.status).toBe(502)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not cache a failed upstream response', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-abc123.js', () => {
        return new HttpResponse('Bad Gateway', { status: 502 })
      })
    )

    const response = await callWorker('https://example.com/zk/js/script.js')
    expect(response.status).toBe(502)
  })
})

describe('GET /zk/js/script.js (caching)', () => {
  it('serves a cache hit without calling upstream again', async () => {
    let upstreamCalls = 0
    server.use(
      http.get('https://plausible.io/js/pa-cache.js', () => {
        upstreamCalls++
        return new HttpResponse(SCRIPT_BODY, {
          headers: {
            'content-type': 'text/javascript',
            'cache-control': 'public, max-age=86400',
          },
        })
      })
    )

    const url = 'https://cache.example/zk/js/script.js'

    // First request misses the cache and populates it from upstream.
    const first = await callWorker(url)
    expect(first.status).toBe(200)
    expect(await first.text()).toBe(SCRIPT_BODY)
    expect(upstreamCalls).toBe(1)

    // Second identical request is served from caches.default, no new fetch.
    const second = await callWorker(url)
    expect(second.status).toBe(200)
    expect(await second.text()).toBe(SCRIPT_BODY)
    expect(upstreamCalls).toBe(1)
  })
})

describe('GET /zk/js/script.js (multi-site)', () => {
  it('resolves correct script URL per hostname', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-def456.js', () => {
        return new HttpResponse('net-script', {
          headers: { 'content-type': 'text/javascript' },
        })
      })
    )

    const response = await callWorker('https://example.net/zk/js/script.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('net-script')
  })

  it('resolves subdomain separately from parent domain', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-ghi789.js', () => {
        return new HttpResponse('sub-script', {
          headers: { 'content-type': 'text/javascript' },
        })
      })
    )

    const response = await callWorker('https://sub.example.net/zk/js/script.js')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('sub-script')
  })

  it('preserves content-type from upstream', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-abc123.js', () => {
        return new HttpResponse(SCRIPT_BODY, {
          headers: { 'content-type': 'application/javascript; charset=utf-8' },
        })
      })
    )

    const response = await callWorker('https://example.com/zk/js/script.js')
    expect(response.headers.get('content-type')).toBe('application/javascript; charset=utf-8')
  })
})

describe('GET /zk/js/script.js (PLAUSIBLE as object)', () => {
  it('works when env.PLAUSIBLE is a parsed object (wrangler.toml [vars.PLAUSIBLE])', async () => {
    server.use(
      http.get('https://plausible.io/js/pa-abc123.js', () => {
        return new HttpResponse(SCRIPT_BODY, {
          headers: { 'content-type': 'text/javascript' },
        })
      })
    )

    const objectEnv = { ...env, PLAUSIBLE: multiSiteConfig }
    const request = new Request('https://example.com/zk/js/script.js')
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, objectEnv, ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe(SCRIPT_BODY)
  })
})

describe('GET /zk/js/script.js (malformed PLAUSIBLE)', () => {
  it('returns 404 when PLAUSIBLE is invalid JSON', async () => {
    const badEnv = { ...env, PLAUSIBLE: '{not json' }
    const request = new Request('https://example.com/zk/js/script.js')
    const ctx = createExecutionContext()
    const response = await worker.fetch(request, badEnv, ctx)
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(404)
  })
})

describe('POST /zk/api/event', () => {
  it('forwards event to plausible.io', async () => {
    server.use(
      http.post('https://plausible.io/api/event', () => {
        return new HttpResponse('ok', { status: 202 })
      })
    )

    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ name: 'pageview', url: 'https://example.com/' }),
    })
    expect(response.status).toBe(202)
  })

  it('forwards event body intact', async () => {
    server.use(
      http.post('https://plausible.io/api/event', () => {
        return new HttpResponse('ok', { status: 202 })
      })
    )

    const eventBody = JSON.stringify({ name: 'custom-event', url: 'https://example.com/page', props: { variant: 'A' } })
    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody,
    })
    // If the body wasn't forwarded, plausible.io would reject it.
    // We verify the round-trip succeeds (202) as evidence the body was passed through.
    expect(response.status).toBe(202)
  })

  it('strips cookies from forwarded request', async () => {
    let receivedCookie
    server.use(
      http.post('https://plausible.io/api/event', ({ request }) => {
        receivedCookie = request.headers.get('cookie')
        return new HttpResponse('', { status: 202 })
      })
    )

    await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ name: 'pageview' }),
    })
    expect(receivedCookie).toBeNull()
  })

  it('passes through a non-2xx response from plausible.io', async () => {
    server.use(
      http.post('https://plausible.io/api/event', () => {
        return new HttpResponse('Bad Request', { status: 400 })
      })
    )

    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pageview' }),
    })
    expect(response.status).toBe(400)
  })

  it('returns 405 for non-POST requests', async () => {
    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'GET',
    })
    expect(response.status).toBe(405)
  })
})

// The real binding from wrangler.toml, not the fake one the routing tests
// inject. A host added to a page but never added here resolves to 404 on
// /zk/js/script.js, which from the page's side looks exactly like working
// analytics: the tag is present and nothing throws.
describe('the deployed PLAUSIBLE config', () => {
  const sites = typeof env.PLAUSIBLE === 'string' ? JSON.parse(env.PLAUSIBLE) : env.PLAUSIBLE

  it('carries a script for every host the estate serves pages from', () => {
    for (const host of ['pkg.haus', 'apt.pkg.haus', 'buildinfos.pkg.haus']) {
      expect(sites[host], host).toMatch(/^https:\/\/plausible\.io\/js\/pa-/)
    }
  })

  it('gives each host its own script', () => {
    const urls = Object.values(sites)
    expect(new Set(urls).size).toBe(urls.length)
  })
})
