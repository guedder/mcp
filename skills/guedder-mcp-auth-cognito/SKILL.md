---
name: guedder-mcp-auth-cognito
description: Como a autenticação Cognito do MCP Guedder liga e o que cada env var faz. Use ao configurar deploy autenticado, depurar 401 no MCP, ou decidir entre modo público e modo com token.
---

# Auth Cognito do MCP Guedder

## Dois modos

| Modo | Liga com | Tools | Token |
|---|---|---|---|
| Público | `GUEDDER_MCP_PUBLIC_ONLY=1` | só as 7 GETs de evento | nenhum |
| Autenticado | `GUEDDER_COGNITO_ISSUER` setado | todas (conforme perfil) | JWT do Cognito no `Authorization` |

Sem `GUEDDER_COGNITO_ISSUER` o módulo `src/auth.ts` fica inerte e o servidor cai no
token estático de processo (`GUEDDER_BEARER_TOKEN`) — só para stdio local e smoke.

## Como valida (modo autenticado)

`src/auth.ts::createVerifier` — o usuário faz **um** login Guedder; o access token dele
chega no `Authorization` do request MCP e é:

1. verificado contra o JWKS de `<issuer>/.well-known/jwks.json` (issuer = `GUEDDER_COGNITO_ISSUER`);
2. amarrado ao app client: `payload.client_id` tem que bater `GUEDDER_MCP_CLIENT_ID`
   (access token do Cognito não tem `aud` — a amarração de superfície é pelo `client_id`);
3. resolvido para um `Caller`: `email`, `custom:usuario_id`, `custom:role`, `scopes`.
   `isAdmin = role === "ADMIN"` (a Pre-Token Lambda copia `usuario.role`, nunca emite `custom:is_admin`).

Quando o token traz `aud` (só quando o cliente pediu `resource=`, RFC 8707), ele também
é conferido contra `GUEDDER_MCP_RESOURCE`. As duas checagens somam, não se substituem:
`aud` sozinho não bastaria porque qualquer app client do pool pode pedir `resource=` com
a nossa URL.

## Escopo não é papel

| | responde |
|---|---|
| `custom:role` | até onde a **pessoa** alcança |
| `scopes` | o que ela autorizou o **agente** a fazer por ela |

`exigirEscopo(caller, "pedido:cancelar")` é o portão único, e **não tem bypass de
admin**. Um admin que conectou o agente só para consulta não autorizou cancelamento, e
é no admin que o estrago seria maior. Tem teste segurando isso.

Os escopos chegam prefixados pelo identificador do resource server
(`https://mcp.guedder.com/mcp/pedido:cancelar`), igual ao que o n8n vive com o resource
server da API. `escoposDoToken` descasca num lugar só. Escopo de OUTRO resource server é
descartado, não aceito pelo sufixo: senão `https://api.guedder.com/pedido:cancelar`
abriria a tool de cancelamento daqui.

A tela de consent é servida por este servidor em `/authorize` porque o Cognito não tem
uma. Ela intersecta o que foi marcado com `GUEDDER_MCP_SCOPES` antes de redirecionar,
então escopo forjado na query não vira concessão.

O token do `Caller` é repassado à API Guedder nas tools `auth:true`. As tools de
auditoria (`guedder_rastrear_compra`) NÃO agem como o usuário — usam a credencial AWS
da task; o portão de admin é no servidor (`isAdmin`), não na API.

## Env vars

| Var | Papel |
|---|---|
| `GUEDDER_COGNITO_ISSUER` | issuer do pool. Vazio = auth desligada. |
| `GUEDDER_MCP_CLIENT_ID` | `client_id` do app client do agente. Token de outro client é recusado. |
| `GUEDDER_MCP_RESOURCE` | audiência declarada na metadata RFC 9728 (default `https://mcp.guedder.com/mcp`). |
| `GUEDDER_MCP_SCOPES` | escopos que o app client permite, nomes COMPLETOS (com prefixo do resource server). Default `openid email profile`. |
| `GUEDDER_BEARER_TOKEN` | fallback estático, só sem Cognito. |

## Depurar 401

- `WWW-Authenticate: Bearer resource_metadata=...` no 401 → o cliente busca
  `/.well-known/oauth-protected-resource` e daí o authorization server.
- "Token emitido para outro client" → `GUEDDER_MCP_CLIENT_ID` não bate o `client_id` do token.
- "Token sem email" → pool sem claim `email`/`cognito:username`.
- `isAdmin` sempre false com token de admin → conferir se a Pre-Token Lambda está
  populando `custom:role` (sem Postgres alcançável, nenhum `custom:*` sai).

Staging: pool `us-east-1_UhlIAqn5b`, hosted UI
`guedder-auth-staging.auth.us-east-1.amazoncognito.com`. Fonte da verdade do app
client: `guedder/identity/staging/cognito.tf`.
