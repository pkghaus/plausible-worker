// The tag on every page requests /zk/js/script.js. The match below is on the
// extension-less prefix, so Plausible's variant loaders (script.hash.js,
// script.outbound-links.js) resolve to the same per-host entry. Spelling it
// directly beats deriving it: reading .replace('.js', '') right meant knowing
// String.replace hits only the first occurrence, in a path built out of the
// substring it searches for.
const ScriptPathPrefix = '/zk/js/script'
const Endpoint = '/zk/api/event'

// Ten seconds. An upstream that hangs must not hold a request open until the
// platform kills it; a failed script tag costs analytics, not the page.
const UPSTREAM_TIMEOUT_MS = 10_000

function getScriptUrl(env, hostname) {
  const raw = env.PLAUSIBLE
  if (!raw) {
    console.error('PLAUSIBLE binding is absent; no host can resolve a script')
    return null
  }
  let scripts
  try {
    scripts = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch (e) {
    console.error('PLAUSIBLE binding is not valid JSON:', e?.message ?? e)
    return null
  }
  // Optional chaining, not a plain index: JSON.parse('null') yields null and
  // indexing it throws, which the original's wider try/catch absorbed into
  // the same 404 as everything else.
  const scriptUrl = scripts?.[hostname] || null
  if (!scriptUrl) {
    // Half of a two-sided silent failure. The other half is a missing
    // <host>/zk/* route, which never reaches this Worker at all. A host added
    // to a page but to neither list looks exactly like working analytics.
    console.error(`PLAUSIBLE has no script for host ${hostname}`)
  }
  return scriptUrl
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const [baseUri] = url.pathname.split('.')

    if (baseUri.endsWith(ScriptPathPrefix)) {
      return getScript(request, url, env, ctx)
    } else if (url.pathname.endsWith(Endpoint)) {
      return postData(request)
    }

    return new Response(null, { status: 404 })
  },
}

// Analytics must never be the reason a page hangs. Neither subrequest had a
// deadline, so an unresponsive upstream held the request open for as long as
// the runtime allowed and the visitor's page waited on a script tag. Ten
// seconds rather than the house default of thirty: nothing here is worth a
// visible stall, and a lost pageview costs nothing anyone can see.
async function getScript(request, url, env, ctx) {
  const scriptUrl = getScriptUrl(env, url.hostname)
  if (!scriptUrl) return new Response(null, { status: 404 })

  let response = await caches.default.match(request)
  if (!response) {
    try {
      response = await fetch(scriptUrl, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (e) {
      // A throw here was uncaught and surfaced as a 500 from this Worker,
      // which reads as our fault rather than the upstream's. 502 says which
      // side failed, and the browser treats a failed script tag the same way
      // either: no analytics, page unaffected.
      console.error('plausible script fetch failed:', e?.message ?? e)
      return new Response(null, { status: 502 })
    }
    if (response.ok) {
      ctx.waitUntil(caches.default.put(request, response.clone()))
    }
  }
  return response
}

async function postData(request) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405 })
  }
  const headers = new Headers(request.headers)
  headers.delete('cookie')
  try {
    return await fetch('https://plausible.io/api/event', {
      method: 'POST',
      headers,
      body: request.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('plausible event post failed:', e?.message ?? e)
    return new Response(null, { status: 502 })
  }
}
