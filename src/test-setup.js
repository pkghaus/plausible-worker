import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./test-server.js";

// Name the request before msw swallows its identity.
//
// onUnhandledRequest: "error" makes msw reject an unmatched request with a bare
// "TypeError: Failed to fetch" built by its own createNetworkError, so the
// stack is entirely inside @mswjs/interceptors and names neither a URL nor a
// test. When such a rejection outlives the test that started it, Vitest reports
// one unhandled error, every test still passes, and the run fails with nothing
// to act on - which is how a deploy failed here once, and why nothing could be
// learned from it afterwards. It has not reproduced locally on the same
// lockfile, so the next occurrence is the only chance to see it.
//
// These listeners cost nothing on a green run and turn that into a URL.
server.events.on("request:unhandled", ({ request }) => {
  console.error(`msw: no handler for ${request.method} ${request.url}`);
});
server.events.on("unhandledException", ({ error, request }) => {
  console.error(
    `msw: handler threw for ${request.method} ${request.url}: ${error.message}`
  );
});

beforeAll(() =>
  server.listen({
    onUnhandledRequest: "error",
  })
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
