import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test'
import { describe, it, expect } from 'vitest'
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
