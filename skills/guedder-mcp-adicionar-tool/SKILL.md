---
name: guedder-mcp-adicionar-tool
description: Checklist para acrescentar ou alterar uma tool no MCP Guedder (@guedder/mcp) sem furar as garantias de segurança nem os critérios de review de conectores da Anthropic. Use ao criar tool nova, expor endpoint novo, ou transformar uma tool de leitura em escrita.
---

# Acrescentar uma tool no MCP Guedder

**Tool nova é mudança de segurança, não feature.** A superfície do agente não é
a API inteira: é o conjunto de endpoints que alguma tool chama, e esse conjunto
é escrito por nós. A pergunta do review é "o que alguém enxerga através disto".

Leia antes: `docs/ARQUITETURA.md` §8 (camada de tools) e §11 (critérios de
review). Se a tool escreve, leia também `docs/adr/0003-escrita-com-tres-portoes.md`.

## Toda tool

1. **Nome** `guedder_<verbo>_<substantivo>`, no máximo 64 caracteres.
2. **`title`** humano e **`description`** que diz o que a tool faz e quando
   invocá-la. A descrição **não** instrui comportamento do agente ("sempre
   chame X antes"), não manda buscar instrução fora e não tenta sobrepor o
   system prompt — isso reprova no review da Anthropic e é vetor de prompt
   injection. Fluxo entre tools vive no bloco `instructions` do handshake.
3. **`annotations` honestas**: `readOnlyHint`/`destructiveHint` decidem se o
   cliente pede aprovação humana a cada chamada.
4. **`openApiOperationId`** apontando para a operação na spec recortada. Se o
   endpoint não estiver em `src/openapi-v3.json`, rode
   `npm run sync:openapi-v3` (e confira o filtro do script: por padrão ele
   mantém `GET /api/v3/**` mais uma lista nomeada de paths legados).
5. **Paginação**: exponha só `max_results` (1..100, padrão 50) e traduza no
   `build` para o nome que a API exige (`size`, ou `page_size` em
   `/api/v3/eventos`, que pagina a partir de **1**). Ver a skill
   `guedder-mcp-pagination`.
6. **Confirme a rota com token válido.** Vários 404 só aparecem depois do auth
   (foi assim que `usuario_logado` ficou apontando para uma rota de v1).
7. `npm test` — `spec-paths.test.mjs` confere path, query params e **verbo**
   contra a spec.

## Se a tool escreve

Além do acima, e nenhum destes passos é opcional:

1. **Escopo novo** no resource server do Cognito
   (`guedder/identity/staging/cognito.tf`, repo `infra`) **e** em
   `GUEDDER_MCP_SCOPES`. Os dois lados precisam concordar.
2. **Frase em português** no dicionário `TEXTO_DO_ESCOPO`, senão o escopo
   aparece pelo nome cru na tela de consent.
3. **`exigirEscopo(caller, "<escopo>")`** como primeiro portão. Sem bypass de
   admin: papel diz até onde a pessoa alcança, escopo diz o que ela autorizou o
   agente a fazer por ela.
4. **Confirmação em duas fases** se a operação não tem desfazer: primeira
   chamada resume e devolve um código imprevisível, segunda executa. Código
   fixo não serve — o modelo pularia a fase de resumo.
5. **Helper específico**, nunca um `apiRequest(metodo, path)` genérico.
6. **Nome na lista de exceções** do `test/spec-paths.test.mjs`. O teste falha
   de propósito enquanto você não fizer isso: é o que transforma ampliar a
   superfície em decisão revisada.
7. **Regra de negócio fica na API.** Não reimplemente janela, dono ou prazo
   aqui.

## Atualize junto, no mesmo PR

- tabela de tools no `README.md` e em `docs/ARQUITETURA.md` §8;
- a skill do fluxo afetado (`guedder-mcp-consultar-evento-ao-vivo`);
- o bloco `INSTRUCTIONS`, se o fluxo de uso mudou.
