# Security policy

This is development version 0.1.0 of a local DNS laboratory. It is not a production recursive resolver or an authenticated DNS service. Only this development line is in scope for fixes in this repository; no response-time or support SLA is promised.

Report vulnerabilities using [GitHub private vulnerability reporting](https://github.com/martinlofranodeoliveira/loopback-dns-cache-lab/security/advisories/new). Include the affected revision/version, minimal synthetic packet or scenario, expected/observed behavior and resource impact. Do not include credentials, real personal data or private client material. General contact is available through [Lofrano Tecnologia's official homepage](https://lofranotecnologia.com.br).

The intended boundary is an isolated loopback lab. Local malicious processes may interfere with UDP/TCP traffic or process resources. Source/port, ID and question matching do not authenticate the authority. There is no DNSSEC, encrypted transport, recursive resolution or remote-deployment support. Private IPC is inherited between owned processes and is not exposed as a network service.

Relevant issues include malformed packet acceptance, resource-bound bypass, stale or contradictory cache publication, non-loopback traffic, resolver invocation and incomplete child/socket cleanup. Keep proof-of-concept traffic restricted to synthetic fixtures and numeric loopback endpoints. Dependency updates must include codec review and the adversarial regression suite.
