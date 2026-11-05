# Changelog

## 0.1.0 — Unreleased

Development version; no release or deployment claim.

* Add loopback-only IN A/AAAA client with bounded UDP/TCP transport and one monotonic deadline.
* Add structural preflight around dns-packet, independent malformed wire fixtures and explicit authoritative-response semantics.
* Add positive/NXDOMAIN/NODATA cache, inclusive expiry, deterministic bounded LRU and concurrent publication fences.
* Add separate-process authority/client harness with private scenario IPC and explicit teardown/rebind verification.
* Add six-scenario offline demo with assertion and JSON output modes.
* Add regression/adversarial tests and English/Portuguese usage and trust-boundary documentation.

### Corrected

* Retry matched UDP TC responses over TCP even when an RR body is cut off, while keeping complete-response structural validation.
* Accept complete TCP frames without requiring peer EOF.
* Reject non-ASCII input before case conversion and validate physical hostname-label bytes before dotted-name decoding.
* Record the real npm lockfile and isolated protocol regression evidence.
* Select single-label SOA ancestors ahead of root, reject root wire questions and validate TCP header-length prefixes before awaiting a body.
