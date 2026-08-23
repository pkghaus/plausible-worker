# plausible-worker

Cloudflare Worker proxying [Plausible Analytics](https://plausible.io) for
[pkg.haus](https://pkg.haus) and [apt.pkg.haus](https://apt.pkg.haus), so the
tracker is served first-party from `/zk/` instead of a third-party host.

## Why this exists separately

The same worker runs in another Cloudflare account for unrelated domains.
Workers routes cannot reference a script that lives in a different account, so
the account owning the `pkg.haus` zone needs its own deployment. The two are
independent: a request is proxied by exactly one of them, so there is no
double-counting.

## What it does

* `GET /zk/js/script.js` returns the Plausible script for the requesting
  hostname, cached at the edge.
* `POST /zk/api/event` forwards events to Plausible with the cookie header
  stripped.
* Anything else under the route returns 404.

Adding a hostname means adding an entry under `[vars.PLAUSIBLE]` and a
`[[routes]]` entry, then redeploying.

## Development

```bash
npm install
npm test
npx wrangler dev
```

`master` deploys on push; pull requests run the tests only.

## License

```
Copyright (c) 2026 pkg.haus

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

   http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

See [LICENSE](LICENSE) for the full Apache-2.0 text.

## Buy us a coffee?

If you feel like buying us a coffee (or a beer?), donations are welcome:

```
BTC : bc1qq04jnuqqavpccfptmddqjkg7cuspy3new4sxq9
DOGE: DRBkryyau5CMxpBzVmrBAjK6dVdMZSBsuS
ETH : 0x2238A11856428b72E80D70Be8666729497059d95
LTC : MQwXsBrArLRHQzwQZAjJPNrxGS1uNDDKX6
```
