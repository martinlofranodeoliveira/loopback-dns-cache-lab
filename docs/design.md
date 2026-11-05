# Design / Projeto — development 0.1.0

## Architecture

`src/index.ts` is the public library entry point. `client.ts` performs admission, canonicalization, clock checking, cache lookup and atomic publication. `transport.ts` owns every query socket. `wire.ts` wraps the MIT `dns-packet` codec, and `result.ts` applies the deliberately narrow authoritative-response semantics. `cache.ts` contains a bounded Map-based LRU.

The parent harness forks an authority, waits for readiness, then forks a client with the numeric service endpoint. UDP is bound on ephemeral `127.0.0.1`; TCP binds the same port. Only `EADDRINUSE` during pair allocation permits a new ephemeral allocation, with three attempts maximum. There are no protocol retries except the specified UDP-TC-to-TCP transition. Child stdout is ignored; bounded stderr is retained only for diagnostics. IPC has a small command vocabulary, 2048-character requests, at most 16 pending parent requests and bounded command deadlines. It is an inherited private channel, not a network control service.

The server snapshots scenarios when each query arrives. Its hold/release barrier makes cache-race tests independent of arbitrary sleeps. It bounds held replies, live TCP peers, framing, idle connections and scheduled fragment timers. A client shutdown waits for admitted requests. Server shutdown clears barriers/timers and closes sockets. The parent requests graceful shutdown, escalates to termination if necessary, awaits child exit, and rebinds its owned service port before reporting it released. Tests exercise normal completion, body errors, partial startup, abrupt child exit and shutdown with pending queries. The registry does not inspect undocumented Node handles or claim absence of unrelated host listeners.

## Structural preflight

A successful codec decode is not strict validation. The wrapper checks the 12-byte header before codec allocation, requires one question, and caps the sum of all RR counts at 32. It walks physical question/RR framing and uses the codec's `name.decode` for actual name decoding. The traversal guard is not an alternative name decoder: it verifies physical label extents, backward pointers to previously encountered label boundaries, a maximum of 16 pointer traversals, expanded-name bounds and physical consumed bytes. Forward pointers, cycles, extended labels and unsupported hostname bytes fail.

Every RR has a checked RDLENGTH before full decoding. A is exactly four bytes; AAAA exactly sixteen. SOA has two guarded names followed by exactly twenty bytes. Only IN A/AAAA/SOA records pass preflight; semantic validation further restricts sections and owners. The packet must end at the exact final RR extent. Independent hex fixtures test decoder weaknesses, not merely codec round trips. Rejecting some otherwise usable DNS messages is intentional for this subset.

## Clocks and publication

The cache clock is caller supplied, safe-integer, nonnegative and nondecreasing at admission. A real `performance.now()` deadline is captured separately and passed through UDP and TCP; garbage, fragmentation and fallback do not reset it. Socket closure is part of settling the admitted request. Clearing does not release slots. Cache hits also participate in the per-name admission sequence.

Publication requires the original clear-generation token and the newest admitted sequence for the name. Active-name state remains until the last request for that name settles. Thus an older NXDOMAIN cannot replace newer positive data, including when the newer request has already completed. A newer failed admission conservatively fences older publication too. A fresh Symbol fences all in-flight responses on clear. No per-name tombstones survive settlement; history is bounded by four admitted requests. Cache storage is separately bounded to 256 entries. Sequence exhaustion is an explicit limit error rather than integer wraparound.

Publication computes safe expiry before modifying entries. TTL starts at admission, not receive time. Entries already expired against the latest logical clock are skipped. Contradictory NXDOMAIN and type-specific data are invalidated atomically, even for accepted zero-TTL results. Map order implements deterministic least-recently-used eviction. Cached values and inspection results are detached from callers.

## Trust boundary

This is a local service fixture, not an authenticated resolver. Both transport endpoints are numeric IPv4 loopback; no wildcard binding or hostname resolution is used. IDs use Node crypto normally; deterministic IDs appear only in internal tests. Source/port, ID, canonical question/class/type, QR/opcode/AA/rcode/TC and supported owners are checked. These checks mitigate accidental or blind mismatches but do not establish origin authenticity. No DNSSEC validation, recursive correctness, production availability or hostile-host isolation is asserted.

## Projeto e fronteira de confiança (português)

A biblioteca separa admissão/cache, transporte, validação estrutural e interpretação. O pai inicia autoridade e cliente em processos distintos; todos os sockets usam explicitamente `127.0.0.1`. O controle usa IPC herdado, com vocabulário e filas limitados, sem serviço de controle na rede. A limpeza aguarda os filhos e verifica a liberação da porta pertencente ao laboratório.

O codec não define sozinho a fronteira de confiança. Antes da decodificação completa, verificam-se contagens, limites físicos, ponteiros de compressão para trás, profundidade, RDLENGTH A/AAAA/SOA e consumo integral. Nomes são decodificados pela biblioteca, não por um decodificador alternativo. Fixtures independentes exercitam dados deliberadamente inválidos.

Tempo lógico de cache e prazo real monotônico são independentes. O TTL começa na admissão. Tokens de limpeza e sequências por nome impedem publicação antiga; os registros dessas sequências existem somente enquanto há consultas ativas. Limpar não cancela consultas nem libera vagas antes do fechamento dos sockets.

Um processo local hostil continua fora da hipótese de confiança. Validar endereço, porta, ID e pergunta não autentica a resposta. Não há recursão, DNSSEC, autenticação ou promessa de uso em produção. A restrição a um subconjunto é intencional e documentada, não uma afirmação de conformidade geral.
