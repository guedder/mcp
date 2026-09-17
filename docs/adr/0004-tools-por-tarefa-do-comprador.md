# ADR 0004 — Tools por tarefa do comprador, não por endpoint

**Status**: Proposta — em andamento em 2026-09-17. Não mergeada, e sem PR
aberto no `guedder/mcp` no momento em que este documento foi escrito; confira
com `gh pr list --repo guedder/mcp` antes de tratar o conteúdo como vigente.

## Contexto

O conjunto de tools de leitura nasceu **por endpoint**: `guedder_listar_eventos`,
`guedder_get_evento`, `guedder_listar_atracoes_evento`,
`guedder_listar_lotes_evento`, `guedder_get_parametros_venda`,
`guedder_eventos_destaque`, `guedder_meus_ingressos`, `guedder_minhas_compras`,
e assim por diante. Cada tool é um wrapper fino de uma operação da API v3.

Isso tem dois efeitos que só aparecem com o agente em uso:

1. **O agente precisa saber a ordem.** Responder "quais as formas de pagamento
   do show X?" exige duas ou três chamadas encadeadas, e o encadeamento foi
   parar no bloco `instructions` do handshake e numa skill — ou seja, virou
   texto que o modelo pode não seguir, em vez de contrato.
2. **A superfície cresce com a API, não com a necessidade.** Endpoint novo
   tende a virar tool nova, mesmo quando ninguém pediu aquela tarefa.

## Decisão (proposta)

Consolidar as tools de leitura em **uma tool por tarefa que o comprador quer
fazer**, na ordem em que ele quer fazer:

| Tarefa | Substitui, entre outras |
|---|---|
| descobrir eventos | `guedder_listar_eventos`, `guedder_eventos_destaque`, `guedder_listar_categorias_evento` |
| detalhes do evento | `guedder_get_evento`, `guedder_listar_atracoes_evento`, `guedder_listar_lotes_evento`, `guedder_get_parametros_venda` |
| meus ingressos | `guedder_meus_ingressos` |
| status da compra | `guedder_minhas_compras` |

**Sem período de transição**: as tools antigas saem no mesmo PR que traz as
novas (decisão do dono do produto). O cliente é o plugin da própria Guedder,
então não há integrador de terceiro para avisar.

As tools de gestão/administrativo e a de auditoria não fazem parte desta
consolidação — elas atendem outra persona.

## Restrições que a proposta precisa respeitar

Do review de conectores da Anthropic (ver `docs/ARQUITETURA.md` §11):

- leitura e escrita continuam em tools separadas, sem parâmetro `method`;
- `title` e `readOnlyHint`/`destructiveHint` em toda tool;
- nome com no máximo 64 caracteres;
- descrição diz o que a tool faz, **não** como o agente deve se comportar. Uma
  tool por tarefa ajuda aqui: parte do que hoje é instrução de comportamento
  vira contrato, e some da descrição.

Deste repo:

- `spec-paths.test.mjs` afirma o verbo e o path de cada tool de leitura contra a
  spec OpenAPI. Uma tool que agrega vários endpoints numa resposta só **quebra a
  premissa de "exatamente um GET"** — o teste precisa evoluir junto,
  explicitando quantas chamadas cada tool faz, e não ser afrouxado até deixar
  de afirmar o verbo (que é a garantia do ADR 0003);
- o contrato de paginação (`max_results`, primeira página) continua;
- cada tool continua com um resource `guedder://openapi/v3/tools/<nome>`; com
  agregação, o resource passa a listar mais de uma operação.

## Consequências

- O bloco `instructions` encolhe: menos fluxo para descrever, porque o fluxo
  virou a forma das tools.
- As skills `guedder-mcp-consultar-evento-ao-vivo` e a tabela de tools do
  README e de `docs/ARQUITETURA.md` **precisam ser atualizadas no mesmo PR** —
  senão a documentação passa a ensinar tools que não existem.
- Uma tool agregada faz mais de uma chamada à API por invocação. O custo é
  latência e o benefício é menos ida e volta do modelo; vale medir antes de
  agregar o quarto endpoint numa tool só.
