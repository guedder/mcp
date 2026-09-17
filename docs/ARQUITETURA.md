# Arquitetura do `@guedder/mcp`

> Guia de reimplementação. Quem ler este documento inteiro deve conseguir
> reconstruir o servidor do zero, com as mesmas propriedades, sem ter visto o
> código. Os **porquês** das decisões estruturais estão nos ADRs em
> `docs/adr/`; aqui está **o que** o servidor faz e **como** as peças se
> encaixam.
>
> Documento mestre de contexto (fora deste repo): ADR 0001 do repo `auth`,
> seção 9 (`auth/docs/adr/0001-guedder-auth-oidc-design.md`). Ele registra a
> história da delegação de identidade, do consent adiado e do gatilho que fez
> o consent existir (§9.11). Este repo não repete aquelas decisões, referencia.

---

## 1. O que é

`@guedder/mcp` é um servidor **MCP (Model Context Protocol)** em TypeScript
sobre a **API v3 da Guedder** (plataforma de venda de ingressos). Ele existe
para que um agente de IA aja **em nome de uma pessoa logada na Guedder**, com
um login só, sem que ela precise de credencial AWS e sem que o agente receba
mais do que ela concedeu.

| | |
|---|---|
| Pacote | `@guedder/mcp` (`bin: guedder-mcp`) |
| Repositório | `github.com/guedder/mcp` (checkout local: `guedder-ops-mcp`) |
| Transporte padrão | Streamable HTTP, stateless |
| Imagem | `ghcr.io/guedder/mcp:main` (multi-arch, publicada por GitHub Actions) |
| No ar (staging) | `https://mcp.dev.services.guedder.com/mcp` |
| Authorization Server | AWS Cognito User Pool de staging (`us-east-1_UhlIAqn5b`), com este servidor como front door |
| Distribuição | MCP bundlado no plugin Claude Code `guedder` (repo `guedder/claude-plugins`, `plugins/guedder/.mcp.json`) |

Três públicos, em ordem de aparecimento histórico:

1. **Suporte interno** (v1): correlacionar uma compra com log e trace na AWS.
2. **Comprador** (v2): consultar eventos e a própria conta, e cancelar um
   pedido próprio.
3. **Agente público sem login** (`GUEDDER_MCP_PUBLIC_ONLY=1`): só as tools de
   evento, sem token nenhum.

### O que ele deliberadamente não é

- Não é um proxy genérico da API. Cada tool chama **um** endpoint fixo; não
  existe `apiRequest(metodo, path)` (ADR 0003).
- Não reimplementa regra de negócio. Janela de cancelamento, dono do pedido e
  ingresso já bipado continuam sendo da API.
- Não guarda credencial de usuário, não faz login por senha e não mantém
  sessão em memória.

---

## 2. Stack e forma do repositório

```
src/
  index.ts           servidor HTTP, roteamento OAuth, tela de consent, registro de tools
  auth.ts            verificação de token, escopos, documentos de discovery
  auditoria.ts       consulta ao CloudWatch Logs Insights (tool de rastreio)
  openapi-v3.json    recorte da spec OpenAPI v3, gerado por scripts/sync-openapi-v3.mjs
scripts/
  sync-openapi-v3.mjs  baixa e recorta a spec da API
test/                  node:test (ver seção 12)
infra/
  task-policy.json   política IAM mínima da task (referência; o Terraform vive no repo infra)
  README.md
skills/                skills Claude (formato SKILL.md)
docs/
  ARQUITETURA.md     este documento
  adr/               decisões deste repo
```

Dependências de runtime, e por que cada uma:

| Pacote | Papel |
|---|---|
| `@modelcontextprotocol/sdk` | `McpServer`, `StreamableHTTPServerTransport`, `StdioServerTransport` |
| `jose` | verificação JWT com JWKS remoto (cache e rotação por conta da lib) |
| `zod` | schemas de entrada e saída das tools |
| `@aws-sdk/client-cloudwatch-logs` | Logs Insights, só para a tool de auditoria |

Node >= 20, TypeScript `module: NodeNext`, `strict: true`, saída em `dist/`.
O build copia `src/openapi-v3.json` para `dist/` (o servidor lê o arquivo ao
lado do próprio módulo).

---

## 3. Ciclo de vida de um request

O servidor é **stateless por decisão**: cada request HTTP no caminho do MCP
cria um `McpServer` e um `StreamableHTTPServerTransport` novos
(`sessionIdGenerator: undefined`). Não há sessão em memória, o que permite mais
de uma réplica atrás do ALB sem sticky session.

```
requisição HTTP
  ├─ /.well-known/oauth-protected-resource  → metadata RFC 9728            (só com AUTH)
  ├─ /.well-known/oauth-authorization-server→ metadata RFC 8414 espelhada  (só com AUTH)
  ├─ GET  /authorize                        → tela de consent ou 302 ao Cognito
  ├─ POST /register                         → DCR mascarado (RFC 7591)
  ├─ POST /token                            → repasse ao /token do Cognito
  ├─ GET|outros /token,/register            → 405 com `Allow: POST`
  ├─ <GUEDDER_MCP_PATH> (padrão /mcp)       → verifica token → cria servidor MCP → transport
  └─ qualquer outro                         → 404 JSON
```

Toda resposta gera uma linha de log em `stderr` (`MÉTODO caminho ?query ->
status (ms)`). Nos endpoints de OAuth a query entra no log com `code`,
`code_verifier`, `client_secret` e `refresh_token` **redigidos**: o container
loga no CloudWatch, que tem retenção e leitores diferentes de quem está
depurando.

### Modo stdio

`GUEDDER_MCP_TRANSPORT=stdio` sobe o mesmo conjunto de tools sem nenhuma camada
HTTP. Nesse modo **não existe `caller`**: o token da API vem estático de
`GUEDDER_BEARER_TOKEN` e o portão de admin da auditoria fecha sempre. Serve
para smoke e cliente local legado, não para testar autenticação.

---

## 4. Configuração (variáveis de ambiente)

| Variável | Padrão | O que faz |
|---|---|---|
| `GUEDDER_API_BASE` | `https://api.guedder.com` | Base da API Guedder. |
| `GUEDDER_MCP_TRANSPORT` | `streamable-http` | Ou `stdio`. Qualquer outro valor aborta o boot. |
| `GUEDDER_MCP_HOST` | `127.0.0.1` | **Em contêiner tem que ser `0.0.0.0`.** O padrão em Fargate dá health check eternamente vermelho sem nenhum erro no log. |
| `GUEDDER_MCP_PORT` | `3000` | Porta validada no boot (1..65535). |
| `GUEDDER_MCP_PATH` | `/mcp` | Caminho do endpoint MCP. |
| `GUEDDER_MCP_PUBLIC_ONLY` | vazio | `1`/`true` registra **somente** as tools sem auth (7 tools de evento). Some a tool de escrita e a de auditoria. |
| `GUEDDER_BEARER_TOKEN` | vazio | Token estático repassado à API quando não há `caller`. Só stdio local e smoke. |
| `GUEDDER_COGNITO_ISSUER` | vazio | **Chave de liga/desliga da autenticação.** Vazio: `src/auth.ts` fica inerte. Definido: todo request no caminho MCP exige JWT válido. |
| `GUEDDER_MCP_CLIENT_ID` | vazio | `client_id` esperado no token. Token de outro app client é recusado. |
| `GUEDDER_MCP_RESOURCE` | `https://mcp.guedder.com/mcp` | **Audiência.** Identificador do resource server, igual em staging e produção. É endereço, não ambiente. |
| `GUEDDER_MCP_PUBLIC_URL` | origem do `RESOURCE` | **Onde o servidor responde de verdade.** Só a metadata usa. |
| `GUEDDER_MCP_SCOPES` | `openid email profile` | Escopos que o app client permite, com os customizados em nome **completo** (prefixado pelo resource). Espelha `allowed_oauth_scopes` do Terraform. |
| `GUEDDER_MCP_LOG_GROUPS` | vazio | Log groups da tool de auditoria, separados por vírgula. Vazio: a tool não é registrada. |
| `GUEDDER_MCP_MAX_LINHAS` | `100` | Teto de linhas por consulta de log. |
| `GUEDDER_MCP_JANELA_DIAS` | `30` | Janela do scan da âncora. Não é filtro do usuário: é limite de varredura. |
| `AWS_REGION` | `us-west-2` | Região dos log groups. **Em staging é `us-east-1`**; errar devolve "not authorized to perform StartQuery", que parece portão de admin fechado e não é. |

### A armadilha que custa mais caro: `RESOURCE` ≠ `PUBLIC_URL`

São duas coisas diferentes e precisam ser duas variáveis:

- `GUEDDER_MCP_RESOURCE` é a **audiência** — o identificador do resource server
  no Cognito, o valor conferido no `aud` do token e o prefixo dos escopos. Vale
  `https://mcp.guedder.com/mcp` em **todos** os ambientes: quem separa staging
  de produção é o issuer, não a audiência. Trocá-lo invalida token em
  circulação.
- `GUEDDER_MCP_PUBLIC_URL` é **onde o servidor responde**
  (`https://mcp.dev.services.guedder.com` em staging).

Derivar a URL pública da audiência (que foi a primeira versão) faz o discovery
anunciar `issuer` e `authorization_endpoint` num host que não resolve. O
cliente MCP lê a metadata, segue o endpoint anunciado e não acha ninguém —
**enquanto o serviço sobe normalmente e o health check passa**, porque ele bate
justamente no endpoint de metadata, que responde. Falha silenciosa do lado do
deploy.

Em produção os dois coincidem, e por isso `PUBLIC_URL` cai na origem do
`RESOURCE` quando não vem.

---

## 5. Fluxo OAuth: o MCP como front door

O Cognito é quem autentica, emite código e troca código por token. O que ele
**não** faz, e por isso este servidor faz:

| Falta no Cognito | Consequência | O que o MCP faz |
|---|---|---|
| RFC 8414 (`/.well-known/oauth-authorization-server`) | Cliente que só procura esse caminho não acha nada (o Cognito devolve 400 em todas as formas) | Serve o documento, espelhando o OIDC do Cognito |
| Declara `token_endpoint_auth_methods_supported` sem `none` e omite `code_challenge_methods_supported` | Cliente público conclui que precisa de secret e que não há PKCE — as duas ao contrário do que o Cognito faz na prática | Republica o documento com os dois campos corrigidos |
| DCR (RFC 7591) | Cliente que exige registro dinâmico (MCP Inspector, Claude Code) para antes de autenticar | `/register` mascarado, devolvendo sempre o app client já registrado |
| Tela de consent por escopo | O app client autoriza uma vez, para todos; `prompt=consent` só é repassado a IdP externo | Serve a própria tela em `/authorize` (ADR 0002) |

Detalhes que não são estéticos:

- **O `issuer` do documento RFC 8414 é ESTE servidor**, não o Cognito, e
  `authorization_endpoint`, `token_endpoint` e `registration_endpoint` apontam
  para os nossos. Declarar o issuer do Cognito enquanto se serve os próprios
  endpoints faz o MCP Inspector recusar na hora, aplicando o RFC 8414 §3.3.
  Isso não afrouxa nada: quem valida assinatura e `iss` do token é
  `createVerifier`, contra o Cognito. `jwks_uri` continua sendo o do Cognito,
  porque quem assina é ele.
- **`scopes_supported` vem do app client, não do pool.** O documento do Cognito
  lista os escopos do *pool*; repassá-lo fez o cliente pedir `phone`, que não
  está em `allowed_oauth_scopes`, e o Cognito recusou a autorização por um
  escopo que nós mesmos anunciamos. Fonte da verdade:
  `guedder/identity/staging/cognito.tf` no repo `infra`; mudar lá exige mudar
  `GUEDDER_MCP_SCOPES` aqui.
- **Os endpoints do Cognito são buscados, não escritos à mão**, e ficam em
  cache de processo (são fixos por pool, e buscar a cada request de um fluxo em
  que o usuário está esperando no navegador só somaria latência). A busca usa o
  documento **cru** do Cognito — usar o nosso documento espelhado faria o
  `/authorize` redirecionar para si mesmo, em laço infinito.
- **`/token` é repasse, nunca 302.** É POST com corpo; redirecionar faria o
  cliente perder o corpo ou virar GET. O corpo é lido com teto de 64 KB. O
  `Authorization` que vier é repassado (client confidencial manda Basic; o
  nosso é público e não manda nada). Erro do Cognito é logado com o corpo
  cortado — o corpo de erro traz o motivo, nunca token ou código.
- **Método errado em endpoint que existe responde 405 com `Allow: POST`**, não
  404. O 404 manda investigar roteamento, que é o caminho errado.
- **`/register` é mascarado de propósito**: os `redirect_uri` que importam já
  estão nos `callback_urls` do app client, e o `client_id` não é segredo
  (cliente público, PKCE). Registrar aqui um callback fora da lista não faz o
  Cognito aceitá-lo. Se aparecer cliente com `redirect_uri` imprevisível
  (porta local sorteada), o atalho deixa de servir e a saída é
  `CreateUserPoolClient` por registro — o log de `redirect_uris` é o que vai
  dizer se chegamos lá.

### Sequência completa

```
cliente MCP → GET /mcp (sem token)
  ← 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource"
cliente → GET /.well-known/oauth-protected-resource
  ← { resource, authorization_servers: [ESTE servidor] }
cliente → GET /.well-known/oauth-authorization-server
  ← documento do Cognito com issuer/endpoints reescritos e PKCE declarado
cliente → POST /register            (se exigir DCR)
  ← client_id do app client já existente
navegador → GET /authorize?…        (sem prova de consent)
  ← 200 text/html: a tela, com os escopos marcáveis
navegador → GET /authorize?…&consentido=<HMAC>&scope=…
  ← 302 para o /authorize do Cognito, com scope = (marcado ∩ anunciado) e resource=<audiência>
Cognito → login (Hosted UI, senha ou IdP social) → redirect_uri do cliente com code
cliente → POST /token               (repassado ao Cognito)
  ← { access_token, refresh_token, … }
cliente → POST /mcp com Authorization: Bearer <access_token>
```

---

## 6. Identidade e autorização

### Verificação do token (`createVerifier`)

Em ordem, e todas somam:

1. **Assinatura e `iss`**, via JWKS em `<issuer>/.well-known/jwks.json`.
2. **`client_id` do token == `GUEDDER_MCP_CLIENT_ID`**, quando configurado.
   Token do `guedder-web`, mesmo do mesmo usuário, é recusado.
3. **`aud` contém o `resource`**, *quando o token traz `aud`*. O access token
   do Cognito só tem `aud` se o cliente pediu `resource=` no `/authorize`
   (RFC 8707). Exigir `aud` de largada arrancaria do ar todo token já emitido;
   aceitar só `aud` também não bastaria, porque qualquer app client do pool
   pode pedir `resource=` com a nossa URL — audiência certa com client errado
   seria o app web entrando aqui.
4. **`email`** (ou `cognito:username`) obrigatório: sem ele não há como
   resolver o usuário.

O resultado é um `Caller`:

```ts
type Caller = {
  token: string;      // repassado à API nas tools auth:true
  email: string;
  usuarioId?: string; // custom:usuario_id
  role?: string;      // custom:role — UserRole: ADMIN | PRODUTOR | USER
  isAdmin: boolean;   // role === "ADMIN"
  scopes: string[];   // claim `scope`, sem o prefixo do resource server
};
```

`isAdmin` vem de `custom:role`. A Pre-Token Lambda **nunca** emite
`custom:is_admin` — ler essa claim deixava `isAdmin` sempre `false`, fechando a
auditoria até para admin, e passou despercebido porque enquanto o Postgres
estava inalcançável nenhum token trazia `custom:*` e a recusa parecia certa.

### Escopos: descascar o prefixo num lugar só

No Cognito o identificador do resource server vira **prefixo** do escopo dentro
do token: `conta:read` declarado em `https://mcp.guedder.com/mcp` chega como
`https://mcp.guedder.com/mcp/conta:read`.

`escoposDoToken(scope, resource)` é o único lugar que sabe disso. Três regras:

- só entram escopos com **o nosso** prefixo. Escopo de outro resource server é
  **descartado, não aceito pelo sufixo** — senão
  `https://api.guedder.com/pedido:cancelar`, emitido para a API por outro
  consentimento, abriria a tool de cancelamento daqui;
- escopos de identidade (`openid`, `email`, `profile`) não têm prefixo e também
  saem: eles dizem quem é a pessoa, não o que ela autorizou;
- ausência de `scope` é **conjunto vazio, nunca "tudo"**. Token emitido antes
  do consent existir não pode virar passe livre no dia em que o gate entrar.

Se o prefixo vazasse para o gate de cada tool, trocar o host do MCP viraria
mudança de autorização.

### `exigirEscopo`: portão único, sem bypass de admin

```ts
exigirEscopo(caller, "pedido:cancelar"); // lança EscopoError com instrução de reconectar
```

Um ponto de checagem só (espalhar `if` por tool faz de cada client novo uma
caçada), e **nenhum atalho para admin**. A omissão é decisão, com teste:

| | responde |
|---|---|
| `custom:role` | até onde a **pessoa** alcança |
| escopo | o que ela autorizou o **agente** a fazer por ela |

Um admin que conectou o agente só para consulta não autorizou cancelamento, e é
justamente no admin que o estrago seria maior. Na API o admin continua como
está (ADR 0001 §9.5 do repo `auth`); lá a pergunta é outra.

---

## 7. A tela de consent

Servida pelo próprio MCP em `GET /authorize`, antes de redirecionar ao Cognito
(ADR 0002 deste repo para o porquê; aqui o contrato).

**Forma.** HTML sem JS, um `<form method="GET" action="/authorize">` contendo:

- **todo** parâmetro do pedido original como `hidden` (menos `scope` e
  `consentido`): PKCE, `state` e `redirect_uri` são do cliente, e perder
  qualquer um quebra o retorno;
- os escopos de **identidade** como `hidden` (não são permissão: desmarcá-los
  não dá uma conexão mais restrita, dá uma conexão que não funciona);
- um `checkbox` por escopo **opcional**, com `value` = nome completo (é o que o
  Cognito entende) e rótulo em português vindo de um dicionário. Escopo sem
  texto no dicionário aparece pelo nome cru — feio de propósito: é o lembrete
  de que escopo novo sem explicação é permissão concedida sem entendimento;
- o campo `consentido` com a prova HMAC.

**`openid` é garantido em código**, não só no HTML: `GUEDDER_MCP_SCOPES`
precisa espelhar o Terraform, e listar ali só os customizados é erro plausível.
Sem `openid` não vem `email`, e o verifier recusa todo token com "Token sem
email" — falha que só aparece no login real.

**Interseção.** No redirect, o scope enviado ao Cognito é
`marcado ∩ anunciado`. Sem isso a tela é decorativa: bastaria montar a query à
mão. O `resource=` (RFC 8707) é acrescentado aqui, e é o que faz o access token
sair com `aud`.

**A prova (`consentido`).** HMAC-SHA256 de
`client_id | redirect_uri | state | code_challenge | bloco-de-10-min`, com o
segredo de processo; aceita o bloco atual e o anterior (a pessoa está lendo a
tela nesse meio tempo). Comparação com `timingSafeEqual`. É amarrada ao pedido
para não virar passe reutilizável em outro `redirect_uri`.

**Teto conhecido, registrado no código e aqui.** A tela é camada de
autorização, não barreira criptográfica:

1. a tela é pública, então um cliente determinado pode buscá-la, extrair a
   prova e repeti-la sem nunca mostrá-la a ninguém;
2. o app client é público (PKCE, sem secret), então dá para ir direto ao
   `/authorize` do Cognito, contornando este servidor.

O que limita o estrago continua sendo a lista de escopos do app client e a de
`callback_urls`. Os dois se fecham com a mesma mudança: app client
confidencial, secret só neste servidor, e o MCP passando a emitir a própria
sessão — molde na casa: `CheckinSessionTokenService` do `guedder-api`.

---

## 8. A camada de tools

### Forma de uma tool de leitura

```ts
type Tool = {
  name: string;                 // guedder_<verbo>_<substantivo>, <= 64 chars
  title: string;                // rótulo humano, exigido pelo review da Anthropic
  description: string;          // o que a tool faz; nunca como o agente deve se comportar
  openApiOperationId: string;   // liga a tool à operação na spec recortada
  inputSchema: z.ZodRawShape;
  auth: boolean;                // repassa o token do caller?
  build: (args) => { path: string; query?: Record<string, unknown> };
};
```

Registro, por tool:

- um **resource** `guedder://openapi/v3/tools/<nome>` com a operação OpenAPI
  daquela tool mais **só** os componentes referenciados (resolvidos
  transitivamente). O índice compacto de todas as operações fica em
  `guedder://openapi/v3`. É economia de contexto: o harness não recebe a spec
  inteira.
- `outputSchema` uniforme `{ result: unknown }`, e a resposta devolve o JSON
  cru em `content` **e** em `structuredContent.result`.
- `annotations`: `readOnlyHint: true`, `destructiveHint: false`,
  `idempotentHint: true`, `openWorldHint: true`.
- erro vira `{ isError: true, content: [texto] }`, nunca exceção que derruba o
  transporte.

### Contrato de paginação

Tool paginada expõe **só** `max_results` (`min 1`, `max 100`, `default 50`) e
consulta sempre a primeira página. Nunca exponha `page`, `size`, `pageSize` ou
`limit` no contrato MCP. A tradução para o nome que a API exige acontece no
`build`: normalmente `size`, em `/api/v3/eventos` é `page_size`.

`/api/v3/eventos` **pagina a partir de 1** (`page=0` devolve 400). Os demais
endpoints seguem em 0. Isso não é generalizável: confirme no controller.

### Tools de hoje

| Tool | Auth | Endpoint |
|---|---|---|
| `guedder_listar_eventos` | — | `GET /api/v3/eventos` |
| `guedder_get_evento` | — | `GET /api/v3/eventos/{id}` |
| `guedder_listar_categorias_evento` | — | `GET /api/v3/categorias-evento` |
| `guedder_listar_atracoes_evento` | — | `GET /api/v3/eventos/{id}/atracoes` |
| `guedder_listar_lotes_evento` | — | `GET /api/v3/eventos/{id}/lotes` |
| `guedder_get_parametros_venda` | — | `GET /api/v3/eventos/{id}/parametros-venda` |
| `guedder_eventos_destaque` | — | `GET /api/v3/home/destaques` |
| `guedder_get_lote` | ✅ | `GET /api/v3/eventos/{id}/lotes/{id}` |
| `guedder_buscar_ingressos_evento` | ✅ | `GET /api/v3/eventos/{id}/ingressos` |
| `guedder_meus_ingressos` | ✅ | `GET /api/v3/ingressos` |
| `guedder_minhas_compras` | ✅ | `GET /api/v3/compras` |
| `guedder_buscar_compras_evento` | ✅ | `GET /api/v2/compra/evento/{id}/extrato` |
| `guedder_auditar_vendas_evento` | ✅ | `GET /api/v1/metrica/{id}/ultimas-vendas` |
| `guedder_resumo_vendas_evento` | ✅ | `GET /api/v1/metrica/{id}/resumo-vendas` |
| `guedder_listar_integracoes_pagamento` | ✅ ADMIN | `GET /api/v1/administrativo/gateway-adquirentes` |
| `guedder_listar_resumo_repasses_eventos` | ✅ ADMIN | `GET /api/v3/administrativo/repasses/eventos` |
| `guedder_listar_locais_recentes` | ✅ ADMIN | `GET /api/v3/administrativo/locais-recentes` |
| `guedder_usuario_logado` | ✅ | `GET /api/v3/usuarios/perfil` |
| `guedder_cancelar_pedido` | ✅ `pedido:cancelar` | `POST /api/v3/pedidos/{id}/cancelamento` |
| `guedder_rastrear_compra` | ✅ ADMIN, sem API | CloudWatch Logs Insights |

Armadilhas de rota já pagas, que se repetem em qualquer reimplementação:

- `usuario_logado` é o nome da rota em **v1**; em v3 a mesma operação é
  `/api/v3/usuarios/perfil`. O path errado passa batido porque o 404 vem
  **depois** do auth: só aparece com token válido.
- **Não existe "cancelar ingresso" individual.**
  `PUT /api/v1/ingresso/{id}/cancelar` devolve 400 fora de convite e não checa
  dono. A operação real é cancelar o **pedido**
  (`POST /api/v3/pedidos/{id}/cancelamento`), que já é só-do-dono.

### O bloco `instructions` do handshake

O servidor manda instruções no `initialize`: o fluxo (achar o evento e o id →
consultar por id), as regras (nunca inventar id; 404 em `parametros-venda`
significa "ainda não divulgado", não "evento inexistente") e o protocolo da
tool de escrita. É o único lugar onde comportamento do agente é descrito —
**descrição de tool não instrui comportamento** (seção 11).

### Modo `GUEDDER_MCP_PUBLIC_ONLY`

Registra só as tools com `auth: false`. A tool de escrita e a de auditoria não
são registradas (não é filtro em runtime: elas não existem no handshake).

---

## 9. A tool de escrita

`guedder_cancelar_pedido` é a única operação que muda estado. **Três portões em
série**, cada um respondendo uma pergunta diferente:

| portão | pergunta | onde |
|---|---|---|
| escopo | a pessoa autorizou o **agente** a isto? | `exigirEscopo`, neste servidor |
| confirmação | ela mandou fazer **isto**, neste pedido, agora? | duas fases, neste servidor |
| regra de negócio | ela **pode**? (dono, prazo, check-in) | a API, que continua a autoridade |

**Duas fases, porque o agente é um LLM.** A primeira chamada (sem
`confirmacao`) não escreve nada: devolve o resumo do efeito em português e um
código. A segunda, com aquele código, executa. O código é
`HMAC(pedidoId + usuário)` truncado em 10 caracteres alfanuméricos maiúsculos,
**imprevisível de propósito**: se fosse fixo ("CONFIRMAR"), o modelo poderia
mandá-lo de primeira e a fase de resumo nunca chegaria à pessoa — que é
justamente o que faz o consent valer alguma coisa numa operação que devolve
dinheiro. Um código vale para **um** pedido: sem isso a pessoa confirma o
cancelamento de um ingresso e o agente reaproveita o código em outro.

Código errado é `isError`; código ausente **não** é erro (é a fase de resumo).

**Sem `outputSchema`**, de propósito: a tool devolve duas coisas diferentes (o
resumo da fase 1 e a resposta da API na fase 2), e declarar o schema da segunda
obrigaria a primeira a fingir ser um resultado de API.

**Annotations dizem a verdade**: `readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false` (cancelar duas vezes não é o
mesmo que cancelar uma: a segunda tende a bater num pedido que já não está PAGO
e voltar erro). O cliente MCP usa essas dicas para decidir se pede aprovação
humana.

**Sem helper genérico de verbo.** Existe `apiGet` e existe `apiPost`, e o
segundo só serve a esta operação. Um `apiRequest(metodo, path)` transformaria
"este servidor escreve num lugar" em "este servidor pode escrever em qualquer
lugar", e a diferença só apareceria numa auditoria (ADR 0003).

**O segredo dos HMACs é por processo** (`randomBytes(32)` no boot), e o mesmo
segredo serve ao código de confirmação e à prova de consent. Com mais de uma
réplica, a confirmação pode cair noutra e a pessoa confirma de novo — atrito
aceitável. Se incomodar, o upgrade é uma chave em SSM lida no boot, não uma
sessão em banco.

---

## 10. Auditoria (CloudWatch)

`guedder_rastrear_compra` é a única tool que **não age como o usuário**: usa a
credencial AWS da task. Consequência direta: nenhuma proteção do domínio
(`@Permissao`, evaluator, papéis) está no caminho, então o portão é aqui
(`caller.isAdmin`) e o IAM é a única coisa que limita **quais** log groups
alguém alcança.

Duas regras que não são detalhe de implementação:

1. **Consulta sempre por identificador** — id de pedido, id de compra ou
   `trace_id`. Nunca por janela de tempo: "me traz o log das últimas duas
   horas" é exfiltração com passos extras. A janela (`GUEDDER_MCP_JANELA_DIAS`)
   é limite de scan, não filtro oferecido ao usuário.
2. **Resposta com campos allowlisted** (`@timestamp`, `level`, `logger_name`,
   `trace_id`, `xray_trace_id`, `message`). Log de produção tem PII de
   comprador e o destino é o contexto de um LLM de terceiro; o evento cru não
   sai daqui.

Mecânica: identificador com 32 hex é tratado como `trace_id`; qualquer outra
coisa passa por uma busca de âncora (`filter message like /<id>/` +
`ispresent(trace_id)`), e o `trace_id` encontrado vira a consulta de verdade
(`filter trace_id = "<id>"`). O identificador é validado contra
`^[A-Za-z0-9._:-]{4,128}$` **antes** de entrar na query — ele vem de um modelo
e viraria regex que casa com tudo.

Logs Insights é assíncrono: `StartQuery` e depois polling de
`GetQueryResults` (até 40 tentativas de 500 ms).

**IAM mínimo** (`infra/task-policy.json`, espelhado no Terraform do repo
`infra`), com a forma explicada pelas assimetrias da API:

- `logs:StartQuery` aceita restrição por ARN de log group — é onde o recorte
  real acontece;
- `logs:GetQueryResults` e `logs:StopQuery` operam sobre um `queryId`, não
  sobre o log group, e por isso não aceitam `Resource` específico. Quem não
  conseguiu iniciar a consulta não tem `queryId` para ler.

Ao acrescentar um log group, mude o ARN na policy **e** o nome em
`GUEDDER_MCP_LOG_GROUPS`: variável sem permissão gera erro em runtime;
permissão sem variável é privilégio concedido e não usado.

O IAM estreita quais log groups. Ele **não** estreita quais linhas — isso é do
servidor, pelo allowlist e pela consulta por identificador.

---

## 11. Regras de design de tools (critérios de review da Anthropic)

Verificados em `https://claude.com/docs/connectors/building/review-criteria`.
Valem para qualquer tool nova:

- **Leitura e escrita em tools separadas.** Uma tool que aceita métodos seguros
  e inseguros é rejeitada; um `api_request` com parâmetro `method` é o exemplo
  citado. Documentar a diferença na descrição não satisfaz o critério. Idealmente
  a escrita ainda se divide por ação (criar, atualizar, apagar).
- **Toda tool precisa de `title`** e da annotation aplicável:
  `readOnlyHint: true` para leitura, `destructiveHint: true` para o que
  modifica ou apaga. Elas decidem auto-permissão no cliente: read-only roda sem
  confirmação por chamada, destrutiva sempre pergunta.
- **Nome de tool com no máximo 64 caracteres.**
- **Descrição precisa e verdadeira**, dizendo o que a tool faz e quando
  invocá-la, casando com o comportamento real.
- **Descrição não é canal de comportamento.** É rejeitada a descrição que
  instrui o agente a chamar outra coisa, interfere em outras tools, manda
  buscar instruções fora, esconde instrução codificada ou tenta sobrepor o
  system prompt. Descreva o que a tool faz; não diga ao agente como se
  comportar — para isso existe o bloco `instructions` do handshake.
- **Tool com caminho/corpo livre precisa citar a API alvo** na descrição. Tool
  de endpoint fixo não precisa.
- **Erro tem que ser acionável**; "Internal Server Error" genérico reprova.
  Resposta proporcional à pergunta, sem despejo de base.

---

## 12. Testes: o que cada arquivo segura

`npm test` = `tsc` + `node --test test/**/*.test.mjs`. Quase todos sobem o
servidor de verdade (stdio ou HTTP) contra uma API ou um Cognito de mentira.

| Arquivo | Propriedade que ele impede de quebrar |
|---|---|
| `spec-paths.test.mjs` | Cada tool de leitura chama **o path e os query params da sua operação OpenAPI**, com exatamente **um GET**. Afirma o **verbo**, e tem uma lista nomeada de exceções (`guedder_rastrear_compra`, `guedder_cancelar_pedido`). Somar tool de escrita sem entrar na lista quebra o teste **de propósito**: é o que transforma "ampliar a superfície" em decisão revisada. |
| `escrita.test.mjs` | Fase de resumo não escreve; confirmação errada não cancela; código de um pedido não serve para outro; a tool se anuncia destrutiva. |
| `consent.test.mjs` | `/authorize` sem prova mostra a tela; o redirect leva só o marcado; escopo forjado na query não passa; `consentido=1` não vale; a prova de um pedido não serve para outro `redirect_uri`. |
| `auth.test.mjs` | JWKS, client_id, issuer, `aud`, email ausente, prefixo de escopo, `exigirEscopo`, **admin não fura escopo**, metadata, correções do documento do Cognito, cache de endpoints, `publicUrl` independente da audiência. |
| `auditoria.test.mjs` | Allowlist de campos, filtro exato por trace, teto de linhas, recusa de curinga no identificador, falha alta quando o CloudWatch falha. |
| `streamable-http.test.mjs` | Stateless em `/mcp`, modo `PUBLIC_ONLY`, `instructions` no handshake. |
| `bearer.test.mjs` | O token só vai para os endpoints autenticados. |
| `smoke.mjs` | `npm run smoke`: sobe em stdio, lista tools e consulta um endpoint público. |
| `validar-staging.mjs` | Validação ao vivo contra staging das três camadas juntas: identidade, acesso à API e auditoria. Sem `TOKEN` marca o resto como **pulado**, nunca como sucesso. O token vem de um login humano (o consent do Google é anti-bot por design). |

---

## 13. Infra e deploy

**Imagem.** `container.yml` (GitHub Actions) publica multi-arch em
`ghcr.io/guedder/mcp` a cada push em `main` e em tags `v*`. O pacote é público
no ghcr, então a task não precisa de `repositoryCredentials`. O ECR
`guedder/mcp` foi destruído num PR anterior do repo `infra` e **não** foi
recriado: voltaria a exigir três peças novas para entregar a mesma imagem.

**Staging** (repo `infra`, roots `guedder/mcp/staging`,
`guedder/identity/staging`, `guedder/platform/staging`):

- ECS Fargate no cluster `guedder-staging` (us-east-1), 512/1024, 1 task, atrás
  do ALB compartilhado, regra de listener por `host_header`
  `mcp.dev.services.guedder.com`, registro Route 53 alias para o ALB.
- **Health check em `/.well-known/oauth-protected-resource`**, e isso é melhor
  que um `/health`: o endpoint só responde 200 quando o issuer do Cognito está
  configurado, então health check vermelho passa a significar "auth mal
  configurada", não apenas "processo morto".
- Role da task só com as permissões da auditoria (seção 10).
- Cognito: `aws_cognito_resource_server` `https://mcp.guedder.com/mcp` com
  `conta:read` e `pedido:cancelar` (mínimo deliberado: escopo declarado sem
  consumidor é permissão concedida e esquecida; somar é barato, tirar é caro
  porque token em circulação segue valendo). App client `guedder-mcp-agent`,
  público (PKCE, sem secret), TTL curto (access 1h, refresh 1d) porque o token
  vive no cliente de IA de terceiro.
- **O serviço dorme junto com o resto do staging** (Lambda
  `guedder-staging-power`, `IDLE_SECONDS=3600`) e **não acorda sozinho**:
  o despertar existente serve navegador (página via CloudFront KeyValueStore) e
  um cliente MCP não é navegador — com o serviço em zero, a chamada ao `/mcp`
  volta erro do ALB e o cliente não tem como acionar a página. Em staging
  basta abrir o front antes, que é o mesmo gesto que acorda a API de que o MCP
  depende (ADR 0005).

O serviço ECS tinha sido **desligado de propósito** num PR anterior ("sem
serviço hospedado, sem OAuth pra manter") e foi reconstruído quando o caso de
uso mudou de suporte interno só-leitura para atender usuário final com escrita.

**Distribuição.** `plugins/guedder/.mcp.json` no repo `guedder/claude-plugins`
registra o servidor como MCP bundlado, sem header estático: o fluxo de
descoberta (RFC 8414/9728) e o handshake OAuth cuidam do login.

**Produção ainda não existe.** O que está fixado é a audiência
(`https://mcp.guedder.com/mcp`) e o fato de o resource server ser o mesmo
identificador nos dois ambientes.

---

## 14. Ordem sugerida para reimplementar do zero

Cada fase termina com algo verificável, e nenhuma depende de infra da fase
seguinte.

1. **Esqueleto e leitura pública.** `McpServer` sobre Streamable HTTP
   stateless, `apiGet`, a tabela `TOOLS` com as tools sem auth, `outputSchema`
   uniforme, resources OpenAPI recortados e o script de sync da spec.
   *Verificação:* `smoke` e `spec-paths`.
2. **Token repassado.** `GUEDDER_BEARER_TOKEN` e a flag `auth` por tool.
   *Verificação:* `bearer`.
3. **Cognito.** `authConfigFromEnv`, `createVerifier`, `Caller`, 401 com
   `WWW-Authenticate`, metadata RFC 9728. *Verificação:* `auth`.
4. **Fachada de authorization server.** RFC 8414 espelhada com issuer próprio e
   correções, `/authorize` (repasse), `/token` (repasse), `/register`
   mascarado, 405, log com redação. *Verificação:* `auth` + MCP Inspector.
5. **Consent.** `GUEDDER_MCP_SCOPES`, tela, interseção, prova HMAC, `openid`
   garantido. *Verificação:* `consent`.
6. **Escrita.** `apiPost` específico, `exigirEscopo`, confirmação em duas
   fases, annotations honestas, exceção nomeada no `spec-paths`.
   *Verificação:* `escrita` + `spec-paths` (que deve falhar se a exceção não
   for declarada).
7. **Auditoria.** Só quando houver log group: allowlist, consulta por
   identificador, IAM mínimo. *Verificação:* `auditoria`.
8. **Deploy.** Imagem no ghcr, ECS + ALB + DNS, `GUEDDER_MCP_HOST=0.0.0.0`,
   `PUBLIC_URL` separada da audiência, health check no endpoint de metadata.
   *Verificação:* `validar-staging.mjs` com token real.

---

## 15. Em aberto

- **Produção.** Não há root Terraform nem app client de produção para o MCP; a
  audiência já está escolhida, o resto não.
- **Despertar do staging.** Um cliente MCP não consegue acordar o serviço
  adormecido. Só se paga se o MCP passar a ser usado sem ninguém no front.
- **Segredo dos HMACs por processo.** Com mais de uma réplica, a confirmação
  pode cair noutra.
- **Client confidencial e sessão emitida aqui.** É o que fecha os dois tetos da
  tela de consent; gatilho é cliente de terceiro de fato não confiável.
- **Escopos vs tools.** Só `pedido:cancelar` é exigido hoje; `conta:read`
  existe no resource server e **não** é exigido por nenhuma tool de leitura.
  Quando passar a ser, é mudança de autorização para quem já conectou.
- **Redesenho das tools de leitura por tarefa do comprador** (ADR 0004), ainda
  não mergeado.
