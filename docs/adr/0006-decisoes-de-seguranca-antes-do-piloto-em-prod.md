# ADR 0006 — Decisões de segurança antes de abrir o MCP para fora do piloto

**Status**: Proposto — 2026-10-17 (HITL: decisões do Danilo — GUE-569, epic GUE-565)
**Depende de**: ADR 0002 (tela de consent + teto do client público), ADR 0005 (hospedagem em staging)
**Terraform verificado**: `guedder/infra` @ `guedder/identity/production/cognito.tf`,
`guedder/identity/staging/cognito.tf`, `guedder/identity/staging/staging.tfvars`,
[guedder/infra#399](https://github.com/guedder/infra/pull/399)

> Este ADR é **proposta**. Nenhuma das três decisões abaixo está aceita.
> Implementação e issues filhas ficam para depois do aceite. O agente que
> preparou a proposta **não** cria issues nem muda código/infra.

## Contexto

O epic GUE-565 ("MCP em produção") precisa de três decisões de segurança
**antes** de abrir o serviço para fora do time. A §15 de `ARQUITETURA.md`
estava desatualizada: dizia que não havia app client de produção. O estado
verificado no Terraform de identity (outubro/2026) é outro.

### Estado verificado (não é decisão — é inventário)

| Peça | Staging | Produção |
|---|---|---|
| Root Terraform do **serviço** MCP (`guedder/mcp/…`) | Existe (`staging`) | **Não existe** — só `guedder/mcp/staging` no repo `infra` |
| Resource server `https://mcp.guedder.com/mcp` | Existe | Existe (mesmo identificador) |
| Escopos no RS MCP | `conta:read`, `pedido:cancelar`, `vendas:read`, `lote:write`, `cupom:write` | Só `conta:read` e `pedido:cancelar` |
| App client `guedder-mcp-agent` | Público (PKCE, sem secret) | Público (PKCE, sem secret) |
| Callbacks do `guedder-mcp-agent` | `localhost:6274`, `claude.ai`, **Postman** (`oauth.pstmn.io`) | `localhost:6274`, `claude.ai` — **sem Postman** |
| TTL | access/id 1h, refresh 1d | Igual |
| IdP federado no client MCP | Google/Facebook quando ligados | Só `COGNITO` (login humano por este client ainda depende de Migration Lambda) |

Fontes: `identity/production/cognito.tf` (resource `aws_cognito_user_pool_client.mcp_agent` e `aws_cognito_resource_server.mcp`); staging via `mcp_agent_callback_urls` em `staging.tfvars`, com Postman adicionado por [infra#399](https://github.com/guedder/infra/pull/399) ("Prod não muda").

**O que já limita o estrago hoje**, com client público: a allowlist de
`callback_urls` e a lista de `allowed_oauth_scopes` do app client. Quem não
está na allowlist não recebe o `code`. Quem não pede (e não tem) o escopo não
passa no `portaoDeEscopo` das tools que o exigem.

---

## Decisão 1 — Client público (PKCE) ou confidencial?

### Problema

O `guedder-mcp-agent` é **público** (`generate_secret = false`). O `client_id`
não é segredo. Um cliente que já o tenha pode ir **direto** ao `/authorize` do
Cognito e **pular a tela de consent do MCP** (ADR 0002, teto registrado no
código em `telaDeConsent`). O Cognito não tem tela de consent por escopo; se o
escopo está no app client e o cliente pede, ele emite.

A alternativa que fecha os dois tetos (tela pública + client público): tornar o
app client **confidencial**, secret só no servidor MCP, e o MCP passar a emitir
a própria sessão — molde na casa: `CheckinSessionTokenService` no
`guedder-api` (JWT RS256, escopos calculados na emissão e congelados, `aud`
amarrado ao serviço, TTL curto, sem revogação como tradeoff assumido).

### Trade-offs

| | Manter público (PKCE) | Virar confidencial + sessão do MCP |
|---|---|---|
| Consent na prática | Camada de UX/autorização; cliente deliberado contorna | Consent vira gate real: o code só troca com secret no MCP |
| Custo de implementação | Zero agora | App client novo (ou ForceNew no atual), secret no Secrets Manager, `/token` deixa de ser repasse puro, emissão/validação de sessão própria, JWKS, rotação de chave, testes de auth inteiros |
| Clientes MCP de IA (Claude.ai, Inspector) | Já funcionam com PKCE público | Precisam falar com o MCP como AS de verdade, não só fachada; exige validar cada cliente |
| Superfície de ataque | Limitada pela allowlist de callbacks | Secret vazado do servidor vira outro problema; janela de revogação herda o tradeoff do check-in |
| Quando se paga | Sempre que o cliente for "nosso" ou allowlisted | Quando existir cliente de terceiro de fato não confiável |

### Recomendação (proposta)

**Aceitar o teto do client público no primeiro piloto.**

Motivos:

1. Os consumidores do piloto são Claude.ai (callback já allowlisted) e o plugin
   da própria Guedder — o mesmo critério que a ADR 0002 já registrou como
   "não se paga enquanto o cliente é o plugin da própria Guedder".
2. Ninguém está conectado em produção ainda; o serviço ECS de prod **ainda não
   existe**. O risco imediato não é abuso em massa, é abrir a porta com o
   desenho errado.
3. Virar confidencial **antes** do piloto atrasa GUE-565 sem mudar o perfil de
   ameaça do piloto (callbacks fechados, escopos mínimos).
4. O gatilho para reabrir continua o mesmo: **cliente de terceiro não
   confiável** ou callback imprevisível (porta local sorteada, DCR de verdade).

O que **não** é recomendação: esquecer o teto. Ele fica escrito na §15 e neste
ADR até a decisão 1 ser aceita ou substituída.

### Issues filhas que esta decisão geraria (não criar agora)

Se **aceitar público no piloto**:

- *(docs/ops)* Registrar no runbook de prod que o teto é aceito e que callback
  novo = revisão de segurança, não chore.
- *(opcional, infra)* Alarme/metricas de `/authorize` do Cognito batendo sem
  passar pelo host do MCP (sinal de bypass) — nice-to-have, não bloqueia piloto.

Se **exigir confidencial antes do piloto**:

- *(mcp)* Emitir sessão própria no molde `CheckinSessionTokenService` (chave
  RS256, JWKS, `aud`, escopos congelados, TTL).
- *(mcp)* `/token` deixa de ser só repasse: troca code↔token com secret e emite
  a sessão do MCP.
- *(infra/identity)* App client confidencial (ou client novo + deprecar o
  público); secret no Secrets Manager; env na task do MCP.
- *(mcp + clientes)* Revalidar Claude.ai, Inspector e plugin com o novo fluxo.

---

## Decisão 2 — Exigir `vendas:read` em `guedder_auditar_vendas_evento` e `guedder_resumo_vendas_evento`?

### Problema

As tools novas de vendas (`guedder_ingressos_vendidos_periodo`,
`guedder_lotes_esgotados`) passam por `portaoDeEscopo(..., "vendas:read", ...)`.
As duas **antigas** de leitura de venda **não**:

```ts
// src/index.ts — TOOLS
{ name: "guedder_auditar_vendas_evento", auth: true, /* sem escopo */ … }
{ name: "guedder_resumo_vendas_evento",  auth: true, /* sem escopo */ … }
```

Quem conectou sem marcar `vendas:read` ainda lê vendas por esses dois caminhos.
A §15 antiga dizia para ligar junto com o consent central, porque "exigir agora
quebraria quem já conectou". Em **produção ninguém está conectado ainda** — a
janela é barata.

### Impacto no código (sem implementar)

Mudança **pequena e local** neste repo:

1. Acrescentar `escopo: "vendas:read"` nas duas entradas da tabela `TOOLS`.
2. O caminho genérico já chama `portaoDeEscopo(t.name, t.escopo, …)` quando
   `t.escopo` está definido — não precisa de handler especial.
3. Atualizar a tabela da §8 / README (coluna Auth) para mostrar
   `✅ vendas:read`.
4. Teste: espelhar o padrão de `comprador.test.mjs` (token sem o escopo →
   recusa). O portão em si já é coberto por `auth.test.mjs` (`exigirEscopo`).
5. Texto em `TEXTO_DO_ESCOPO["vendas:read"]` hoje cita só "ingressos vendidos
   por período e lotes esgotados" — convém alinhar o rótulo da tela de consent
   para incluir auditoria/resumo, senão a pessoa concede sem entender o
   alcance.

**Dependência de infra (bloqueia prod, não o PR de código em staging):** o
resource server de **produção** ainda **não declara** `vendas:read` (só
`conta:read` e `pedido:cancelar`). Staging já tem. Exigir o escopo nas tools
**sem** somá-lo ao RS/app client de prod faz toda leitura de venda falhar assim
que o serviço subir com Cognito ligado. Ordem segura: escopo no Cognito de prod
→ deploy do MCP que exige o escopo → só então abrir conexão.

### Trade-offs

| | Exigir agora (antes do piloto) | Adiar (ligar com consent central) |
|---|---|---|
| Quem quebra | Ninguém em prod; em staging, quem conectou sem o escopo reconecta | Ninguém hoje; amanhã quem conectou em prod sem o escopo |
| Consistência | As quatro tools de venda falam a mesma língua | Continua o buraco que a ADR 0004 já classificou como gap |
| Custo | Uma linha por tool + teste + tfvars/cognito de prod | Zero agora; custo sobe quando houver token em circulação |
| Relação com consent central | Independente — escopo global por enquanto; consent por evento é outro PRD | Acoplar os dois atrasa o fechamento barato |

### Recomendação (proposta)

**Exigir `vendas:read` nas duas tools antigas antes de abrir o piloto em
prod**, na mesma janela em que o resource server de produção ganhar
`vendas:read` (e, se o piloto incluir escrita de lote/cupom, `lote:write` /
`cupom:write`).

Não esperar o consent central por evento: aquele PRD troca *onde* o escopo
recorta; este item fecha *se* o agente pode ler vendas. São eixos diferentes.

### Issues filhas que esta decisão geraria (não criar agora)

Se **exigir** (recomendado):

- *(mcp)* `escopo: "vendas:read"` em `guedder_auditar_vendas_evento` e
  `guedder_resumo_vendas_evento`; alinhar `TEXTO_DO_ESCOPO`; teste de negação;
  docs §8/README.
- *(infra/identity)* Somar `vendas:read` (e os write do piloto) ao
  `aws_cognito_resource_server.mcp` de **produção** e ao
  `allowed_oauth_scopes` do `guedder-mcp-agent` (hoje o client concatena os
  scopes do RS — escopo novo no RS entra no client se o HCL estiver montado
  como em staging; em prod o client usa `scope_identifiers` — conferir plan).

Se **adiar**:

- *(mcp)* Issue de follow-up amarrada ao PRD de consent central, com nota de
  que a janela barata de prod terá fechado.

---

## Decisão 3 — Callbacks do client de produção

### Problema

Callbacks **hoje em produção** (HCL literal em
`identity/production/cognito.tf`):

1. `http://localhost:6274/oauth/callback` — MCP Inspector local
2. `https://claude.ai/api/mcp/auth_callback` — conector Claude.ai

Callbacks **em staging além desses** ([infra#399](https://github.com/guedder/infra/pull/399)):

3. `https://oauth.pstmn.io/v1/callback` — cliente MCP do Postman (só staging
   de propósito; o PR diz "Prod não muda")

**Bot de WhatsApp:** o MCP já trata o chat da Guedder no WhatsApp como persona
de quem produz evento (`PROMPTS_SUGERIDOS` / resource de pedidos sugeridos),
mas **não há** `callback_url` de bot no `guedder-mcp-agent` de staging nem de
produção (busca no Terraform de identity). Se o bot for cliente OAuth do MCP
em prod, o callback precisa entrar na allowlist **antes** da primeira conexão
— senão o Cognito responde `redirect_mismatch`.

Cada callback a mais amplia o destino possível do `authorization code`. Com
client público + PKCE, o code sozinho não basta sem o `code_verifier` de quem
iniciou o fluxo; ainda assim a allowlist é o principal freio do teto da
decisão 1.

### Trade-offs

| Callback | Incluir em prod | Deixar de fora |
|---|---|---|
| `localhost:6274` | Debug com Inspector contra o AS de prod (já está) | Força debug só em staging; remove um redirect HTTP claro |
| `claude.ai` | Piloto no conector que o time já usa (já está) | Piloto sem o cliente principal |
| Postman (`oauth.pstmn.io`) | Engenharia testa o discovery de prod sem staging | Superfície menor; staging já cobre o caso (infra#399) |
| Bot WhatsApp (URL a definir) | Produtor fala com o agente no canal real | Bot não autentica em prod até existir URL + PR de identity |

### Recomendação (proposta)

1. **Manter** `claude.ai` e, por enquanto, `localhost:6274` no piloto (já
   estão; rever se localhost em prod continua desejável depois do piloto).
2. **Não copiar Postman para prod no dia 1** — o #399 foi explícito; staging
   basta para o cliente MCP do Postman. Reabrir se a engenharia precisar
   validar discovery/OAuth **contra o issuer de produção** sem espelho em
   staging.
3. **Bot de WhatsApp: decidir URL e ownership antes do go-live do canal.**
   Sem URL concreta não há o que colocar no Terraform. Se o bot for
   first-party e confidencial (secret no servidor do bot), avaliar client
   **separado** do `guedder-mcp-agent` — misturar callback de bot no client
   do Claude amplia o alvo do client que a pessoa autoriza no plugin.

### Issues filhas que esta decisão geraria (não criar agora)

- *(infra/identity)* Se Postman em prod: espelhar o #399 no root de production
  (tfvars ou HCL literal, conforme o root estiver modelado).
- *(produto + infra)* Se bot WhatsApp: definir URL de callback (e se é o mesmo
  client ou um app client dedicado); PR em `identity/production`.
- *(mcp / bot)* Configurar o cliente OAuth do bot com esse `redirect_uri` e o
  discovery do host de prod (quando o serviço existir).
- *(opcional, segurança)* Remover `localhost:6274` de prod após o piloto, se
  o debug local deixar de ser requisito.

---

## Consequências (quando as três forem aceitas)

- A §15 deixa de mentir sobre "não há app client de produção" e passa a listar
  o inventário + as três decisões com status.
- O piloto em prod pode seguir com client público **desde que** a allowlist de
  callbacks e o conjunto de escopos do RS/app client sejam tratados como
  superfície de segurança (toda adição = PR revisado).
- O buraco de `vendas:read` nas tools antigas deixa de atravessar a porta de
  prod, se a decisão 2 for aceita na ordem Cognito → código.
- Nada deste ADR implementa hospedagem ECS de prod, segredo HMAC em Secrets
  Manager, nem IdP federado em produção — esses continuam itens em aberto
  separados na §15 / epic GUE-565.

## Alternativas transversais consideradas

- **Tratar as três decisões como um único "modo prod endurecido".** Rejeitado
  para o formato HITL: cada uma tem custo e gatilho diferentes; aceitar o
  teto do PKCE não obriga a adiar `vendas:read`.
- **Fechar o teto do consent só com HMAC mais forte.** Não fecha: a tela
  continua pública e o atalho Cognito-direto continua existindo com client
  público (ADR 0002).
- **Client confidencial sem sessão própria do MCP** (só secret no token
  endpoint, token ainda é o do Cognito). Fecha o atalho de trocar code sem o
  MCP, mas clientes públicos de IA (Claude) não guardam secret — incompatível
  com o conector atual. Por isso o molde completo é confidencial **no MCP** +
  sessão emitida aqui.
