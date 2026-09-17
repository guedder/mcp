# @guedder/mcp

Readonly MCP over the **Guedder API v3** for operational tasks. Thin wrappers over
the public + produtor/admin GET endpoints. Streamable HTTP stateless server,
TypeScript.

## Transporte

O padrão é **Streamable HTTP** em `http://127.0.0.1:3000/mcp`, compatível com a
arquitetura MCP atual sem sessão em memória. Configure o endereço público por
reverse proxy, por exemplo `https://api.guedder.com/mcp` ou
`https://mcp.guedder.com/mcp`.

| Variável | Padrão | Uso |
|---|---|---|
| `GUEDDER_MCP_TRANSPORT` | `streamable-http` | Use `stdio` apenas para clientes locais legados. |
| `GUEDDER_MCP_HOST` | `127.0.0.1` | Em contêiner, use `0.0.0.0`; o proxy publica HTTPS. |
| `GUEDDER_MCP_PORT` | `3000` | Porta HTTP do MCP. |
| `GUEDDER_MCP_PATH` | `/mcp` | Caminho HTTP do MCP. |
| `GUEDDER_MCP_PUBLIC_ONLY` | vazio | `1` registra apenas as tools sem autenticação (eventos, lotes, categorias, destaques). Para agentes voltados ao comprador. |
| `GUEDDER_MCP_PUBLIC_URL` | origem do `GUEDDER_MCP_RESOURCE` | Onde este servidor **responde de verdade**. Em staging não é o host da audiência, e sem isto a metadata anuncia endpoints num host que não resolve. |

> Antes de expor publicamente, o proxy ou a próxima camada OAuth2 deve autenticar
> os clientes MCP. `GUEDDER_BEARER_TOKEN` autentica somente este servidor perante
> a API Guedder.

## Autenticação

Os endpoints autenticados recebem o token configurado em `GUEDDER_BEARER_TOKEN`.
O MCP o encaminha como `Authorization: Bearer <token>` somente nessas consultas;
não armazena credenciais de usuário nem executa login na API.

Com `GUEDDER_COGNITO_ISSUER` definido, o token é o do próprio usuário e o
`GUEDDER_BEARER_TOKEN` fica só para stdio local e smoke.

## Consent: o que a pessoa concede ao agente

O MCP serve a própria tela de consent em `/authorize`, antes de mandar a pessoa
ao Cognito. Ela existe aqui porque **o Cognito não tem tela de consent por
escopo**: se o escopo está no app client e o cliente pede, ele emite sem
perguntar nada (`prompt=consent` só é repassado a IdP externo).

O fluxo:

1. o cliente MCP chama `/authorize` pedindo escopos;
2. o MCP serve a tela, a pessoa marca o que concede;
3. o MCP redireciona ao Cognito com **só o que foi marcado**, mais `resource=`
   (RFC 8707, que é o que faz o access token sair com `aud`);
4. o Cognito autentica e emite o token com aqueles escopos;
5. cada tool de escrita passa por `exigirEscopo`, um portão só.

Papel e escopo respondem perguntas diferentes, e não se substituem:

| | responde |
|---|---|
| `custom:role` | até onde a **pessoa** alcança |
| escopo | o que ela autorizou o **agente** a fazer por ela |

**Admin não fura escopo.** Um admin que conectou o agente só para consulta não
autorizou cancelamento, e é no admin que o estrago seria maior.

Os escopos vêm prefixados pelo identificador do resource server
(`https://mcp.guedder.com/mcp/pedido:cancelar`). O prefixo é descascado em
`escoposDoToken`, num lugar só, para o resto do código falar `pedido:cancelar`.
Fonte da verdade dos escopos: `guedder/identity/staging/cognito.tf` no repo
`infra`. Mudar lá exige mudar `GUEDDER_MCP_SCOPES` aqui.

O `consentido` que autoriza o redirect é um HMAC do próprio pedido (client_id,
redirect_uri, state, code_challenge), emitido só ao renderizar a tela e válido
por 10 a 20 minutos. A primeira versão usava o literal `consentido=1`, e como
quem monta a URL do `/authorize` é o cliente MCP, bastava acrescentar o
parâmetro para pular a tela inteira.

### Teto conhecido

Duas coisas que a tela **não** garante, e é melhor saber quais são:

1. **A tela é pública, então um cliente determinado pode buscá-la, extrair a
   prova e repeti-la** sem nunca mostrá-la a ninguém. O HMAC eleva a barra de
   "somar um parâmetro" para "buscar e repetir", e fecha o caso do cliente que
   pula por descuido. Não fecha o caso do cliente deliberado.
2. **O app client é público** (PKCE, sem secret), então o `client_id` não é
   segredo e dá para ir direto ao `/authorize` do Cognito, contornando este
   servidor.

Os dois se fecham com a mesma mudança: tornar o app client confidencial, com o
secret só neste servidor, e o MCP passando a emitir a sessão (molde:
`CheckinSessionTokenService` no guedder-api). É o passo para quando aparecer
cliente de terceiro não confiável, e não se paga enquanto o cliente é o plugin
da própria Guedder.

As ferramentas públicas não precisam de token. Estas exigem `GUEDDER_BEARER_TOKEN`:
`guedder_buscar_ingressos_evento`, `guedder_meus_ingressos`, `guedder_minhas_compras`,
`guedder_get_lote`, `guedder_usuario_logado`.

## Build

```bash
npm install
npm run build
npm run smoke   # usa stdio apenas no smoke: lista tools e consulta endpoint público
npm run sync:openapi-v3  # atualiza src/openapi-v3.json a partir de dev-api.guedder.com
```

Após a publicação, execute o servidor HTTP com:

```bash
GUEDDER_MCP_HOST=0.0.0.0 GUEDDER_BEARER_TOKEN=seu-token npx -y @guedder/mcp
```

A imagem multi-arquitetura é publicada pelo GitHub Actions em
`ghcr.io/guedder/mcp:latest`.

## Schema de saída e contexto

Cada ferramenta devolve o JSON original em `content` e também em
`structuredContent.result`, coberto por `outputSchema`. Para reduzir contexto no
harness, `guedder://openapi/v3` é apenas um índice compacto; cada ferramenta
aponta para seu resource específico, como
`guedder://openapi/v3/tools/guedder_listar_eventos`, que contém somente sua
operação e os componentes OpenAPI referenciados.

`npm run sync:openapi-v3` baixa `https://dev-api.guedder.com/v3/api-docs`, mantém
somente operações `GET /api/v3/**` e os componentes OpenAPI referenciados. Rode-o
quando precisar atualizar os schemas antes de publicar uma nova versão do MCP.

## Tools

O servidor manda um bloco `instructions` no handshake MCP com o fluxo de uso
(achar o evento e o id → consultar por id) e as regras (nunca inventar id, 404 em
`parametros-venda` = "ainda não divulgado"). As skills em `skills/` detalham:
`guedder-mcp-consultar-evento-ao-vivo` (fluxo das tools públicas) e
`guedder-mcp-auth-cognito` (como a auth liga).

| Tool | Auth | v3 endpoint |
|---|---|---|
| `guedder_listar_eventos` | — | `GET /api/v3/eventos` (MCP: `max_results`; página 1, pois a API pagina a partir de 1) |
| `guedder_get_evento` | — | `GET /api/v3/eventos/{id}` |
| `guedder_listar_categorias_evento` | — | `GET /api/v3/categorias-evento` |
| `guedder_listar_atracoes_evento` | — | `GET /api/v3/eventos/{eventoId}/atracoes` |
| `guedder_listar_lotes_evento` | — | `GET /api/v3/eventos/{eventoId}/lotes` |
| `guedder_get_parametros_venda` | — | `GET /api/v3/eventos/{eventoId}/parametros-venda` |
| `guedder_eventos_destaque` | — | `GET /api/v3/home/destaques` |
| `guedder_get_lote` | ✅ | `GET /api/v3/eventos/{codigoOrEventoId}/lotes/{codigoOrLoteId}` |
| `guedder_buscar_ingressos_evento` | ✅ | `GET /api/v3/eventos/{eventoId}/ingressos` (MCP: `max_results`, sempre página 0) |
| `guedder_meus_ingressos` | ✅ | `GET /api/v3/ingressos` |
| `guedder_minhas_compras` | ✅ | `GET /api/v3/compras` (MCP: `max_results`, sempre página 0) |
| `guedder_buscar_compras_evento` | ✅ | `GET /api/v2/compra/evento/{eventoId}/extrato` (MCP: `max_results`, sempre página 0) |
| `guedder_auditar_vendas_evento` | ✅ | `GET /api/v1/metrica/{eventoId}/ultimas-vendas` (auditoria operacional; MCP: `max_results`, sempre página 0) |
| `guedder_resumo_vendas_evento` | ✅ | `GET /api/v1/metrica/{eventoId}/resumo-vendas` |
| `guedder_listar_integracoes_pagamento` | ✅ ADMIN | `GET /api/v1/administrativo/gateway-adquirentes` (MCP: `max_results`, sempre página 0) |
| `guedder_listar_resumo_repasses_eventos` | ✅ ADMIN | `GET /api/v3/administrativo/repasses/eventos` (MCP: `max_results`, sempre página 0) |
| `guedder_listar_locais_recentes` | ✅ ADMIN | `GET /api/v3/administrativo/locais-recentes` |
| `guedder_usuario_logado` | ✅ | `GET /api/v3/usuarios/perfil` |
| `guedder_cancelar_pedido` | ✅ `pedido:cancelar` | `POST /api/v3/pedidos/{pedidoId}/cancelamento` |

### A tool de escrita

`guedder_cancelar_pedido` é a primeira tool que muda estado, e quebra de propósito
a garantia estrutural de só-leitura que existia antes (ADR 0001 §9.4 do repo
`auth`). Três portões em série, cada um respondendo uma coisa:

| portão | pergunta | onde |
|---|---|---|
| escopo | a pessoa autorizou o **agente** a isto? | `exigirEscopo`, neste servidor |
| confirmação | ela mandou fazer **isto**, neste pedido? | duas fases, neste servidor |
| regra de negócio | ela **pode**? (dono, prazo, check-in) | a API, que continua a autoridade |

A confirmação é em duas fases porque o agente é um LLM: a primeira chamada não
escreve nada, devolve o resumo em português e um código; a segunda só executa
com aquele código. O código é um HMAC do pedido mais a pessoa, imprevisível de
propósito — se fosse fixo, o modelo poderia pular a fase de resumo e a pessoa
nunca veria o que estava sendo cancelado.

O MCP **não** reimplementa regra de cancelamento. Janela de 7 dias, 48h do
evento e ingresso já bipado continuam sendo da API
(`validarCancelamentoDeCompraUserComum`).

Não existe helper genérico `apiRequest(metodo, ...)`, e isso é deliberado: ele
transformaria "este servidor escreve num lugar" em "este servidor pode escrever
em qualquer lugar". O teste `spec-paths.test.mjs` afirma o verbo de cada tool de
leitura e tem uma lista nomeada de exceções, então somar escrita dispara o teste
e vira decisão revisada, não detalhe absorvido.

## Validação em staging

`test/validar-staging.mjs` sobe o servidor com a configuração real de staging e exercita as
três camadas que só se provam juntas: identidade (token do Cognito), acesso à API (token
repassado) e auditoria (credencial AWS do servidor, não do usuário).

```bash
node test/validar-staging.mjs                        # sem token: valida o que dá
TOKEN=eyJ... ID_PEDIDO=5daig7vi11 node test/validar-staging.mjs   # ponta a ponta
```

Sem `TOKEN` ele valida a camada de identidade — metadata, 401 com `WWW-Authenticate`, recusa de
token inválido — e marca o resto como **pulado**, nunca como sucesso.

O token vem de um login humano: o consent do Google é anti-bot por design, e senha não passa
pelo script. Abra a Hosted UI, troque o `code` e passe o `access_token`:

```
https://guedder-auth-staging.auth.us-east-1.amazoncognito.com/oauth2/authorize
  ?client_id=3ano9ppcdnf5ikuk22mgjvo62h&response_type=code&scope=openid+profile+email
  &redirect_uri=http://localhost:6274/oauth/callback
```

As tools de auditoria exigem perfil administrativo; com token de usuário comum o script trata o
"acesso negado" como **comportamento esperado**, não como falha.

## Cliente MCP local (stdio opcional)

Add to `~/.claude.json` (or project `.mcp.json`) under `mcpServers`:

```json
{
  "mcpServers": {
    "guedder": {
      "command": "node",
      "args": ["/Users/danilo/Work/DG/guedder/guedder-ops-mcp/dist/index.js"],
      "env": {
        "GUEDDER_API_BASE": "https://api.guedder.com",
        "GUEDDER_MCP_TRANSPORT": "stdio",
        "GUEDDER_BEARER_TOKEN": "seu-access-token"
      }
    }
  }
}
```

Point `GUEDDER_API_BASE` at a dev/staging host to use those environments.
