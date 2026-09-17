---
name: guedder-mcp-consultar-evento-ao-vivo
description: Fluxo das tools públicas do MCP Guedder para responder sobre um evento (data, local, line-up, lotes, formas de pagamento). Use ao responder pergunta de comprador sobre um evento específico.
---

# Consultar dados de evento ao vivo

## Fluxo (sempre dois passos)

1. **Ache o evento e o id.** `guedder_descobrir_eventos`.
   - Sem nenhum filtro: destaques da home (o que está em cartaz agora).
   - Com `cidade` / `estado` / `categoria` / `busca`: procura no catálogo completo.
   - O id é UUID ou código alfanumérico. Nunca invente.

2. **Consulte pelo id.** `guedder_detalhes_evento`.
   - Sem `incluir`: só o básico (nome, data, local).
   - `incluir: ["atracoes"]` — line-up.
   - `incluir: ["lotes"]` — lotes e preços.
   - `incluir: ["venda"]` — formas de pagamento, parcelamento, taxa.
   - Pode pedir mais de um de uma vez: `incluir: ["atracoes", "lotes", "venda"]`.
   - Categorias para filtrar em `descobrir_eventos`: `guedder_listar_categorias_evento`.

## Regras

- `parametrosVenda: null` (dentro de `guedder_detalhes_evento` com `incluir: ["venda"]`)
  significa que o organizador ainda não configurou (404 internamente). Diga "ainda não
  divulgado" — não é erro, não é evento inexistente.
- Estas duas tools são compostas: cada uma pode chamar mais de um endpoint por dentro.
  O schema de saída de cada uma está no resource `guedder://openapi/v3/tools/<nome>`,
  que lista TODAS as operações que ela pode acionar, não uma só.
- Este servidor não é só-leitura: existe `guedder_cancelar_pedido`, fora do escopo desta
  skill (ver `guedder-mcp-auth-cognito` e o README para o fluxo de escrita).

## Exemplo

> "Quais as formas de pagamento do Rock in Rio?"

```
guedder_descobrir_eventos({ busca: "Rock in Rio" })                         -> pega o id
guedder_detalhes_evento({ eventoId: "<id>", incluir: ["venda"] })           -> responde
```

> "Quando é e quem toca no Rock in Rio?"

```
guedder_descobrir_eventos({ busca: "Rock in Rio" })
guedder_detalhes_evento({ eventoId: "<id>", incluir: ["atracoes"] })        -> um chamada só, já traz data/local + line-up
```
