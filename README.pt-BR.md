# Loopback DNS Cache Lab

Versão de desenvolvimento **0.1.0** — software original MIT da [Lofrano Tecnologia](https://lofranotecnologia.com.br).

Laboratório DNS autoritativo local, não um resolvedor recursivo. Cliente e autoridade executam em processos Node distintos, com portas efêmeras em `127.0.0.1` e controle privado por IPC. Demonstra cache positivo, chaves negativas da RFC 2308, expiração e fallback de UDP para TCP. Não consulta o resolvedor do sistema nem serviços DNS externos. Não contém telemetria ou dependência de modelo/API em execução. Todos os dados são sintéticos.

[English](README.md) · [Contrato detalhado](docs/contract.md) · [Projeto e fronteiras de confiança](docs/design.md)

## Instalação, testes e demonstração

Requer Node 22 ou posterior e npm. Somente a obtenção inicial das dependências precisa do registro npm:

```sh
npm ci --ignore-scripts
npm test
npm --silent run demo -- --assert
npm --silent run demo -- --json
```

O package-lock.json versionado foi gerado por uma instalação real do registry com scripts desativados. `npm ci --ignore-scripts` reproduz a seleção de dependências; instalação offline também exige o cache npm correspondente. Compilação, testes e demonstração usam dependências preparadas sem downloads.

Saída padrão exata no modo de asserções, em caso de sucesso:

```text
DEMO_OK scenarios=6
```

Os seis cenários são `positive-expiry`, `nxdomain-cross-type`, `nodata-type-isolation`, `udp-tcp-fallback`, `mismatch-and-malformed` e `uncached-negative`. O modo JSON imprime uma linha com `version`, `ok`, os seis nomes e `cleanup: {"liveChildren":0,"openServiceListeners":0}`. Esses contadores representam recursos pertencentes ao laboratório, não todos os serviços do computador. O pai aguarda o término dos filhos e verifica a liberação da porta UDP/TCP tentando vinculá-la novamente.

## Exemplo da biblioteca

Após `npm run build`:

```js
const { DnsLabClient } = require('./build/src');
const client = new DnsLabClient({ address: '127.0.0.1', port: 53001 });
async function exemplo() {
  const resposta = await client.query('a.example.test.', 'A', 0);
  console.log(resposta.status, resposta.addresses, resposta.ttlSeconds);
  console.log(client.inspectCounters());
  client.clearCache();
}
```

Esse trecho pressupõe uma autoridade iniciada explicitamente na porta 53001; não inicia o serviço. Para executar tudo com limpeza automática:

```js
const { withLab } = require('./build/lab/harness');
async function exemplo() {
  await withLab(async lab => {
    await lab.configure({ mode: 'positive' });
    const primeira = await lab.query('a.example.test', 'A', 0);
    const reutilizada = await lab.query('a.example.test', 'A', 1999);
    console.log(primeira.addresses, reutilizada.fromCache); // ['192.0.2.8'] true
  });
}
exemplo().catch(erro => { console.error(erro); process.exitCode = 1; });
```

`query(nome, tipo, nowMs)` retorna uma promessa. `nowMs` deve ser inteiro seguro não negativo e não pode retroceder entre chamadas admitidas, inclusive as que falham depois. É tempo lógico de cache, separado do prazo monotônico real de E/S. O prazo padrão de 500 ms abrange UDP e TCP juntos. `clearCache()` impede a publicação de consultas anteriores, mas não as cancela. `inspectCounters()` retorna cópia independente.

## Decisões e limites

O codec maduro `dns-packet` faz a codificação e decodificação. Antes dele, uma validação estrutural limitada verifica contagens, compressão de nomes, extensões reais dos registros, tamanhos A/AAAA, extensão SOA e bytes excedentes. Fixtures hexadecimais independentes evitam que um erro compartilhado entre codificador e decodificador fique invisível.

O LRU é limitado e determinístico. Sequências por nome e gerações de limpeza impedem que uma resposta NXDOMAIN antiga substitua uma resposta positiva mais recente. Há no máximo quatro consultas ativas; a quinta válida recebe `Busy` antes de alocar socket. A retenção começa no tempo lógico informado na admissão, e a publicação não retém dados já expirados.

São aceitos apenas rótulos ASCII de hostname e perguntas IN A/AAAA. Há dados de resposta IPv6, mas o transporte aceita somente `127.0.0.1`. Respostas devem ser autoritativas; os registros aceitos são A/AAAA em respostas e SOA na autoridade. Não há EDNS, aliases CNAME/DNAME, referrals, recursão, DNSSEC ou autenticação do resolvedor. TCP aceita um frame completo pelo prefixo de tamanho sem esperar EOF e depois fecha o socket, sem reutilizar conexões. Não se afirma conformidade geral com DNS nem prontidão para produção.

Correspondência de endereço, porta, ID e pergunta não autentica a origem. Um processo local hostil pode interferir. O ambiente esperado é um laboratório local isolado. Limites padrão: 4096 bytes UDP, 16384 bytes TCP, 32 registros, oito respostas divergentes ignoradas e 256 entradas de cache. Consulte as seções em português do contrato e do projeto para detalhes da API e da fronteira de confiança.

Contato geral: [site oficial](https://lofranotecnologia.com.br). Segurança: [relato privado de vulnerabilidade](https://github.com/martinlofranodeoliveira/loopback-dns-cache-lab/security/advisories/new).
