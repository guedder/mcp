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
3. resolvido para um `Caller`: `email`, `custom:usuario_id`, `custom:role`.
   `isAdmin = role === "ADMIN"` (a Pre-Token Lambda copia `usuario.role`, nunca emite `custom:is_admin`).

O token do `Caller` é repassado à API Guedder nas tools `auth:true`. As tools de
auditoria (`guedder_rastrear_compra`) NÃO agem como o usuário — usam a credencial AWS
da task; o portão de admin é no servidor (`isAdmin`), não na API.

## Env vars

| Var | Papel |
|---|---|
| `GUEDDER_COGNITO_ISSUER` | issuer do pool. Vazio = auth desligada. |
| `GUEDDER_MCP_CLIENT_ID` | `client_id` do app client do agente. Token de outro client é recusado. |
| `GUEDDER_MCP_RESOURCE` | audiência declarada na metadata RFC 9728 (default `https://mcp.guedder.com/mcp`). |
| `GUEDDER_MCP_SCOPES` | escopos que o app client permite (default `openid email profile`). |
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
