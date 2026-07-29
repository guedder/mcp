# guedder-ops-mcp

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
| `guedder_listar_eventos` | — | `GET /api/v3/evento` (MCP: `max_results` padrão 50, máximo 100; sempre página 0) |
| `guedder_get_evento` | — | `GET /api/v3/evento/{id}` |
| `guedder_listar_categorias_evento` | — | `GET /api/v3/evento/categorias/publico` |
| `guedder_listar_atracoes_evento` | — | `GET /api/v3/evento/{eventoId}/atracoes/publico` |
| `guedder_listar_lotes_evento` | — | `GET /api/v3/lote/evento/{eventoId}/publico` |
| `guedder_get_parametros_venda` | — | `GET /api/v3/compra/evento/{eventoId}/parametros-venda/publico` |
| `guedder_get_lote` | ✅ | `GET /api/v3/lote/{codigoOrEventoId}/lote/{codigoOrLoteId}` |
| `guedder_buscar_ingressos_evento` | ✅ | `GET /api/v3/ingresso/{eventoId}/buscar` (MCP: `max_results`, sempre página 0) |
| `guedder_meus_ingressos` | ✅ | `GET /api/v3/ingresso/meus_ingressos/todos` |
| `guedder_minhas_compras` | ✅ | `GET /api/v3/minhas_compras` (MCP: `max_results`, sempre página 0) |
| `guedder_usuario_logado` | ✅ | `GET /api/v3/usuarios/usuario_logado` |

## Cliente MCP local (stdio opcional)

Add to `~/.claude.json` (or project `.mcp.json`) under `mcpServers`:

```json
{
  "mcpServers": {
    "guedder-ops": {
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
