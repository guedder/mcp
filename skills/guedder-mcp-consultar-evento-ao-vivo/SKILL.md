---
name: guedder-mcp-consultar-evento-ao-vivo
description: Fluxo das tools públicas do MCP Guedder para responder sobre um evento (data, local, line-up, lotes, formas de pagamento). Use ao responder pergunta de comprador sobre um evento específico.
---

# Consultar dados de evento ao vivo

## Fluxo (sempre dois passos)

1. **Ache o evento e o id.**
   - Busca por nome / cidade / categoria: `guedder_listar_eventos` (`filtro`, `nomeCidade`, `nomeEstado`, `categoriaEventoEnum`).
   - O que está em cartaz: `guedder_eventos_destaque` (sem input).
   - O id é UUID ou código alfanumérico. Nunca invente.

2. **Consulte pelo id o que a pergunta pede.**

   | Pergunta | Tool |
   |---|---|
   | Quando / onde é | `guedder_get_evento` |
   | Line-up / atrações | `guedder_listar_atracoes_evento` |
   | Lotes e preços | `guedder_listar_lotes_evento` |
   | Formas de pagamento, parcelamento, taxa | `guedder_get_parametros_venda` |
   | Categorias para filtrar | `guedder_listar_categorias_evento` |

## Regras

- `guedder_get_parametros_venda` pode responder **404**: significa que o organizador
  ainda não configurou. Diga "ainda não divulgado" — não é erro, não é evento inexistente.
- Só GETs. Nada de mutação.
- Schema de saída de cada tool: resource `guedder://openapi/v3/tools/<nome>`.

## Exemplo

> "Quais as formas de pagamento do Rock in Rio?"

```
guedder_listar_eventos({ filtro: "Rock in Rio" })      -> pega o id
guedder_get_parametros_venda({ eventoId: "<id>" })     -> responde
```
