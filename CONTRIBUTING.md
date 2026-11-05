# Contributing

Use Node 22 or later. Install dependencies with `npm install --ignore-scripts`, then run:

```sh
npm test
npm --silent run demo -- --assert
npm --silent run demo -- --json
```

Preserve the real generated npm lockfile in a development checkout. For prepared offline environments, use the matching npm cache and lockfile. Do not add generated build output or installed dependencies to source changes.

Changes should preserve the documented 0.1.0 subset or explicitly propose a contract change in the issue/patch explanation. Add independent protocol fixtures when fixing wire parsing: a round trip through the same encoder is insufficient evidence. Add tests for boundaries and failure cleanup, not just success. Avoid nondeterministic sleeps for cache races; use the authority's hold/release barriers. Keep all fixtures synthetic and all network traffic on explicitly bound numeric loopback.

Do not add telemetry, external resolver calls, credentials, client data, runtime model dependencies, publish workflows or deployment workflows. Review resource caps, socket settlement, expiry arithmetic, admission and generation-state bounds for each change. Do not broaden compliance, security or performance claims without corresponding implementation and evidence.

Security findings belong in [GitHub private vulnerability reporting](https://github.com/martinlofranodeoliveira/loopback-dns-cache-lab/security/advisories/new), not public issues containing exploit-sensitive details. General organizational contact is through the [official homepage](https://lofranotecnologia.com.br).

Contributions must be original or appropriately licensed, with dependency notices preserved. Do not submit private client code or real personal data.
