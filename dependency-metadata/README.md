# Dependency and primary-source record

Development 0.1.0 uses the following exact direct versions:

| Package | Version | Role | License |
| --- | --- | --- | --- |
| dns-packet | 5.6.1 | runtime wire codec | MIT |
| typescript | 5.9.3 | development compiler | Apache-2.0 |
| @types/node | 22.20.5 | development declarations | MIT |
| @types/dns-packet | 5.6.5 | development declarations | MIT |

Inspection of the official npm `dns-packet` 5.6.1 source identified permissive behavior about declared address/SOA RDLENGTH and header counts. The implementation therefore does not treat `decode()` success or `decode.bytes` as a framing validator. The name codec is reused only after bounded pointer/extent checks. No third-party implementation source is copied into the project.

The official-registry integrity value for `dns-packet` 5.6.1 is:

```text
sha512-l4gcSouhcgIKRvyy99RNVOgxXiicE+2jZoNmaNmZ6JXiGajBOJAesk1OBlJuM5k2c+eudGdLxDqXuPCKIj6kpw==
```

The committed package-lock.json was generated from the official npm registry using npm install --ignore-scripts. It records the resolved direct and transitive dependency versions and integrity values; it is not a hand-written approximation. Keep the corresponding npm cache for offline npm ci. Installed dependency notices retain their respective licenses. The local Node 22.23.4 environment compiled the strict TypeScript sources and ran the offline tests; this is not a claim that hosted CI has executed.

## Primary references and applied rules

* [RFC 1035](https://www.rfc-editor.org/rfc/rfc1035), sections 3.2.1, 3.3.13, 4.1 and 4.2.2: RR extents, SOA fields, compressed names, headers and TCP's two-byte length excluding itself.
* [RFC 2308](https://www.rfc-editor.org/rfc/rfc2308), sections 3 and 5: applicable SOA, negative TTL as the minimum of SOA TTL and MINIMUM, distinct NXDOMAIN/NODATA keys.
* [RFC 5452](https://www.rfc-editor.org/rfc/rfc5452), section 9: source endpoint, ID and exact question matching. Matching is not cryptographic authentication.
* [dns-packet source](https://github.com/mafintosh/dns-packet) and the published [5.6.1 registry artifact](https://registry.npmjs.org/dns-packet/-/dns-packet-5.6.1.tgz): mature codec, wrapped with structural guards rather than replaced.
* [Node 22 dgram documentation](https://nodejs.org/docs/latest-v22.x/api/dgram.html): explicit local bind, remote-info checks and owned-socket close lifecycle.

These references define the implemented subset. They do not establish general DNS compliance. Dependency upgrades require repeating wire-fixture and adversarial tests, reviewing codec source changes and regenerating the real lockfile.
