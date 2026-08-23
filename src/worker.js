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

async function getScript(request, url, env, ctx) {
  const scriptUrl = getScriptUrl(env, url.hostname)
  if (!scriptUrl) return new Response(null, { status: 404 })

  let response = await caches.default.match(request)
  if (!response) {
    response = await fetch(scriptUrl)
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
  return await fetch('https://plausible.io/api/event', {
    method: request.method,
    headers,
    body: request.body,
  })
}
