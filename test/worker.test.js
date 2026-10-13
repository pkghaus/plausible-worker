import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import worker from '../src/worker.js'

const SCRIPT_BODY = 'console.log("plausible")'
// Test hostnames are RFC 2606 reserved domains. They are only ever used as
// routing keys (the worker looks them up in PLAUSIBLE); the only fetch is to
// plausible.io, which the stub below answers.
const multiSiteConfig = {
  'example.com': 'https://plausible.io/js/pa-abc123.js',
  'example.net': 'https://plausible.io/js/pa-def456.js',
  'sub.example.net': 'https://plausible.io/js/pa-ghi789.js',
}
const testEnv = { PLAUSIBLE: JSON.stringify(multiSiteConfig) }

// plausible.io: one handler per "METHOD url". A request with no handler is
// recorded and fails the test, so it cannot pass as the 502 it turns into.
let upstream = {}
const unhandled = []
globalThis.fetch = async (input, init) => {
  // Node refuses a stream body without duplex; workerd needs no such option.
  const request = new Request(input, { ...init, duplex: 'half' })
  const handler = upstream[`${request.method} ${request.url}`]
  if (!handler) {
    unhandled.push(`${request.method} ${request.url}`)
    throw new TypeError('Failed to fetch')
  }
  return handler(request)
}

// Keyed by URL like the Cache API. Unlike workerd's it stores whatever it is
// given, whatever the cache-control.
const store = new Map()
globalThis.caches = {
  default: {
    async match(request) { return store.get(request.url)?.clone() },
    async put(request, response) { store.set(request.url, response.clone()) },
  },
}

beforeEach(() => {
  upstream = {}
  unhandled.length = 0
  store.clear()
})
afterEach(() => {
  assert.deepEqual(unhandled, [], 'every upstream request needs a handler')
})

const script = (body, headers = {}) => () =>
  new Response(body, { headers: { 'content-type': 'text/javascript', ...headers } })

async function callWorker(url, opts = {}, env = testEnv) {
  const tasks = []
  const response = await worker.fetch(new Request(url, opts), env, { waitUntil: (p) => tasks.push(p) })
  await Promise.all(tasks)
  return response
}

describe('routing', () => {
  it('returns 404 for unmatched paths', async () => {
    const response = await callWorker('https://example.com/')
    assert.equal(response.status, 404)
  })

  it('returns 404 for partial path matches', async () => {
    const response = await callWorker('https://example.com/zk/js/')
    assert.equal(response.status, 404)
  })
})

describe('GET /zk/js/script.js (no env var for host)', () => {
  it('returns 404 when hostname is not in PLAUSIBLE config', async () => {
    const response = await callWorker('https://unknown.example/zk/js/script.js', {}, { PLAUSIBLE: undefined })
    assert.equal(response.status, 404)
  })
})

describe('GET /zk/js/script.js', () => {
  it('proxies the plausible script for a known host', async () => {
    upstream['GET https://plausible.io/js/pa-abc123.js'] = script(SCRIPT_BODY)

    const response = await callWorker('https://example.com/zk/js/script.js')
    assert.equal(response.status, 200)
    assert.equal(await response.text(), SCRIPT_BODY)
  })

  it('returns 404 for an unknown host', async () => {
    const response = await callWorker('https://unknown.example/zk/js/script.js')
    assert.equal(response.status, 404)
  })

  // An upstream that ERRORS is different from one that answers 502: the fetch
  // itself throws, and unhandled that surfaced as a 500 from this Worker,
  // blaming us for plausible.io being down. The timeout reaches the same path.
  it('an upstream that throws is a 502, not an uncaught 500', async () => {
    upstream['GET https://plausible.io/js/pa-ghi789.js'] = () => {
      throw new TypeError('Failed to fetch')
    }

    const response = await callWorker('https://sub.example.net/zk/js/script.js')
    assert.equal(response.status, 502)
  })

  it('does not cache a failed upstream response', async () => {
    upstream['GET https://plausible.io/js/pa-abc123.js'] = () =>
      new Response('Bad Gateway', { status: 502 })

    const response = await callWorker('https://example.com/zk/js/script.js')
    assert.equal(response.status, 502)
    assert.equal(store.size, 0, 'a 502 must not be stored')
  })
})

describe('GET /zk/js/script.js (caching)', () => {
  it('serves a cache hit without calling upstream again', async () => {
    let upstreamCalls = 0
    upstream['GET https://plausible.io/js/pa-abc123.js'] = () => {
      upstreamCalls++
      return script(SCRIPT_BODY)()
    }

    const url = 'https://example.com/zk/js/script.js'

    // First request misses the cache and populates it from upstream.
    const first = await callWorker(url)
    assert.equal(first.status, 200)
    assert.equal(await first.text(), SCRIPT_BODY)
    assert.equal(upstreamCalls, 1)

    // Second identical request is served from caches.default, no new fetch.
    const second = await callWorker(url)
    assert.equal(second.status, 200)
    assert.equal(await second.text(), SCRIPT_BODY)
    assert.equal(upstreamCalls, 1)
  })
})

describe('GET /zk/js/script.js (multi-site)', () => {
  it('resolves correct script URL per hostname', async () => {
    upstream['GET https://plausible.io/js/pa-def456.js'] = script('net-script')

    const response = await callWorker('https://example.net/zk/js/script.js')
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'net-script')
  })

  it('resolves subdomain separately from parent domain', async () => {
    upstream['GET https://plausible.io/js/pa-ghi789.js'] = script('sub-script')

    const response = await callWorker('https://sub.example.net/zk/js/script.js')
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'sub-script')
  })

  it('preserves content-type from upstream', async () => {
    upstream['GET https://plausible.io/js/pa-abc123.js'] =
      script(SCRIPT_BODY, { 'content-type': 'application/javascript; charset=utf-8' })

    const response = await callWorker('https://example.com/zk/js/script.js')
    assert.equal(response.headers.get('content-type'), 'application/javascript; charset=utf-8')
  })
})

describe('GET /zk/js/script.js (PLAUSIBLE as object)', () => {
  it('works when env.PLAUSIBLE is a parsed object (wrangler.toml [vars.PLAUSIBLE])', async () => {
    upstream['GET https://plausible.io/js/pa-abc123.js'] = script(SCRIPT_BODY)

    const response = await callWorker('https://example.com/zk/js/script.js', {}, { PLAUSIBLE: multiSiteConfig })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), SCRIPT_BODY)
  })
})

describe('GET /zk/js/script.js (malformed PLAUSIBLE)', () => {
  it('returns 404 when PLAUSIBLE is invalid JSON', async () => {
    const response = await callWorker('https://example.com/zk/js/script.js', {}, { PLAUSIBLE: '{not json' })
    assert.equal(response.status, 404)
  })
})

describe('POST /zk/api/event', () => {
  it('forwards event to plausible.io', async () => {
    upstream['POST https://plausible.io/api/event'] = () => new Response('ok', { status: 202 })

    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ name: 'pageview', url: 'https://example.com/' }),
    })
    assert.equal(response.status, 202)
  })

  it('forwards event body intact', async () => {
    let receivedBody
    upstream['POST https://plausible.io/api/event'] = async (request) => {
      receivedBody = await request.text()
      return new Response('ok', { status: 202 })
    }

    const eventBody = JSON.stringify({ name: 'custom-event', url: 'https://example.com/page', props: { variant: 'A' } })
    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: eventBody,
    })
    assert.equal(response.status, 202)
    assert.equal(receivedBody, eventBody)
  })

  it('strips cookies from forwarded request', async () => {
    let receivedCookie
    upstream['POST https://plausible.io/api/event'] = (request) => {
      receivedCookie = request.headers.get('cookie')
      return new Response('', { status: 202 })
    }

    await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: 'session=abc' },
      body: JSON.stringify({ name: 'pageview' }),
    })
    assert.equal(receivedCookie, null)
  })

  it('passes through a non-2xx response from plausible.io', async () => {
    upstream['POST https://plausible.io/api/event'] = () => new Response('Bad Request', { status: 400 })

    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'pageview' }),
    })
    assert.equal(response.status, 400)
  })

  it('returns 405 for non-POST requests', async () => {
    const response = await callWorker('https://example.com/zk/api/event', {
      method: 'GET',
    })
    assert.equal(response.status, 405)
  })
})

// The real binding from wrangler.toml, not the fake one the routing tests
// inject. A host added to a page but never added here resolves to 404 on
// /zk/js/script.js, which from the page's side looks exactly like working
// analytics: the tag is present and nothing throws.
//
// Node has no TOML parser; this uses Python's tomllib, the one
// scripts/check-routes.py already reads this file with.
function deployedSites() {
  const read = spawnSync('python3', ['-I', '-c',
    'import json, sys, tomllib; print(json.dumps(tomllib.load(open(sys.argv[1], "rb"))["vars"]["PLAUSIBLE"]))',
    fileURLToPath(new URL('../wrangler.toml', import.meta.url))], { encoding: 'utf8' })
  assert.equal(read.status, 0, `reading wrangler.toml failed: ${read.error?.message ?? read.stderr}`)
  return JSON.parse(read.stdout)
}

describe('the deployed PLAUSIBLE config', () => {
  it('carries a script for every host the estate serves pages from', () => {
    const sites = deployedSites()
    for (const host of ['pkg.haus', 'apt.pkg.haus', 'buildinfos.pkg.haus', 'reproducible.pkg.haus']) {
      assert.match(sites[host] ?? '', /^https:\/\/plausible\.io\/js\/pa-/, host)
    }
  })

  it('gives each host its own script', () => {
    const urls = Object.values(deployedSites())
    assert.ok(urls.length > 0, 'PLAUSIBLE is empty')
    assert.equal(new Set(urls).size, urls.length)
  })
})
