# ADR 0007 — Autenticar o MCP pelo WhatsApp e pelo Telegram (Hermes)

**Status**: Proposto — 2026-10-17 (HITL: Danilo — epic GUE-565 / follow-up GUE-569)
**Depende de**: ADR 0001 (MCP front door OAuth), ADR 0002 (consent + HMAC),
ADR 0006 Decisão 1 aceita (PKCE público no `guedder-mcp-agent` do piloto Claude)
**Fora de escopo deste ADR**: implementar; criar issues; mudar Cognito/código.

> Opções citadas pelo Danilo: **(A)** link que leva a login com OTP;
> **(B)** callback direto para o Hermes. Este documento analisa o que o código
> e a infra **já têm**, desenha os dois fluxos, e dá **uma** recomendação que
> serve aos dois canais.

## Inventário verificado (o que existe hoje)

### `guedder/mcp`

| Peça | Comportamento relevante |
|---|---|
| `GET /authorize` | Serve a tela de consent; com prova HMAC (`consentido`) redireciona ao Cognito com interseção de escopos + `resource=` |
| Prova HMAC | `client_id \| redirect_uri \| state \| code_challenge \| bloco-10-min`; `timingSafeEqual`; não é barreira criptográfica (tela pública) |
| `POST /token` | **Repasse cego** ao Cognito (form-urlencoded); não valida consent; não emite sessão própria |
| `/register` | Mascarado: devolve o `client_id` fixo do app client; callbacks reais = allowlist Cognito |
| App client em uso | `guedder-mcp-agent`, **público** (PKCE) — Decisão 1 da ADR 0006 **aceita** para o piloto Claude |
| Callbacks desse client | Prod: `localhost:6274`, `claude.ai`. Staging: + Postman. **Nenhum** callback WhatsApp/Telegram/Hermes |

### Cognito / `guedder-api` / auth

| Peça | Situação |
|---|---|
| Login humano Cognito | Senha (`USER_PASSWORD_AUTH` + Migration Lambda) e IdPs (Google/Facebook em staging; prod ainda só `COGNITO` no client MCP) |
| **OTP / login por telefone** | **Não encontrado** no `guedder-api` nem triggers `CUSTOM_AUTH` / SMS OTP no repo `auth`. MFA TOTP opcional no pool de staging ≠ login por SMS |
| Migration Lambda | Materializa usuário no pool a partir do Postgres legado no primeiro login por senha; não autentica WhatsApp |
| Hermes | Aparece no caminho de alertas (n8n → Hermes → WhatsApp) em `guedder/infra`; **não** há app client OAuth nem callback MCP documentados para o Hermes |
| Vínculo telefone↔conta | Conta Guedder é e-mail/`usuario_id`; número de WhatsApp/Telegram **não** é claim de identidade do token MCP hoje |

Consequência: a opção (A) “login com OTP” **não** é um caminho pronto no Cognito.
OTP precisa ser (i) produto novo (CUSTOM_AUTH / SMS / e-mail), ou (ii)
reinterpretado como **prova de posse do chat** antes do OAuth existente.

---

## Premissas do desenho

1. O agente atrás do WhatsApp **e** do Telegram é o **mesmo Hermes** (um
   processo server-side com secret).
2. O token que as tools do MCP exigem continua sendo o **Bearer da pessoa**
   (mesma `Caller` / escopos / `portaoDeEscopo`).
3. Não misturar callback do messenger no `guedder-mcp-agent` (client do Claude
   / Inspector) — amplia a allowlist do client que o piloto Claude usa
   (ADR 0006).
4. Um desenho, dois canais: só muda `channel` ∈ {`whatsapp`,`telegram`} e o
   `chat_id` nativo.

---

## Opção A — Link enviado ao usuário → login com OTP

### Fluxo passo a passo

```
1. Pessoa no chat: "conectar" / "ligar Guedder"
2. Hermes cria bind_id (aleatório, TTL curto, ex. 10 min) e grava:
     { bind_id, channel, chat_id, status: pending }
3. Hermes envia link HTTPS no chat:
     https://<host-mcp-ou-portal>/conectar?bind=<bind_id>
4a. [OTP-no-chat] Hermes manda código de 6 dígitos no MESMO chat;
    pessoa confirma no link (ou o link só abre depois da confirmação).
4b. [OTP-produto] Página pede OTP por e-mail/SMS Cognito — HOJE NÃO EXISTE.
5. Pessoa autentica na conta Guedder (Cognito: senha/Google, via /authorize
   do MCP → tela de consent → Cognito).
6. redirect_uri do authorize aponta para um callback que conclui o bind
   (ver recomendação: callback do Hermes, não do Claude).
7. Hermes (ou o MCP) associa chat_id ↔ tokens da pessoa; confirma no chat.
```

### Como o token fica ligado ao chat

Tabela (Hermes ou store compartilhado):

| Campo | Exemplo |
|---|---|
| `channel` | `whatsapp` \| `telegram` |
| `chat_id` | id estável do provedor |
| `usuario_id` / `sub` | do token Cognito |
| `access_token` | TTL curto (1h, igual app client) |
| `refresh_token` | se houver; refresh 1d no agent atual |
| `scopes` | congelados na emissão |
| `bound_at` / `expires_at` | |

Toda mensagem do chat → Hermes resolve `chat_id` → Bearer → chama MCP/API.

### Expiração / revogação

- Access: TTL do Cognito (1h no `guedder-mcp-agent`; messenger dedicado pode
  espelhar).
- Refresh: revogável via Cognito `RevokeToken` / `GlobalSignOut`.
- Bind: comando "desconectar" no chat apaga a linha; link antigo com
  `bind_id` expirado não reassocia.
- Sem revogação de access já emitido (mesmo tradeoff do check-in / ADR 0006).

### Riscos

| Risco | Mitigação |
|---|---|
| Phishing do link | Host fixo HTTPS na allowlist; bind TTL curto; nunca pedir senha no chat |
| Replay do OTP | OTP de uso único, TTL ~5 min, rate limit por `chat_id` |
| Link encaminhado | Bind amarra ao `chat_id` que **recebeu** o link; OTP no mesmo chat prova posse |
| Número ≠ conta | Login Cognito escolhe a conta; OTP-no-chat não prova e-mail — avisar na tela |
| OTP Cognito inexistente | Não fingir: ou construir CUSTOM_AUTH/SMS, ou usar OTP-no-chat + login existente |

### Mudanças em Cognito / client

- **Não** adicionar callback no `guedder-mcp-agent`.
- Client novo (ver recomendação) ou, se insistir em A puro com callback no MCP:
  callback HTTPS do MCP na allowlist + sessão/bind no MCP (estado novo).

---

## Opção B — Callback direto para o Hermes

### Fluxo passo a passo

```
1. Pessoa: "conectar"
2. Hermes cria state = bind_id amarrado a {channel, chat_id}, TTL curto
3. Hermes (ou link no chat) abre o /authorize do MCP com:
     client_id=<messenger>, redirect_uri=https://hermes…/oauth/callback,
     state=<bind_id>, PKCE, scope=…
4. Tela de consent do MCP → Cognito login
5. Cognito 302 → https://hermes…/oauth/callback?code=…&state=…
6. Hermes valida state, troca code no /token (com secret se confidencial),
   guarda tokens sob chat_id, confirma no chat
```

Sem o passo do link, o authorize não começa: WhatsApp/Telegram **não** são
navegador OAuth. Na prática B **sempre** começa com um link ou botão — a
diferença é para **onde** o `code` volta (Hermes vs página intermediária).

### Token ↔ chat / expiração / riscos

Igual à opção A na tabela de vínculo e nos TTLs. Riscos específicos:

| Risco | Mitigação |
|---|---|
| Callback Hermes na allowlist do client Claude | **Client Cognito separado** |
| Hermes vira AS parcial | Secret só no Hermes; `/token` do MCP continua repasse; PKCE + state |
| state forjado | `state` = bind opaco de uso único, não o chat_id em claro |
| Code interceptado | HTTPS; PKCE; confidential client |

### Mudanças em Cognito / client

- App client novo `guedder-mcp-messenger` (nome sugerido):
  - `generate_secret = true` (Hermes guarda o secret)
  - `callback_urls` = **somente** `https://<hermes>/oauth/callback` (staging + prod)
  - mesmos escopos do RS MCP que o piloto precisar
  - TTL alinhado ao risco (access 1h, refresh curto)
- **Zero** mudança de callback no `guedder-mcp-agent`

---

## Comparativo

| | A (link + OTP) | B (callback Hermes) | Híbrido recomendado |
|---|---|---|---|
| Prova de posse do chat | OTP-no-chat forte | Fraca se só o link | OTP-no-chat **ou** state amarrado ao chat que recebeu o link |
| Login conta Guedder | OTP Cognito (não existe) ou senha/Google | Senha/Google via consent MCP | Senha/Google via consent MCP (caminho real) |
| Onde o `code` cai | Depende do `redirect_uri` | Hermes | Hermes |
| Serve WhatsApp e Telegram | Sim (mesmo link) | Sim (mesmo callback) | Sim |
| Cabe no PKCE público do Claude | Não misturar | Não misturar | Client messenger dedicado |

---

## Recomendação única (WhatsApp **e** Telegram)

**Híbrido: link de vínculo no chat + callback OAuth no Hermes + client Cognito
dedicado confidencial. OTP = prova de posse do chat (no próprio canal), não
login Cognito — até existir produto OTP de verdade.**

Passos canônicos:

1. **Infra/identity:** criar `guedder-mcp-messenger` (confidencial), callback
   só `https://<hermes>/oauth/callback`. Não tocar no `guedder-mcp-agent`.
2. **Hermes:** ao "conectar", criar `bind_id` → `{channel, chat_id}`; opcional
   mas recomendado: OTP de 6 dígitos **no mesmo chat** antes de aceitar o bind.
3. **Link:** abre o `/authorize` do MCP com `client_id` do messenger,
   `redirect_uri` do Hermes, `state=bind_id`, PKCE, escopos do RS.
4. **MCP:** tela de consent + HMAC como hoje; repasse ao Cognito; `/token`
   continua repasse (Hermes manda Basic com o secret).
5. **Hermes callback:** valida `state`, troca o code, persiste tokens sob
   `(channel, chat_id)`, manda "conectado como &lt;email&gt;" no chat.
6. **Uso:** cada pedido no chat → Bearer armazenado → tools MCP.
7. **Desconectar / expirar:** apaga bind; revoga refresh no Cognito se
   disponível.

Por que esta e não A “puro” ou B “puro”:

- A puro depende de OTP Cognito/telefone **que não existe**; inventar login SMS
  agora é outro epic.
- B sem link não inicia em messenger; B sem client dedicado contamina o client
  do Claude (ADR 0006).
- O híbrido reutiliza consent/HMAC/`/authorize` já pagos, serve aos dois
  canais com uma allowlist, e trata o número como **canal de entrega**, não
  como identidade Guedder.

### O que deliberadamente não recomendamos

- Colocar callback do Hermes no `guedder-mcp-agent` público.
- Confiar só no link sem `state`/bind (encaminhamento = sequestro de conta).
- Mapear `chat_id` → usuário só pelo número de telefone sem login Cognito
  (conta errada / número reciclado).

---

## Issues filhas sugeridas (não criar agora)

1. *(infra/identity)* App client `guedder-mcp-messenger` (staging → prod):
   secret, callback Hermes, escopos do RS MCP, TTL.
2. *(hermes)* Store de bind `(channel, chat_id) ↔ tokens`; comando
   conectar/desconectar; OTP-no-chat opcional na v1.
3. *(hermes)* Endpoint `GET/POST /oauth/callback` + troca de code via
   `/token` do MCP (Basic + PKCE).
4. *(mcp)* Documentar o client messenger na metadata/`/register` se o
   discovery precisar anunciar mais de um client — ou hardcode no Hermes
   (provável na v1).
5. *(mcp/docs)* Emendar ADR 0002 / README: messenger ≠ client Claude.
6. *(produto/auth, depois)* Se quiser OTP Cognito de verdade: CUSTOM_AUTH ou
   SMS — epic separado; não bloqueia o híbrido.
7. *(segurança)* Runbook: rotação do secret Hermes; revogação; o que fazer se
   o número mudar de dono.

## Consequências (se aceita)

- Piloto Claude (ADR 0006 Decisão 1) permanece intocado.
- WhatsApp e Telegram compartilham um client e um callback.
- O MCP continua front door de consent; o Hermes passa a ser o detentor do
  refresh da pessoa no canal — superfície nova a proteger (secret + store).
