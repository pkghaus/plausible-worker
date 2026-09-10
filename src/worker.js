const ScriptName = '/zk/js/script.js'
const Endpoint = '/zk/api/event'
const ScriptWithoutExtension = ScriptName.replace('.js', '')

function getScriptUrl(env, hostname) {
  const raw = env.PLAUSIBLE
  if (!raw) return null
  try {
    const scripts = typeof raw === 'string' ? JSON.parse(raw) : raw
    return scripts[hostname] || null
  } catch {
    return null
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
    const [baseUri] = url.pathname.split('.')

    if (baseUri.endsWith(ScriptWithoutExtension)) {
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
const UPSTREAM_TIMEOUT_MS = 10_000

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
      method: request.method,
      headers,
      body: request.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (e) {
    console.error('plausible event post failed:', e?.message ?? e)
    return new Response(null, { status: 502 })
  }
}
