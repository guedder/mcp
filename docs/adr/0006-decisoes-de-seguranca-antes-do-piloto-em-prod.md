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

### Recomendação (proposta)

**Manter o client público (PKCE) no primeiro piloto** — continua coerente.

Motivos:

1. Os consumidores do piloto são Claude.ai (callback allowlisted) e o plugin
   da própria Guedder. O freio real hoje é a allowlist de `callback_urls` +
   escopos do app client, não a tela de consent como barreira criptográfica.
2. “Virar confidencial + emitir sessão” **sem** (a) ou (b) atrasa GUE-565 e
   **não** fecha o bypass — é o custo errado na hora errada.
3. Fechar de verdade exige redesign OAuth ((a) ou (b)), não só um secret no
   Secrets Manager. Esse pacote é desproporcional ao perfil de ameaça do
   piloto (ninguém conectado em prod; serviço ECS de prod ainda não existe).
4. O gatilho para reabrir continua: **cliente de terceiro não confiável** ou
   callback imprevisível — e aí a issue filha tem que escolher (a) ou (b)
   explicitamente, não só “tornar confidencial”.

O teto permanece escrito na §15 e neste ADR. A frase da ADR 0002 sobre “o que
fecharia os dois tetos” fica **incompleta** até essa ADR ser emendada; a
correção normativa para o piloto é esta (0006).

### Issues filhas que esta decisão geraria (não criar agora)

Se **aceitar público no piloto** (recomendado):

- *(docs/ops)* Runbook de prod: teto aceito; callback novo = revisão de
  segurança; não tratar “confidencial sem (a)/(b)” como endurecimento.
- *(docs)* Emendar ADR 0002 / comentários em `telaDeConsent` / README que
  ainda afirmam que confidencial + sessão fecha o bypass sozinho.
- *(opcional, infra)* Métrica de `/authorize` do Cognito sem passar pelo host
  do MCP — sinal de bypass; não bloqueia piloto.

Se **fechar o gate de consent de verdade** (depois do piloto ou se o Danilo
antecipar):

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
  superfície de segurança (toda adição = PR revisado). Não confundir
  “confidencial + sessão” com fechamento do gate de consent — falta (a) ou (b).
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
- **Client confidencial + sessão do MCP, sem (a)/(b).** Parecia fechar o
  bypass (texto antigo da ADR 0002); na prática o cliente ainda autoriza no
  Cognito e usa o `/token` do MCP como proxy com o secret do servidor.
  Descartada como “endurecimento” — custo sem gate.
- **Client confidencial sem sessão própria** (só secret no `/token`, token
  ainda o do Cognito). Mesmo furo se `/token` for repasse cego; e clientes de
  IA públicos não guardam secret no conector atual.
