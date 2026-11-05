# Contract / Contrato — development 0.1.0

## Public API

`new DnsLabClient(options)` requires `address: '127.0.0.1'` and integer `port: 1..65535`. No host resolver is consulted. IPv6 transport, other loopback addresses, hostnames and wildcard endpoints are rejected. Optional bounds may be reduced: `udpBytes` 512..4096 (default 4096), `tcpBytes` 512..16384 (default 16384), `cacheEntries` 1..256 (default 256). `deadlineMs` is an integer 1..10000 (default 500). Configuration is copied at construction.

* `query(name, type, nowMs): Promise<QueryResult>` supports `type: 'A' | 'AAAA'`, IN only. Names are case-insensitive ASCII hostname labels, 1..63 characters each, alphanumeric endpoints and internal alphanumeric/hyphen characters. One optional final dot is removed. Normalized length is at most 253. Root questions, underscores, escaped labels, IDNA conversion, wildcards and non-ASCII names are excluded.
* `nowMs` is an integer 0..Number.MAX_SAFE_INTEGER, globally nondecreasing among admitted queries, including failures. Equal times are allowed. Invalid input does not advance it. A Busy rejection does not advance it. There is no implicit wall-clock cache time.
* Four requests, including pending socket closure, may be admitted simultaneously. A fifth call receives `Busy` before normalization, clock advancement, cache lookup or socket allocation. Cache hits need no socket. There is no coalescing or cancellation API.
* `clearCache(): void` removes entries and fences all earlier in-flight publication. It does not reset logical time, counters or admission.
* `inspectCounters(): Counters` returns a new snapshot and purges entries expired at the latest admitted logical time. Mutating it cannot affect the client.

`QueryResult` fields: canonical `name`, requested `type`, `class: 'IN'`, `status: 'positive' | 'NXDOMAIN' | 'NODATA'`, detached `addresses: string[]`, `ttlSeconds`, `fromCache` and `transport: 'udp' | 'tcp' | 'cache'`. Negative addresses are empty. IPv6 address text is canonicalized using the Node URL IPv6 serializer. Answer order and duplicates are preserved. `ttlSeconds` is the original accepted minimum TTL, not a countdown and not proof of authenticity; uncachable negatives without an applicable SOA have TTL zero. A cross-type NXDOMAIN hit reports the caller's requested type.

## Acceptance and wire subset

The response endpoint/port, transaction ID, exact canonical question, type and IN class must match. Mismatched UDP sources or questions/IDs are ignored up to eight per request. A ninth mismatch fails `LimitExceeded` without increasing `ignoredResponses` beyond those eight. A wrong ID can be ignored without decoding its body; matching-ID malformed data fails immediately. TCP requires matching identity as well and fails on a mismatched single response.

Require QR=1, opcode=0, AA=1, rcode NOERROR or NXDOMAIN. TC is allowed on UDP and triggers one TCP exchange after bounded header, complete-question, identity and flags validation. Its remaining UDP body is discarded and may end inside an RR; it is never interpreted or cached. TCP TC is an error. RD may be echoed; RA, Z, AD and CD are rejected. There is no claim of DNSSEC validation. A/AAAA answers must have the exact question owner, class and requested type. No alias following or partial acceptance of a mixed RRset occurs. Authority records may only be SOA; additional records are not accepted. NS referrals, EDNS and unsupported rcodes fail rather than becoming NODATA.

Preflight requires QD=1, at most 32 total RRs, bounded name expansion and at most 16 compression traversals per name, backward pointers to encountered label boundaries, and ASCII hostname bytes in each physical label before dotted-text decoding. A literal dot inside one wire label is outside this subset. Complete non-TC UDP and TCP responses additionally require exact A=4/AAAA=16 RDLENGTH, exact SOA extent and no trailing DNS bytes. SOA names may use root; questions may not. This is a documented strict subset of DNS, not general standards compliance.

UDP uses an ephemeral explicitly bound IPv4 loopback source port. Normal IDs come from Node crypto; there is no public deterministic-ID option. TCP binds its local address explicitly and uses the same service port as UDP. Its unsigned two-byte length excludes the prefix itself. Prefix/body fragmentation is supported. Zero length, oversize, early EOF, TC, malformed framing and trailing frame bytes fail. The first complete response frame is accepted and the client closes its socket without waiting for peer EOF. Extra bytes already received beyond that frame fail; the client does not wait for future unsolicited frames or provide connection reuse. One real monotonic deadline spans all UDP work and TCP connection/framing; traffic never resets it.

## Cache

Positive key: `(normalized name, type, IN)`. TTL is the minimum of all accepted answer RR TTLs. Negative NXDOMAIN key: `(name, IN)` across types. NODATA key: `(name, type, IN)`. Negative TTL is `min(SOA TTL, SOA.MINIMUM)` from the closest applicable label ancestor. A suffix such as `example.test` is not an ancestor of `badexample.test`. Without an applicable SOA the negative is returned but not retained.

`expiresAt = admissionNowMs + ttlSeconds * 1000` must fit a safe integer or publication fails `LimitExceeded`. Zero TTL is never retained. Expiry is inclusive: `nowMs >= expiresAt`. Publication skips already-expired entries against the latest logical clock. NXDOMAIN invalidates same-name type entries; a positive or NODATA invalidates same-name NXDOMAIN. This invalidation also applies to accepted zero-TTL results. The entire result is interpreted before publication. Failures publish nothing. The newest admitted query for a name alone may publish, even if a newer query failed. Clear-generation fences also apply. LRU hits move an entry to the most-recent position; insertion evicts the oldest entry until within capacity. There is no unbounded generation history or persistent state.

## Counters and errors

* `logicalQueries`: valid admitted calls, including cache hits and eventual failures.
* `cacheHits`: calls served by cache.
* `udp`: datagram send attempts after binding, not received packets.
* `tcp`: fallback connection attempts, not chunks or messages received.
* `ignoredResponses`: mismatched datagrams/frames actually ignored, maximum eight for one request.
* `failures`: admitted queries that reject. Invalid input, clock regression and Busy are not included.
* `busyRejected`: immediate admission refusals.
* `active`, `openSockets`, `cacheEntries`, `generationEntries`: current owned requests, query sockets, retained entries and active-name fence records respectively.

`LabError.code` is one of `InvalidArgument`, `ClockRegression`, `Busy`, `DeadlineExceeded`, `DecodeError`, `ProtocolError`, `LimitExceeded`, `NetworkError`. Error message text is diagnostic, not a stable parsing interface. Socket errors are sanitized. On success or failure every query socket is explicitly closed/destroyed before its promise settles. Later calls can retry without restarting the client. Counter snapshots and result arrays are detached.

## Harness and demo

`withLab(async lab => ...)` starts separate authority and client children and always cleans them up. Methods are `configure({mode, ttl?, hold?})`, `query`, `inspect`, `clear`, `stats`, `release`; testing helpers also support startup failure injection and abrupt client exit. Scenario grammar is finite in `lab/protocol.ts`; TTL overrides are 0..60. `hold` snapshots at most eight response actions; `release` runs them FIFO. Silent mode sends nothing. Authority `udp`/`tcp` count parsed incoming queries; `answers` counts sent response messages, including wrong-ID fixtures. Counters do not imply successful client acceptance.

`npm --silent run demo -- --assert` compiles and asserts six scenarios, exits zero, and writes exactly `DEMO_OK scenarios=6\n` on stdout. `--json` instead writes one JSON line with version, scenario names, success and owned-resource cleanup counters. Failures write a diagnostic to stderr and exit nonzero. No network download occurs in either command after dependency preparation.

## Contrato da API (português)

A API pública expõe `DnsLabClient`, `query(nome, tipo, nowMs)`, `clearCache()` e `inspectCounters()`. O endereço deve ser exatamente `127.0.0.1`, com porta inteira 1..65535; nunca se consulta o resolvedor do sistema. Tipos aceitos: A e AAAA, classe IN. Nomes usam somente rótulos ASCII de hostname, sem escapes, curingas, sublinhados ou conversão IDNA. Bytes não ASCII são rejeitados antes da conversão de maiúsculas; um ponto final opcional é removido.

`nowMs` é inteiro seguro não negativo, globalmente não decrescente entre consultas admitidas. Não é o relógio de E/S. Quatro consultas podem estar ativas; a quinta recebe `Busy` antes de abrir socket ou consultar o cache. Limpar o cache não cancela consultas nem reinicia tempo ou contadores. Resultados e inspeções são cópias independentes.

O resultado informa nome, tipo, classe, estado `positive`, `NXDOMAIN` ou `NODATA`, endereços, TTL original em segundos, `fromCache` e transporte. NXDOMAIN compartilha cache entre tipos; NODATA é específico por tipo. TTL positivo é o mínimo do RRset. TTL negativo é o mínimo entre TTL do SOA e MINIMUM, somente com SOA ancestral por rótulos. Sem SOA aplicável, o negativo é retornado sem retenção. TTL zero nunca é retido. Expiração ocorre quando `nowMs >= expiresAt`, desde a admissão; soma insegura falha com `LimitExceeded`.

Respostas precisam corresponder a endereço, porta, ID e pergunta canônica IN. Até oito divergências são ignoradas; a nona encerra a consulta. Exigem-se QR, opcode padrão, AA e NOERROR/NXDOMAIN. UDP com TC usa TCP uma única vez, dentro do mesmo prazo monotônico padrão de 500 ms. UDP com TC exige cabeçalho e pergunta completos e coerentes, mas descarta o corpo cortado antes do fallback. TCP fragmentado é aceito assim que um frame completo chega, sem esperar EOF; TC, bytes extras já recebidos e dados DNS malformados são rejeitados. A consulta fecha a conexão após o frame. Pontos literais dentro de um único rótulo no wire são rejeitados antes da decodificação textual. Aliases, referrals, EDNS, registros adicionais e flags de recursão/segurança fora do subconjunto são rejeitados. Essas verificações não autenticam a origem nem validam DNSSEC.

Falhas usam `LabError.code`; o texto da mensagem não é interface estável. Falha de prazo, limite, protocolo ou decodificação não publica respostas. Os sockets pertencentes à consulta são fechados antes da promessa terminar. Sequências por nome e tokens de limpeza impedem publicação atrasada; não se guarda histórico ilimitado. O LRU limitado usa ordem determinística e a implementação mantém somente estado em memória.
