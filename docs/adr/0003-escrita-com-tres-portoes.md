# ADR 0003 — Escrita entra por tool específica, com escopo, confirmação em duas fases e regra de negócio na API

**Status**: Aceito — 2026-09-16
**Depende de**: ADR 0002 deste repo (consent por escopo)
**Contexto maior**: ADR 0001 §9.4 e §9.11 do repo `auth`

## Contexto

Até aqui o servidor era **estruturalmente** só-leitura: existia `apiGet` e mais
nada. Isso era propriedade de segurança, não convenção — §9.4 do ADR do `auth`
pede exatamente que read-only seja estrutural, e não confiança em quem revisa.

O caso de uso mudou: o agente passa a atender o comprador e a **agir na conta
dele**, cancelando pedido. A garantia antiga deixa de valer, e a nova precisa
ser dita com a mesma clareza: **nada é escrito sem a pessoa ter confirmado
aquela operação**.

Uma descoberta de API moldou o desenho: **não existe "cancelar ingresso"
individual**. `PUT /api/v1/ingresso/{id}/cancelar` devolve 400 fora de contexto
de convite e não checa dono. A operação real é cancelar o **pedido**
(`POST /api/v3/pedidos/{pedidoId}/cancelamento`), que já é só-do-dono e já
carrega a regra de negócio.

## Decisão

Uma tool, `guedder_cancelar_pedido`, com **três portões em série**, cada um
respondendo uma pergunta diferente:

| portão | pergunta | onde |
|---|---|---|
| escopo | a pessoa autorizou o **agente** a isto? | `exigirEscopo(caller, "pedido:cancelar")` |
| confirmação | ela mandou fazer **isto**, neste pedido, agora? | duas fases, neste servidor |
| regra de negócio | ela **pode**? (dono, prazo, check-in) | a API |

**1. Escopo, sem bypass de admin.** `exigirEscopo` é o ponto único de checagem.
A ausência de atalho para admin é decisão, com teste: `role` responde "até onde
a pessoa alcança", escopo responde "o que ela autorizou o agente a fazer por
ela". Um admin que conectou o agente só para consulta não autorizou
cancelamento, e é no admin que o estrago seria maior. Na API o admin continua
como está (§9.5 do ADR do `auth`), porque lá a pergunta é a primeira.

**2. Confirmação em duas fases, com código imprevisível.** A primeira chamada
(sem `confirmacao`) **não escreve nada**: devolve em português o que vai
acontecer e um código. A segunda, com aquele código, executa. O código é
`HMAC(pedidoId + identidade da pessoa)` truncado, e é imprevisível de
propósito — se fosse um literal fixo, o modelo poderia mandá-lo de primeira e a
fase de resumo nunca chegaria à pessoa, que é justamente o que faz o consent
valer alguma coisa numa operação que devolve dinheiro. Um código vale para
**um** pedido: sem isso, a pessoa confirma o cancelamento de um ingresso e o
agente reaproveita o código em outro.

**3. Regra de negócio fica na API.** O MCP não reimplementa janela de 7 dias,
48h do evento nem ingresso já bipado
(`validarCancelamentoDeCompraUserComum`). A API continua a autoridade; o
servidor traduz o erro dela.

**Helper de escrita específico.** Existe `apiPost`, e ele serve só a esta
operação. **Não existe `apiRequest(metodo, path)`**, e isso é o coração do
ADR: um helper genérico de verbo transformaria "este servidor escreve num
lugar" em "este servidor pode escrever em qualquer lugar", e a diferença só
apareceria numa auditoria.

**O teste é parte da decisão.** `test/spec-paths.test.mjs` afirma o **verbo**
de cada tool de leitura contra a spec OpenAPI e mantém uma **lista nomeada de
exceções**. Tool de escrita nova que não entre na lista quebra o teste de
propósito: acrescentar um nome ali é decisão revisada, não detalhe absorvido.

**As annotations dizem a verdade**: `readOnlyHint: false`,
`destructiveHint: true`, `idempotentHint: false` — cancelar duas vezes não é o
mesmo que cancelar uma (a segunda bate num pedido que já não está PAGO). O
cliente MCP usa essas dicas para decidir se pede aprovação humana; tool que
devolve dinheiro anunciada como read-only é mentira com efeito colateral.

## Alternativas consideradas

- **Bypass de admin no escopo.** Rejeitado acima.
- **Código de confirmação fixo** (`"CONFIRMAR"`). É o que permite ao modelo
  pular a fase de resumo.
- **Confirmação por elicitation do protocolo MCP.** Não se pode depender de
  todo cliente implementar; o código funciona em qualquer um.
- **Reimplementar a janela de cancelamento aqui** para dar erro mais bonito.
  Seria uma segunda fonte da verdade que envelhece sozinha.
- **`outputSchema` também na tool de escrita.** A tool devolve duas coisas
  diferentes (resumo e resposta da API), e declarar a segunda obrigaria a
  primeira a fingir ser um resultado de API.

## Consequências

- Somar uma segunda tool de escrita exige: escopo novo no resource server do
  Cognito **e** em `GUEDDER_MCP_SCOPES`, frase no dicionário da tela de
  consent, nome na lista de exceções do `spec-paths`, e annotations honestas.
  Nenhum desses passos é acidental.
- Escopos de leitura ficaram sem exigência por um tempo depois de existirem no
  resource server (`conta:read`) — corrigido na ADR 0004, no mesmo PR que
  consolidou as tools do comprador. Ver lá o porquê de ter ficado destravado
  até então e o que foi ligado.
- O segredo dos HMACs é por processo. Com mais de uma réplica, a confirmação
  pode cair noutra e a pessoa confirma de novo. O upgrade, se incomodar, é uma
  chave em SSM lida no boot, não sessão em banco.
