---
name: guedder-mcp-pagination
description: Padroniza limites de resultados nos tools MCP da Guedder que consultam endpoints paginados. Use ao criar, alterar ou revisar uma ferramenta MCP de leitura com paginação.
---

# Paginação dos tools MCP Guedder

## Contrato MCP

Exponha somente `max_results` para consultas que retornam páginas.

```ts
max_results: z.number().int().min(1).max(100).default(50)
```

- Não exponha `page`, `pageSize`, `page_size`, `size` ou `limit` no contrato MCP.
- A ferramenta sempre consulta a primeira página: `page: 0`.
- Traduza `max_results` para o nome exigido pela API Guedder: normalmente `size`; em
  `/api/v3/evento`, `page_size`.
- Descreva no tool o padrão e o teto de 100 resultados.

## Aplicação

1. Confirme no controller/contrato da API qual parâmetro de tamanho o endpoint aceita.
2. Atualize o `inputSchema` e o `build` juntos.
3. Atualize README e testes para usar `max_results`.
4. Teste que o parâmetro MCP limita a resposta real ou a API simulada.

## Exemplo

```ts
inputSchema: { max_results: z.number().int().min(1).max(100).default(50) },
build: (args) => ({ path: "/api/v3/recurso", query: { page: 0, size: args.max_results } }),
```
