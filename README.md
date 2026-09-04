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

> Antes de expor publicamente, o proxy ou a próxima camada OAuth2 deve autenticar
> os clientes MCP. `GUEDDER_BEARER_TOKEN` autentica somente este servidor perante
> a API Guedder.

## Autenticação

Os endpoints autenticados recebem o token configurado em `GUEDDER_BEARER_TOKEN`.
O MCP o encaminha como `Authorization: Bearer <token>` somente nessas consultas;
não armazena credenciais de usuário nem executa login na API.

Para OAuth2, a futura implementação troca apenas o provedor interno de token
(`tokenProvider`), preservando contratos e ferramentas MCP.

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
