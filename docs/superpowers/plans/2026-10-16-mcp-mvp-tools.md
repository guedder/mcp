# MCP MVP: fundação de escrita + 4 tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Abrir escrita no MCP com confirmação amarrada aos argumentos, auditoria e redação, e entregar as 4 operações do épico GUE-550 (vendas do período, lotes esgotados, criar lote, criar cupom).

**Architecture:** `src/escrita.ts` (novo, puro: segredo, código de confirmação, hash canônico dos args, linha de auditoria, redação). `src/index.ts` ganha um portão de escopo auditado, um fluxo de escrita em 2 fases reutilizado pelas 3 escritas, erro de API acionável (401/403/429) e as 4 tools compostas. A API continua autoridade de permissão e regra de negócio.

**Tech Stack:** Node ≥20, TypeScript, `@modelcontextprotocol/sdk`, zod, `node --test`.

**Spec:** brief da sessão-mãe (GUE-550) + `docs/adr/0003-escrita-com-tres-portoes.md` + PRD `oauth-consent-escopos-por-evento.prd.md`.

## Global Constraints

- Código, mensagens e docs em PT-BR.
- Sem helper genérico de verbo (ADR 0003). `apiPost` ganha `body` opcional (JSON + content-type) em vez de um `apiPostJson` paralelo: zero helper novo, mesmo efeito.
- Escopos novos só aditivos: `vendas:read`, `lote:write`, `cupom:write`, texto em `TEXTO_DO_ESCOPO`. Tela de consent não muda além disso.
- Segredo: `GUEDDER_MCP_CONFIRM_SECRET` se definido, senão `randomBytes(32)`. Serve ao código de confirmação **e** à prova de consent.
- Código = HMAC-SHA256(segredo, `op\nalvo\nJSON canônico dos args\nusuário\nbloco de 10 min`), 10 chars `[A-Z0-9]`; aceita bloco atual e anterior; compara com `timingSafeEqual`.
- Auditoria: uma linha JSON `{"audit":true,...}` por evento. Vai para **stderr**, não stdout: no transporte stdio o stdout é o canal JSON-RPC e uma linha de log ali corrompe o protocolo. O awslogs captura os dois, então o CloudWatch recebe igual.
- Rate limit da API: 30 req/10 s por usuário. Paginação com `size=100`, teto de 20 páginas.
- Endpoints v1 (v3 de lote/cupom/vendas respondem 501): `GET /api/v1/metrica/{id}/ultimas-vendas` (envelope `RestObject`: `data.vendasList[]`, `page.totalPages`), `GET /api/v1/lote/{id}` (Spring `Page` VIA_DTO: `content[]`, `page.totalPages`), `POST /api/v1/lote/{id}/adicionar` (`LoteDto` cru), `POST /api/v1/cupom/{id}` (`CupomDto` cru).
- Sort de últimas vendas: `viewId.dataCompra,desc` (`dataCompra` vive no `@EmbeddedId` `ViewContagemIngressosVendido.ViewId`).

## Review Focus

1. `codigo` de ingresso vs `codigo` de evento/lote: redigir `codigo` só quando o objeto tem `idPedido` ou `nomePortador` (forma de `IngressoAssentoVO`); evento/lote mantêm o código, que é id. Teste: redação preserva `codigo` de lote e mascara o de ingresso.
2. Campo omitido no body vira `null` no Jackson 3 e estoura `NOT NULL`: criar lote/cupom mandam explícitos os defaults do DTO (`privado`, `enabled`, `compraMinima=1`, `aplicavelEmTodosOsSetores=true`, `limitarUmaCompraPorUsuario=true`, `limitarUmIngressoPorCompra=true`, `ativo=true`). Teste: body esperado no POST.
3. Lote inativo vem com `estoqueDisponivel=0`: esgotado é `enabled && estoqueInicial - ingressosVendidos <= 0`. Teste com lote inativo e com lote ativo de `estoqueDisponivel` 0 mas vendas abaixo do estoque.
4. Datas sem offset (`2026-11-01T20:00`) seriam interpretadas no fuso do servidor: recusar no schema. Teste: data sem offset → erro, 0 POST.
5. Período sem venda em algum dia não tem linha na view: `porDia` lista todos os dias com 0. Teste: soma e dia vazio.

---

### Task 1: `src/escrita.ts`

**Files:** Create `src/escrita.ts`; Test `test/escrita-base.test.mjs` (importa `dist/escrita.js`).

**Interfaces — Produces:**
- `SEGREDO: Buffer`
- `usuarioDe(caller?: Caller): string` — `usuarioId ?? email ?? "local"`
- `jsonCanonico(v: unknown): string` — chaves ordenadas recursivamente
- `hashArgs(args: unknown): string` — sha256 hex, 16 chars
- `codigoDeConfirmacao(op, alvo, args, caller?, deslocamento = 0): string`
- `confirmacaoConfere(codigo: unknown, op, alvo, args, caller?): boolean`
- `auditar(e: { tool; fase: "resumo"|"execucao"|"codigo_invalido"|"negado"; escopo?; usuario; eventoId?; alvo?; argsHash?; resultado? }): void`
- `redigir<T>(v: T): T` + `CHAVES_SENSIVEIS` (lista única, GUE-484)

- [ ] Testes: código muda com qualquer arg, com op, com alvo, com usuário; ordem das chaves não muda o código; bloco anterior aceito, dois blocos atrás recusado (via `deslocamento`); `redigir` mascara `cpf/email/telefone/nomePortador/numeroCartao` em qualquer profundidade, mascara `codigo` com `idPedido` irmão, preserva `codigo` de lote; `null` continua `null`.
- [ ] Implementar; `npm test` verde.

### Task 2: fundação no `index.ts` + migrar cancelamento

**Files:** Modify `src/index.ts`; Test `test/escrita.test.mjs` (os 5 existentes seguem verdes sem mudança).

- `class ApiError extends Error { status; corpo }`; mensagem `"<VERBO> <path> -> <status>: <dica>"` (o prefixo é usado pelo 404 de `parametros-venda`). Dicas: 401 reconectar, 403 sem permissão neste evento, 429 limite 30/10 s.
- `apiGet`/`apiPost` com `AbortSignal.timeout(15_000)`; `apiPost(path, { caller, body? })`.
- `portaoDeEscopo(tool, escopo, caller, eventoId?)`: `AUTH` desligado = no-op; sem caller = `AuthError`; `EscopoError` audita `fase:"negado"` e relança. Substitui os 3 `exigirEscopo` existentes.
- `executarEscrita({ tool, escopo, alvo, eventoId?, args, caller, preparar })`: `preparar(): Promise<{ resumo; executar }>`; sem `confirmacao` → audita `resumo`, devolve resumo + `confirmacao="<código>"`; código não confere → audita `codigo_invalido`, `isError`; confere → executa, audita `execucao` com `resultado` `ok`/`erro <status>`, devolve `redigir(data)`.
- `redigir` na saída de todas as tools (loop genérico, descobrir, detalhes, status_da_compra antes do `map`).
- `TEXTO_DO_ESCOPO` + 3 escopos; `provaDeConsent` usa `SEGREDO`.

- [ ] `npm test` verde (escrita, consent, comprador, spec-paths).

### Task 3: leituras `vendas:read`

**Files:** Modify `src/index.ts`, `test/spec-paths.test.mjs` (`FORA_DO_CONTRATO_GET` + 4 nomes); Test `test/mvp.test.mjs`.

- `guedder_ingressos_vendidos_periodo(eventoId, de?, ate?)`: `de/ate` `YYYY-MM-DD`, default hoje em `America/Sao_Paulo`; `de > ate` ou > 31 dias → erro sem chamar a API. Pagina por `size=100,page=n` até a última linha ficar antes de `de`. Saída `{ eventoId, nomeEvento, de, ate, totalIngressosPagos, porDia: [{ data, ingressosPagos }] }`.
- `guedder_lotes_esgotados(eventoId)`: `listarLotes(eventoId, caller)` (helper compartilhado com o cupom) pagina até `page.totalPages`. Saída `{ eventoId, totalLotes, esgotados: [{ id, nome, estoqueInicial, ingressosVendidos }] }`.
- [ ] Testes: soma 3 dias com um dia sem linha = 0; query leva `sort=viewId.dataCompra,desc`; período de 32 dias → erro e 0 requests; esgotado ignora lote inativo e não usa `estoqueDisponivel`; sem escopo `vendas:read` com Cognito ligado é coberto pelo portão (auth.test já prova `exigirEscopo`).

### Task 4: escritas `lote:write` / `cupom:write`

**Files:** Modify `src/index.ts`; Test `test/mvp.test.mjs`.

- `guedder_criar_lote(eventoId, nome, estoqueInicial, precoUnitario?, inicioVendas, terminoVendas, privado?, compraMaxima?)` — annotations `readOnly=false, destructive=false, idempotent=false`. Datas com regex `(Z|[+-]\d{2}:\d{2})$`. 400 "Já existe um lote" → mensagem clara.
- `guedder_criar_cupom(eventoId, nome, tipoDesconto, valorDesconto, limite?, lotes?)` — `valorDesconto > 0`, `PERCENTUAL ≤ 100`. Nomes → ids por `listarLotes` (case-insensitive, trim); nome inexistente ou ambíguo → erro sem POST. Vazio/ausente → `lotes: []` + `aplicavelEmTodosOsLotes: true`, resumo diz "todos os lotes". 409 → nome duplicado.
- [ ] Testes por escrita: fase 1 sem POST; arg alterado invalida o código; código certo → exatamente 1 POST com o body esperado; cupom com lote inexistente → 0 POST; data sem offset → 0 POST.

### Task 5: docs, commit, PR

- [ ] `docs/ARQUITETURA.md` §8 (tabela), §9 (escrita genérica, segredo via env para N réplicas, auditoria, redação), §12, §15; README (tabela de tools, escopos); `.env.example` (`GUEDDER_MCP_CONFIRM_SECRET`).
- [ ] `npm test`; commit Conventional Commits; push; PR contra `main` citando GUE-550/551/552/553/554/484, a ordem de promoção (authz de lote/cupom no guedder-api em `dev` antes) e os 3 escopos no Cognito + `GUEDDER_MCP_SCOPES` (repo infra).
