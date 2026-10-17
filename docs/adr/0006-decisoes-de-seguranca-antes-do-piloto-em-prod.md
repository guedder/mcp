# ADR 0006 — Decisões de segurança antes de abrir o MCP para fora do piloto

**Status**: Aceito — 2026-10-17 (HITL: Danilo — GUE-569, epic GUE-565)
**Depende de**: ADR 0002 (tela de consent + teto do client público), ADR 0005 (hospedagem em staging)
**Relacionado**: ADR 0007 (auth MCP via WhatsApp/Telegram — proposta)
**Terraform verificado**: `guedder/infra` @ `guedder/identity/production/cognito.tf`,
`guedder/identity/staging/cognito.tf`, `guedder/identity/staging/staging.tfvars`,
[guedder/infra#399](https://github.com/guedder/infra/pull/399)

> As três decisões deste ADR foram **aceitas** (Danilo, 2026-10-17).
> Implementação e issues filhas listadas abaixo — **não criadas** neste PR.
> WhatsApp/Telegram continuam na ADR 0007 (proposta separada).

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

**Status**: Aceita — 2026-10-17 (Danilo)

**Decisão**: manter o `guedder-mcp-agent` **público (PKCE)** no primeiro piloto.
O teto (bypass da tela de consent via `/authorize` do Cognito) é aceito neste
recorte. Fechar o gate de verdade fica para depois, e exige o pacote da
correção Codex ((a) ou (b) abaixo) — não só “confidencial + sessão”.

### Problema

O `guedder-mcp-agent` é **público** (`generate_secret = false`). O `client_id`
não é segredo. Um cliente que já o tenha pode ir **direto** ao `/authorize` do
Cognito e **pular a tela de consent do MCP** (ADR 0002, teto registrado no
código em `telaDeConsent`). O Cognito não tem tela de consent por escopo; se o
escopo está no app client e o cliente pede, ele emite.

### O que NÃO fecha o bypass (correção à ADR 0002)

A ADR 0002 (e a §7 da ARQUITETURA, antes desta revisão) diziam que fechar os
dois tetos era: **app client confidencial + MCP emitir a própria sessão**
(molde `CheckinSessionTokenService`). Isso **não basta**.

Com callback allowlisted no Cognito (o caso do Claude.ai e do Inspector), o
fluxo de bypass continua mesmo com secret só no MCP:

1. o cliente vai **direto** ao `/authorize` do Cognito — o Cognito **não exige
   o secret** no authorize;
2. o Cognito devolve o `code` no callback allowlisted do cliente;
3. o cliente manda `code` + PKCE `code_verifier` ao `/token` **público** do
   MCP (fachada);
4. o MCP acrescenta o secret, troca o code no Cognito e — se emitir outra
   sessão — devolve um JWT novo.

Emitir outro JWT **depois** da troca não prova que a tela de consent rodou.
O secret no MCP só impede que o *cliente* chame o `/token` do Cognito
direto; não impede que ele use o `/token` do MCP como proxy após um
authorize que pulou o consent.

**A alternativa confidencial só vale se o desenho também fizer uma destas:**

| | (a) Transação de consent no servidor | (b) Callback upstream do MCP + code downstream |
|---|---|---|
| Ideia | `/token` só troca code se existir uma transação de consent (prova HMAC / nonce de uso único / registro) amarrada a esse `code` (ou ao `state`/`code_challenge` que o produziu) | `callback_urls` do Cognito apontam **só** para o MCP; o MCP, após consent + login, emite um **code próprio** para o `redirect_uri` do cliente downstream |
| O que o bypass perde | Code obtido no Cognito-direto não tem transação → `/token` do MCP recusa | Cliente nunca recebe o code do Cognito; o code que ele troca só nasce depois do consent no MCP |
| Custo extra além de “confidencial + sessão” | Estado (ou prova verificável) ligando consent → code; `/token` deixa de ser repasse cego | MCP vira AS de verdade para o cliente: callback próprio, emissão de code, PKCE downstream, documentação/compat com Claude.ai e Inspector |

Sem (a) ou (b), “confidencial + sessão” é custo pago sem fechar o gate.

### Trade-offs

| | Manter público (PKCE) | Confidencial + sessão **sem** (a)/(b) | Confidencial + sessão **com** (a) ou (b) |
|---|---|---|---|
| Consent na prática | Camada de UX; cliente deliberado contorna | **Ainda contorna** (authorize Cognito → `/token` do MCP) | Consent vira gate real |
| Custo de implementação | Zero agora | Secret, `/token` com Basic, sessão própria, JWKS — **e o bypass permanece** | Tudo da coluna do meio **mais** transação de consent amarrada ao code **ou** callback upstream + code downstream; revalidar cada cliente MCP |
| Clientes MCP de IA | Já funcionam com PKCE público | Podem continuar falando com a fachada, mas o ganho de segurança é ilusório | Mudança de contrato OAuth; Claude.ai / Inspector / plugin precisam do fluxo novo |
| Superfície de ataque | Limitada pela allowlist de `callback_urls` e pelos escopos do app client | Secret no servidor + mesma allowlist; bypass de consent intacto | Allowlist pode encolher (em (b), só o MCP); secret e estado de consent passam a ser críticos |
| Quando se paga | Piloto com clientes allowlisted | Nunca — não compra o que parece comprar | Quando existir cliente de terceiro não confiável **e** houver orçamento para (a) ou (b) |

### Recomendação → aceite

A recomendação de manter PKCE público no piloto foi **aprovada pelo Danilo**.
Motivos que sustentaram o aceite (inalterados):

1. Consumidores do piloto: Claude.ai + plugin Guedder; freio = allowlist de
   `callback_urls` + escopos.
2. “Confidencial + sessão” sem (a)/(b) não fecha o bypass (achado Codex P1).
3. Fechar de verdade é redesign OAuth, desproporcional ao piloto.
4. Gatilho para reabrir: cliente de terceiro não confiável / callback
   imprevisível — e aí escolher (a) ou (b) de propósito.

Auth de **WhatsApp/Telegram** (Hermes) **não** entra neste client público do
Claude: ver ADR 0007 (client messenger dedicado).

### Issues filhas sugeridas (não criar agora)

Do aceite do piloto (follow-ups baratos):

- *(docs/ops)* Runbook de prod: teto aceito; callback novo = revisão de
  segurança; não tratar “confidencial sem (a)/(b)” como endurecimento.
- *(docs)* Emendar ADR 0002 / comentários em `telaDeConsent` / README que
  ainda afirmam que confidencial + sessão fecha o bypass sozinho.
- *(opcional, infra)* Métrica de `/authorize` do Cognito sem passar pelo host
  do MCP — sinal de bypass; não bloqueia piloto.

Se **fechar o gate de consent de verdade** (depois do piloto):

- *(mcp, desenho)* Escolher **(a) transação de consent amarrada ao `/token`**
  ou **(b) callback upstream do MCP + code downstream** — ADR de implementação
  antes de código.
- *(mcp)* Se (a): persistir/verificar a prova de consent no momento do
  `/token`; recusar code sem transação; testes de bypass Cognito-direto.
- *(mcp)* Se (b): endpoint de callback Cognito→MCP; emissão de authorization
  code próprio; PKCE/state downstream; `callback_urls` do Cognito = só o MCP.
- *(mcp)* Sessão própria (molde `CheckinSessionTokenService`) **como peça do
  pacote (a)/(b)**, não como solução isolada — JWKS, `aud`, TTL, rotação.
- *(infra/identity)* App client confidencial (secret no SM) **e**, no caso (b),
  remoção dos callbacks de terceiros da allowlist do Cognito.
- *(mcp + clientes)* Revalidar Claude.ai, Inspector e plugin no fluxo escolhido.

---

## Decisão 2 — Exigir `vendas:read` em `guedder_auditar_vendas_evento` e `guedder_resumo_vendas_evento`?

**Status**: Aceita — 2026-10-17 (Danilo)

**Decisão**: exigir `vendas:read` nas duas tools antigas **antes** do piloto em
prod, na ordem Cognito prod (escopo no RS/app client) → código MCP → abrir
conexão. Não esperar o consent central por evento.

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

### Recomendação → aceite

A recomendação de exigir `vendas:read` antes do piloto foi **aprovada pelo
Danilo**. Consent central por evento continua eixo separado (onde o escopo
recorta); este item fecha *se* o agente pode ler vendas.

### Issues filhas decorrentes (não criar agora)

- *(infra/identity)* Somar `vendas:read` (e, se o piloto incluir escrita,
  `lote:write` / `cupom:write`) ao `aws_cognito_resource_server.mcp` de
  **produção** e garantir que o `guedder-mcp-agent` de prod as liste em
  `allowed_oauth_scopes` (em prod o client usa `scope_identifiers` — conferir
  plan: escopo novo no RS precisa aparecer no client).
- *(mcp)* `escopo: "vendas:read"` em `guedder_auditar_vendas_evento` e
  `guedder_resumo_vendas_evento`; alinhar `TEXTO_DO_ESCOPO` (incluir
  auditoria/resumo); teste de negação (padrão `comprador.test.mjs`); docs
  §8/README.
- *(ops)* Ordem de deploy: Cognito prod com o escopo **antes** do MCP que
  exige — senão leitura de venda 403 assim que o serviço subir.

---

## Decisão 3 — Callbacks do client de produção

**Status**: Aceita — 2026-10-17 (Danilo)

**Decisão**:

1. **Manter** em prod: `https://claude.ai/api/mcp/auth_callback` e callbacks
   **localhost** para clientes locais (Inspector já em
   `http://localhost:6274/oauth/callback`; **Codex** e outros clientes locais
   no mesmo espírito — ver cuidados abaixo).
2. **Postman** (`oauth.pstmn.io`): **só staging** (infra#399). Não copiar para
   prod no piloto.
3. **WhatsApp/Telegram**: **não** no `guedder-mcp-agent` — ADR 0007 (client
   messenger dedicado).

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

### Recomendação → aceite

A recomendação (Claude + localhost no piloto; Postman só staging; messenger
fora deste client) foi **aprovada pelo Danilo**, com o acréscimo explícito de
que **localhost serve a clientes locais como o Codex**, não só ao Inspector.

### Cuidados com callbacks `localhost` (obrigatório registrar)

O Cognito compara `redirect_uri` por **igualdade exata** (scheme + host +
porta + path). Consequências práticas do aceite:

| Regra | Por quê |
|---|---|
| **Sem wildcard** | Cognito **não** aceita `http://localhost:*/…` nem glob. Cada porta/path é uma entrada na allowlist. |
| **Porta e path fixos por cliente** | Inspector hoje: `http://localhost:6274/oauth/callback`. Codex (ou outro cliente local) só funciona se a URL **exata** que ele usa estiver listada — descobrir a URL do cliente e somar em PR de identity, não adivinhar. |
| **HTTP em localhost** | Aceito pelo Cognito para loopback; não usar `http://` em host público. |
| **Risco residual** | Com client público + PKCE, um `code` entregue a `localhost` só completa o fluxo com o `code_verifier` de quem iniciou. Ainda assim cada URL localhost a mais é superfície: só adicionar a que um cliente real do time usa, com PR revisado. |
| **Não é DCR** | Porta sorteada a cada run (= redirect imprevisível) **não** cabe nesta allowlist; exige client/registro dinâmico (fora do piloto). |

Somar um localhost novo ≠ “liberar todo localhost”: é uma linha literal no
Terraform, igual ao `6274` atual.

### Issues filhas decorrentes (não criar agora)

- *(infra/identity)* Inventariar a `redirect_uri` **exata** do Codex (e de
  qualquer outro cliente local do piloto); se ≠ `6274/oauth/callback`, PR
  adicionando a URL literal em `identity/production` (e staging se fizer
  falta). Sem wildcard.
- *(docs/ops)* Runbook: “callback localhost novo = URL fixa + PR”; Postman
  permanece só staging; não misturar Hermes neste client.
- *(adr/produto)* WhatsApp/Telegram: seguir ADR 0007 (client dedicado) —
  issues filhas listadas lá, não aqui.
- *(não fazer no piloto)* Espelhar Postman em prod; abrir allowlist para
  portas dinâmicas.

---

## Consequências (as três aceitas)

- A §15 reflete inventário + decisões aceitas; issues de implementação
  ficam listadas, não abertas neste PR.
- Piloto em prod: client público (Decisão 1); allowlist de callbacks =
  Claude + localhosts **literais** necessários (Decisão 3); escopos de
  venda coerentes nas quatro tools (Decisão 2), na ordem Cognito → MCP.
- Não confundir “confidencial + sessão” com fechamento do gate de consent —
  falta (a) ou (b) da Decisão 1.
- Nada deste ADR implementa hospedagem ECS de prod, segredo HMAC em Secrets
  Manager, IdP federado em produção, nem o fluxo Hermes (ADR 0007).

## Alternativas transversais consideradas

- **Tratar as três decisões como um único "modo prod endurecido".** Rejeitado
  para o formato HITL: cada uma tem custo e gatilho diferentes; aceitar o
  teto do PKCE não obriga a adiar `vendas:read`.
- **Fechar o teto do consent só com HMAC mais forte.** Não fecha: a tela
  continua pública e o atalho Cognito-direto continua existindo com client
  público (ADR 0002).
- **Client confidencial + sessão do MCP, sem (a)/(b).** Parecia fechar o
  bypass (texto antigo da ADR 0002); na prática o cliente ainda autoriza no
  Cognito e usa o `/token` do MCP como proxy com o secret do servidor.
  Descartada como “endurecimento” — custo sem gate.
- **Client confidencial sem sessão própria** (só secret no `/token`, token
  ainda o do Cognito). Mesmo furo se `/token` for repasse cego; e clientes de
  IA públicos não guardam secret no conector atual.
