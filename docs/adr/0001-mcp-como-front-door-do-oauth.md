# ADR 0001 — O servidor MCP é o front door do OAuth, não só um resource server

**Status**: Aceito — 2026-08-18 (fachada), ratificado em 2026-09-16 (consent)
**Contexto maior**: ADR 0001 §9 do repo `auth` (`auth/docs/adr/0001-guedder-auth-oidc-design.md`)

## Contexto

O modelo de identidade da Guedder é o Cognito User Pool. O desenho original do
MCP (ADR 0001 §9.3 do repo `auth`) previa o agente como mais um App Client do
pool: a pessoa loga, o token chega no `Authorization` do request MCP e o
servidor valida. O MCP seria **só** um resource server.

Ao ligar um cliente MCP real (MCP Inspector, Claude Code) isso não fechou. O
protocolo MCP espera descoberta automática de autorização, e o Cognito não
entrega as peças que a descoberta procura:

- **RFC 8414** (`/.well-known/oauth-authorization-server`): o Cognito só
  publica `/.well-known/openid-configuration`. As duas formas do 8414, com e
  sem inserção de path, devolvem **400** — conferido ao vivo. Cliente que só
  procura o caminho do 8414 não acha nada.
- **O documento que ele publica mente por omissão** em dois campos que decidem
  se um cliente público consegue autenticar:
  `token_endpoint_auth_methods_supported` sem `none` (afirma exigir secret) e
  `code_challenge_methods_supported` ausente (não afirma suportar PKCE). Nosso
  app client é público, sem secret — o Cognito fixa isso na criação — e o login
  por PKCE/S256 funciona.
- **DCR (RFC 7591)**: não existe. Cliente que exige registro dinâmico para
  antes de autenticar. Como o MCP é distribuído no plugin `guedder`, exigir
  `client_id` colado à mão em cada instalação é justamente o que o plugin
  existe para evitar.
- Alguns clientes ignoram o `authorization_endpoint` do documento e montam
  `<base do AS>/authorize` por convenção. Como a nossa metadata RFC 9728
  declara este servidor como authorization server, o navegador do usuário vem
  parar aqui de qualquer jeito — comprovado por um `GET /favicon.ico` no log,
  que só existe se um navegador navegou até esta origem.

## Decisão

O servidor MCP serve a fachada de authorization server: `/authorize`,
`/token`, `/register` e os dois documentos de discovery. O Cognito continua
sendo quem autentica, emite código e troca código por token.

1. **RFC 9728** (`/.well-known/oauth-protected-resource`) aponta
   `authorization_servers` para **este** servidor.
2. **RFC 8414** é servida buscando o documento OIDC do Cognito e reescrevendo:
   `issuer` e os três endpoints viram os nossos, `scopes_supported` vira o do
   **app client** (não o do pool), `code_challenge_methods_supported` ganha
   `S256` e `token_endpoint_auth_methods_supported` ganha `none`. `jwks_uri`
   continua sendo o do Cognito, porque quem assina é ele.
3. **`/authorize`** serve a tela de consent (ADR 0002) e depois redireciona
   (302) ao Cognito, acrescentando `resource=` (RFC 8707).
4. **`/token`** é repasse (POST → POST), nunca redirect.
5. **`/register`** devolve sempre o app client já registrado, em vez de criar
   um no Cognito por registro.

### Duas variáveis, não uma: audiência e URL pública

`GUEDDER_MCP_RESOURCE` é a audiência — identificador fixo
(`https://mcp.guedder.com/mcp`), **igual em staging e produção**, porque é
endereço e não ambiente (§9.8 do ADR do `auth`); quem separa ambiente é o
issuer. `GUEDDER_MCP_PUBLIC_URL` é onde o servidor responde de fato.

## Alternativas consideradas

- **Manter o issuer do Cognito no documento e só reescrever endpoints.** Foi a
  primeira versão, por receio de que o `iss` do token não batesse. O MCP
  Inspector recusou na hora, aplicando o RFC 8414 §3.3 ao pé da letra
  (`Issuer mismatch…`). O receio não se sustenta: o cliente MCP trata o access
  token como opaco, e quem valida assinatura e `iss` é este servidor, contra o
  Cognito. Declarar o issuer do Cognito enquanto se serve os próprios endpoints
  era meia fachada.
- **Keycloak como front door brokerando o Cognito**, previsto em §9.9 do ADR do
  `auth`. Descartado em §9.11: das quatro faltas previstas, duas não se
  confirmaram (o Cognito implementa RFC 8707, e custom scope não é exclusivo de
  `client_credentials`), e a que sobrou — a tela — não justifica operar um
  produto novo quando o MCP **já** é o front door do `/authorize`.
- **DCR de verdade** (`CreateUserPoolClient` por registro). Só se paga se
  aparecer cliente com `redirect_uri` imprevisível, tipo porta local sorteada;
  aí vira registro com TTL e coleta. O log de `redirect_uris` em `/register`
  existe para dizer quando chegamos lá.
- **Escrever os endpoints do Cognito à mão** em vez de buscá-los. Buscar faz
  com que endpoint que o Cognito mudar continue certo aqui sem ninguém lembrar
  de editar.

## Consequências

- Da perspectiva do cliente, **este servidor é o authorization server**. É
  coerente com o que servimos, e é o que permitiu consent próprio (ADR 0002).
- A metadata depende de uma chamada ao Cognito. Falha nela responde **502** com
  mensagem própria, e o endpoint dos endpoints tem cache de processo.
- O health check do ECS aponta para `/.well-known/oauth-protected-resource`, que
  só responde 200 com o issuer configurado: health vermelho passa a significar
  "auth mal configurada", não apenas "processo morto".
- Confundir audiência com URL pública faz o discovery anunciar um host que não
  resolve, **com falha silenciosa**: o serviço sobe e o health check passa.
- `GUEDDER_MCP_SCOPES` e `allowed_oauth_scopes` no Terraform precisam
  concordar, como o log group e a policy do IAM.
