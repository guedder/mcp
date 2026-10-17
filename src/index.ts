#!/usr/bin/env node
/**
 * @guedder/mcp — MCP over Guedder API v3 (operational tasks).
 *
 * Auth: a caller-provided Bearer token (`GUEDDER_BEARER_TOKEN`) is forwarded only
 * to authenticated endpoints. OAuth2 can later replace tokenProvider() without
 * changing the tools or the HTTP client.
 *
 * Wrappers finos sobre a API: leitura via `apiGet`, e três escritas
 * (`guedder_cancelar_pedido`, `guedder_criar_lote`, `guedder_criar_cupom`) via
 * `apiPost`, sempre por `executarEscrita` (escopo + confirmação em duas fases +
 * auditoria). Não existe helper genérico de verbo, e isso é deliberado.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  AuthError,
  EscopoError,
  exigirEscopo,
  authConfigFromEnv,
  createVerifier,
  protectedResourceMetadata,
  authorizationServerMetadata,
  cognitoEndpoints,
  wwwAuthenticate,
  type Caller,
} from "./auth.js";
import { auditoriaConfigFromEnv, criarAuditoria } from "./auditoria.js";
import { auditar, hmacDeConsent, codigoDeConfirmacao, confirmacaoConfere, hashArgs, mascararTexto, redigir, usuarioDe } from "./escrita.js";

const BASE = (process.env.GUEDDER_API_BASE ?? "https://api.guedder.com").replace(/\/+$/, "");
const BEARER_TOKEN = process.env.GUEDDER_BEARER_TOKEN?.trim();
const MCP_TRANSPORT = process.env.GUEDDER_MCP_TRANSPORT ?? "streamable-http";
const MCP_HOST = process.env.GUEDDER_MCP_HOST ?? "127.0.0.1";
const MCP_PORT = Number.parseInt(process.env.GUEDDER_MCP_PORT ?? "3000", 10);
const MCP_PATH = process.env.GUEDDER_MCP_PATH ?? "/mcp";
// Modo publico: so tools sem auth. Usado pelo agente de suporte ao comprador (spec no guedder-rag).
const PUBLIC_ONLY = /^(1|true)$/i.test(process.env.GUEDDER_MCP_PUBLIC_ONLY ?? "");
const OPENAPI_V3: any = JSON.parse(readFileSync(new URL("./openapi-v3.json", import.meta.url), "utf8"));
const TOOL_OUTPUT_SCHEMA = z.object({
  result: z.unknown().describe("Resultado bruto da API Guedder. O schema detalhado está em guedder://openapi/v3."),
});

const AUTH = authConfigFromEnv();
const AUDITORIA_CFG = auditoriaConfigFromEnv();
const auditoria = AUDITORIA_CFG ? criarAuditoria(AUDITORIA_CFG) : null;
const verifyToken = AUTH ? createVerifier(AUTH) : null;

/**
 * Token repassado à API Guedder. Com Cognito ligado é o do próprio usuário, vindo do request
 * MCP; sem ele, cai no token estático de processo (stdio local e smoke).
 */
async function tokenProvider(caller?: Caller): Promise<string> {
  if (caller) return caller.token;
  if (!BEARER_TOKEN) {
    throw new Error(
      "Endpoint autenticado: defina GUEDDER_BEARER_TOKEN na configuração do MCP.",
    );
  }
  return BEARER_TOKEN;
}

/**
 * Erro de API com o status à mão, para a tool decidir a mensagem (nome
 * duplicado, por exemplo) sem casar regex no texto.
 *
 * O prefixo `<VERBO> <path> -> <status>` é contrato: `guedder_detalhes_evento`
 * reconhece o 404 de `parametros-venda` por ele.
 */
class ApiError extends Error {
  constructor(
    metodo: string,
    path: string,
    readonly status: number,
    statusText: string,
    readonly corpo: string,
  ) {
    super(`${metodo} ${path} -> ${status} ${DICA_POR_STATUS[status] ?? `${statusText}${corpo ? `: ${corpoSeguro(corpo)}` : ""}`}`);
  }
}

/**
 * Corpo de erro da API vai para o contexto do LLM via mensagem de erro, então
 * passa pela mesma redação da saída de sucesso, e é truncado: corpo de erro do
 * Spring pode trazer o DTO inteiro de volta.
 */
function corpoSeguro(corpo: string): string {
  let texto: string;
  try {
    texto = JSON.stringify(redigir(JSON.parse(corpo)));
  } catch {
    texto = mascararTexto(corpo);
  }
  return texto.length > 300 ? `${texto.slice(0, 300)}…` : texto;
}

/**
 * Os três status que o modelo não sabe resolver sozinho, com o que fazer.
 * Sem isto ele tenta de novo em laço num 429, ou culpa o evento num 401.
 */
const DICA_POR_STATUS: Record<number, string> = {
  401: "Não autorizado: a API Guedder recusou a credencial (login expirado ou revogado). A pessoa precisa reconectar o agente.",
  403: "Proibido: a conta logada não tem permissão para esta operação neste evento.",
  429: "Limite de requisições da API atingido (30 a cada 10 segundos por usuário). Espere alguns segundos antes de tentar de novo.",
};

const TIMEOUT_MS = 15_000;

async function apiGet(
  path: string,
  opts: { query?: Record<string, unknown>; auth?: boolean; caller?: Caller } = {},
): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.auth) headers.authorization = `Bearer ${await tokenProvider(opts.caller)}`;
  return lerResposta("GET", path, await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) }));
}

async function lerResposta(metodo: string, path: string, res: Response): Promise<unknown> {
  if (!res.ok) {
    const corpo = await res.text().catch(() => "");
    throw new ApiError(metodo, path, res.status, res.statusText, corpo);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/**
 * Escrita na API, em nome do usuário.
 *
 * Deliberadamente NÃO é `apiRequest(metodo, ...)`: um helper genérico de verbo
 * transformaria "este servidor escreve em três lugares" em "este servidor pode
 * escrever em qualquer lugar", e a diferença só apareceria numa auditoria
 * (ADR 0003). Quem chama é sempre `executarEscrita`, que já passou pelo escopo
 * e pela confirmação.
 *
 * `body` opcional em vez de um segundo helper: o cancelamento não manda corpo,
 * criar lote e cupom mandam JSON. Um helper só continua sendo um lugar só para
 * revisar.
 */
async function apiPost(path: string, opts: { caller?: Caller; body?: unknown } = {}): Promise<unknown> {
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${await tokenProvider(opts.caller)}`,
  };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(new URL(BASE + path), {
    method: "POST",
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return lerResposta("POST", path, res);
}

/**
 * Portão de escopo de toda tool, com a negação auditada (o PRD de consent pede
 * "nenhuma chamada fora do consentido", e só dá para medir o que foi logado).
 * `exigirEscopo` continua sendo a checagem única (auth.ts); isto só soma o log.
 */
function portaoDeEscopo(tool: string, escopo: string, caller?: Caller, eventoId?: string): void {
  if (!AUTH) return;
  if (!caller) throw new AuthError("Token ausente: esta tool age em nome de alguém.");
  try {
    exigirEscopo(caller, escopo);
  } catch (e) {
    if (e instanceof EscopoError) auditar({ tool, fase: "negado", escopo, usuario: usuarioDe(caller), eventoId });
    throw e;
  }
}

type Resposta = { content: { type: "text"; text: string }[]; structuredContent?: { result: unknown }; isError?: true };

function ok(data: unknown): Resposta {
  const limpo = redigir(data);
  return {
    structuredContent: { result: limpo },
    content: [{ type: "text" as const, text: JSON.stringify(limpo, null, 2) }],
  };
}

function falha(e: any, escopo?: string): Resposta {
  const motivo = e instanceof EscopoError && escopo ? `${e.message} (escopo \`${escopo}\`)` : (e?.message ?? String(e));
  // Toda saída passa pela redação, inclusive a de erro (o corpo da API já vem
  // limpo em ApiError; isto cobre o resto).
  return { content: [{ type: "text" as const, text: `Erro: ${mascararTexto(motivo)}` }], isError: true };
}

/**
 * Fluxo de toda escrita: escopo, confirmação em duas fases, auditoria das duas.
 *
 * `preparar` roda nas DUAS fases e é onde mora tudo que pode recusar antes da
 * API (data sem offset, lote inexistente): erro ali não escreve nada, em
 * nenhuma fase. Rodar de novo na fase 2 é de propósito: o que se executa é o
 * que foi resolvido agora, não o que ficou num cache entre as chamadas.
 */
async function executarEscrita(p: {
  tool: string;
  escopo: string;
  alvo: string;
  eventoId?: string;
  args: Record<string, unknown>;
  caller?: Caller;
  /**
   * `amarra`: o que `preparar` resolveu e precisa entrar no código além dos
   * args (no cupom, os pares {id, nome} dos lotes). Sem isso, recriar um lote
   * com o mesmo nome entre as fases faria o código da fase 1 executar sobre
   * outro id, que a pessoa não viu.
   */
  preparar: () => Promise<{ resumo: string; executar: () => Promise<unknown>; amarra?: unknown }>;
  traduzirErro?: (e: ApiError) => string | undefined;
}): Promise<Resposta> {
  const { confirmacao, ...argsDaOperacao } = p.args;
  const base = {
    tool: p.tool,
    escopo: p.escopo,
    usuario: usuarioDe(p.caller),
    eventoId: p.eventoId,
    alvo: p.alvo,
    argsHash: hashArgs(argsDaOperacao),
  };
  try {
    portaoDeEscopo(p.tool, p.escopo, p.caller, p.eventoId);
  } catch (e: any) {
    return falha(e, p.escopo);
  }
  try {
    let preparado: Awaited<ReturnType<typeof p.preparar>>;
    try {
      preparado = await p.preparar();
    } catch (e: any) {
      auditar({ ...base, fase: "recusado", resultado: `erro ${e instanceof ApiError ? e.status : "local"}` });
      throw e;
    }
    const { resumo, executar, amarra } = preparado;
    const material = amarra === undefined ? argsDaOperacao : { args: argsDaOperacao, amarra };

    if (confirmacao === undefined || confirmacao === "") {
      auditar({ ...base, fase: "resumo" });
      const codigo = codigoDeConfirmacao(p.tool, p.alvo, material, p.caller);
      return {
        content: [{
          type: "text" as const,
          text: `${resumo}\n\nNada foi feito ainda. Mostre isto à pessoa e, se ela confirmar, chame de novo com os MESMOS argumentos e confirmacao="${codigo}".`,
        }],
      };
    }

    if (!confirmacaoConfere(confirmacao, p.tool, p.alvo, material, p.caller)) {
      auditar({ ...base, fase: "codigo_invalido" });
      return {
        content: [{
          type: "text" as const,
          text:
            "Confirmação inválida: o código não corresponde a esta operação com estes argumentos, ou expirou " +
            "(vale de 10 a 20 minutos). Um código vale para uma operação só. Chame sem `confirmacao` para obter um novo.",
        }],
        isError: true,
      };
    }

    try {
      const data = await executar();
      auditar({ ...base, fase: "execucao", resultado: "ok" });
      return ok(data);
    } catch (e: any) {
      auditar({ ...base, fase: "execucao", resultado: `erro ${e instanceof ApiError ? e.status : "local"}` });
      const traduzido = e instanceof ApiError ? p.traduzirErro?.(e) : undefined;
      return falha(traduzido ? new Error(traduzido) : e);
    }
  } catch (e: any) {
    return falha(e, p.escopo);
  }
}

type Tool = {
  name: string;
  title: string;
  description: string;
  openApiOperationId: string;
  inputSchema: z.ZodRawShape;
  auth: boolean;
  /**
   * Escopo de consent exigido, além do login. Gap achado ao consolidar as tools
   * do comprador: `conta:read` existe no Cognito e aparece na tela de consent,
   * mas nenhuma tool de leitura o conferia — a pessoa concedia e a concessão não
   * valia nada. `exigirEscopo` continua sendo o único portão (auth.ts), isto só
   * decide QUAL escopo cada tool pede.
   */
  escopo?: string;
  build: (a: any) => { path: string; query?: Record<string, unknown> };
};

function collectOpenApiRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) return value.forEach((item) => collectOpenApiRefs(item, refs));
  if (!value || typeof value !== "object") return;
  const object = value as Record<string, unknown>;
  if (typeof object.$ref === "string" && object.$ref.startsWith("#/components/")) refs.add(object.$ref);
  Object.values(object).forEach((item) => collectOpenApiRefs(item, refs));
}

function openApiComponent(ref: string): unknown {
  return ref.slice(2).split("/").reduce((value, key) => value?.[key], OPENAPI_V3);
}

function openApiOperation(operationId: string): unknown {
  for (const [path, methods] of Object.entries(OPENAPI_V3.paths as Record<string, Record<string, any>>)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId !== operationId) continue;
      const refs = new Set<string>();
      collectOpenApiRefs(operation, refs);
      for (const ref of refs) collectOpenApiRefs(openApiComponent(ref), refs);
      const components: Record<string, Record<string, unknown>> = {};
      for (const ref of refs) {
        const [, , section, name] = ref.split("/");
        const value = openApiComponent(ref);
        if (value !== undefined) (components[section] ??= {})[name] = value;
      }
      return {
        openapi: OPENAPI_V3.openapi,
        info: OPENAPI_V3.info,
        tags: (OPENAPI_V3.tags ?? []).filter((tag: { name: string }) => operation.tags?.includes(tag.name)),
        paths: { [path]: { [method]: operation } },
        components,
      };
    }
  }
  throw new Error(`OperationId OpenAPI não encontrado: ${operationId}`);
}

const OPENAPI_INDEX = {
  openapi: OPENAPI_V3.openapi,
  info: OPENAPI_V3.info,
  operations: Object.entries(OPENAPI_V3.paths as Record<string, Record<string, any>>).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, operation]) => ({
      operationId: operation.operationId,
      method: method.toUpperCase(),
      path,
      tags: operation.tags ?? [],
      summary: operation.summary,
      description: operation.description,
    })),
  ),
};

const enc = encodeURIComponent;

/**
 * Todo id que vira segmento de path passa por um destes. `encodeURIComponent`
 * não codifica `.`, então `eventoId=".."` viraria `/api/v1/lote/../adicionar`
 * depois da normalização da URL: outro endpoint, com o token da pessoa.
 */
const UUID_ = z.string().uuid("Use o UUID do evento");
const ID_OU_CODIGO = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "Id ou código alfanumérico (letras, números, - e _)");


// ── Apoio das tools de gestão de evento (GUE-550) ───────────────────────────
// Todas falam com endpoints v1: os v3 de lote, cupom e vendas existem no
// api.yaml mas respondem 501. Por isso ficam fora do spec-paths.

const FUSO = "America/Sao_Paulo";
const DIA_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATA_COM_OFFSET_RE = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d+)?)?(Z|[+-](0\d|1[0-3]):[0-5]\d|[+-]14:00)$/;

/**
 * 2026-02-30 casa a regex mas o `Date` rola para 02/03; só vale o dia que volta
 * igual. 2026-13-01 nem vira data (`Invalid Date`), e `toISOString()` lançaria
 * RangeError de dentro do refine, em vez de erro de validação.
 */
const diaExiste = (dia: string) => {
  const d = new Date(`${dia}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === dia;
};

const DIA = z
  .string()
  .regex(DIA_RE, "Use AAAA-MM-DD")
  .refine(diaExiste, "Dia inexistente no calendário");
const DATA_COM_OFFSET = z
  .string()
  .regex(DATA_COM_OFFSET_RE, "Data com offset explícito, ex.: 2026-11-01T20:00:00-03:00")
  .refine((v) => diaExiste(v.slice(0, 10)), "Dia inexistente no calendário")
  // O offset vai de -14:00 a +14:00 (a regex já recorta); o parse completo pega o resto.
  .refine((v) => !Number.isNaN(Date.parse(v)), "Data/hora inválida");
const MAX_DIAS_PERIODO = 31;

/**
 * Teto de páginas de 100 itens. A API limita 30 requisições a cada 10 s por
 * usuário, e uma tool que pagina sem teto queima o limite da pessoa inteira.
 *
 * ponytail: teto fixo de 2.000 itens; com evento maior que isso a tool recusa
 * em vez de devolver número parcial. Upgrade é um endpoint agregado na API.
 */
const TETO_PAGINAS = 20;

const hojeEmSaoPaulo = () => new Intl.DateTimeFormat("en-CA", { timeZone: FUSO }).format(new Date());

const DIA_MS = 86_400_000;

/** Conta os dias antes de montar a lista: 0000-01-01..9999-12-31 não pode alocar milhões de strings. */
const quantosDias = (de: string, ate: string) =>
  Math.floor((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / DIA_MS) + 1;

function diasDoPeriodo(de: string, ate: string): string[] {
  const dias: string[] = [];
  for (let d = new Date(`${de}T00:00:00Z`); d <= new Date(`${ate}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
    dias.push(d.toISOString().slice(0, 10));
  }
  return dias;
}

/** `LocalDate` sai como "2026-10-16" no Jackson 3, mas como [2026,10,16] se alguém ligar timestamps. */
function dataIso(d: unknown): string {
  return Array.isArray(d) ? d.map((n, i) => String(n).padStart(i ? 2 : 4, "0")).join("-") : String(d).slice(0, 10);
}

const brl = (v: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

/** Todos os lotes do evento (Spring `Page` VIA_DTO: `content` + `page.totalPages`). */
async function listarLotes(eventoId: string, caller?: Caller): Promise<any[]> {
  const lotes: any[] = [];
  for (let page = 0; page < TETO_PAGINAS; page++) {
    const r: any = await apiGet(`/api/v1/lote/${enc(eventoId)}`, { query: { page, size: 100 }, auth: true, caller });
    lotes.push(...(r?.content ?? []));
    if (page + 1 >= (r?.page?.totalPages ?? 0)) return lotes;
  }
  throw new Error(`O evento tem mais de ${TETO_PAGINAS * 100} lotes; esta tool não pagina além disso.`);
}

/**
 * Ingressos pagos por dia, de hoje para trás até `de`. A view
 * (`view_contagem_ingressos_vendidos`) só tem linha em dia com venda, e o dia
 * é o da compra em São Paulo (`LocalDate`).
 */
async function vendasPorDia(eventoId: string, de: string, caller?: Caller) {
  const porDia = new Map<string, number>();
  let nomeEvento: string | undefined;
  for (let page = 0; page < TETO_PAGINAS; page++) {
    const r: any = await apiGet(`/api/v1/metrica/${enc(eventoId)}/ultimas-vendas`, {
      // `dataCompra` mora no @EmbeddedId da view, daí o caminho `viewId.`.
      query: { sort: "viewId.dataCompra,desc", page, size: 100 },
      auth: true,
      caller,
    });
    nomeEvento ??= r?.data?.nomeEvento;
    const linhas: any[] = r?.data?.vendasList ?? [];
    for (const l of linhas) {
      const dia = dataIso(l?.dataCompra);
      porDia.set(dia, (porDia.get(dia) ?? 0) + (Number(l?.ingressosPagos) || 0));
    }
    const ultima = linhas.at(-1);
    if (!ultima || dataIso(ultima.dataCompra) < de || page + 1 >= (r?.page?.totalPages ?? 0)) {
      return { nomeEvento, porDia };
    }
  }
  throw new Error(
    `Histórico de vendas longo demais: li ${TETO_PAGINAS} páginas (${TETO_PAGINAS * 100} dias com venda, do mais recente para trás) ` +
      `sem chegar a ${de}. Consulte um período mais recente.`,
  );
}


/**
 * Nome de lote → lote, sem caixa e sem espaço nas pontas. Qualquer nome que não
 * resolva para EXATAMENTE um lote derruba a operação inteira: cupom aplicado a
 * menos lotes do que a pessoa pediu é desconto errado em produção.
 */
async function resolverLotes(eventoId: string, nomes: string[], caller?: Caller): Promise<{ id: string; nome: string }[]> {
  const todos = await listarLotes(eventoId, caller);
  const norma = (s: unknown) => String(s ?? "").trim().toLocaleLowerCase("pt-BR");
  const faltando: string[] = [];
  const ambiguos: string[] = [];
  const achados = nomes.flatMap((n) => {
    const casam = todos.filter((l) => norma(l?.nome) === norma(n));
    if (casam.length === 0) faltando.push(n);
    if (casam.length > 1) ambiguos.push(n);
    return casam.length === 1 ? [{ id: String(casam[0].id), nome: String(casam[0].nome) }] : [];
  });
  if (faltando.length || ambiguos.length) {
    const partes = [
      faltando.length ? `não encontrei ${faltando.map((n) => `"${n}"`).join(", ")}` : "",
      ambiguos.length ? `mais de um lote se chama ${ambiguos.map((n) => `"${n}"`).join(", ")} (sessões diferentes)` : "",
    ].filter(Boolean);
    throw new Error(
      `Lotes: ${partes.join("; ")}. Lotes deste evento: ${todos.map((l) => `"${l?.nome}"`).join(", ") || "nenhum"}. Nada foi criado.`,
    );
  }
  return achados;
}

const TOOLS: Tool[] = [
  {
    name: "guedder_listar_categorias_evento",
    title: "Listar categorias de evento",
    description:
      "Lista as categorias de evento disponíveis (ex: show, festa, teatro). Sem input. Use antes de filtrar guedder_descobrir_eventos por categoria.",
    openApiOperationId: "listarCategoriasEvento",
    inputSchema: {},
    auth: false,
    build: () => ({ path: "/api/v3/categorias-evento" }),
  },
  {
    name: "guedder_get_lote",
    title: "Lote por código/ID",
    description: "Retorna um lote pelo código ou ID do evento e do lote (aceita UUID ou código). Requer auth.",
    openApiOperationId: "getLotePorCodigoOuId",
    inputSchema: { codigoOrEventoId: ID_OU_CODIGO, codigoOrLoteId: ID_OU_CODIGO },
    auth: true,
    build: (a) => ({ path: `/api/v3/eventos/${enc(a.codigoOrEventoId)}/lotes/${enc(a.codigoOrLoteId)}` }),
  },
  {
    name: "guedder_buscar_ingressos_evento",
    title: "Ingressos do evento (check-in)",
    description:
      "Lista ingressos de um evento para check-in (acesso produtor/admin do evento). Filtro por texto livre (nome/email/código), paginação, sessão e ordenação.",
    openApiOperationId: "buscarIngressosPorEvento",
    inputSchema: {
      eventoId: ID_OU_CODIGO,
      filtro: z.string().optional().describe("Busca por nome, email ou código"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de ingressos retornados; máximo 100"),
      sessaoId: z.string().optional(),
      sort: z.string().optional().describe("Ex: nomeParticipante,asc"),
    },
    auth: true,
    build: (a) => ({
      path: `/api/v3/eventos/${enc(a.eventoId)}/ingressos`,
      query: { filtro: a.filtro, page: 0, size: a.max_results, sessaoId: a.sessaoId, sort: a.sort },
    }),
  },
  {
    name: "guedder_meus_ingressos",
    title: "Meus ingressos",
    description:
      "Ingressos do usuário autenticado agrupados por status. status (ciclo de vida): ATIVO (padrão), ENCERRADO, TRANSFERENCIA_PENDENTE. eventoId opcional.",
    openApiOperationId: "getMeusIngressos",
    inputSchema: { status: z.string().optional(), eventoId: z.string().optional() },
    auth: true,
    escopo: "conta:read",
    build: (a) => ({ path: "/api/v3/ingressos", query: { cicloDeVida: a.status, eventoId: a.eventoId } }),
  },
  {
    name: "guedder_minhas_compras",
    title: "Minhas compras",
    description:
      "Histórico de compras do usuário autenticado. Retorna até max_results compras da primeira página; padrão 50 e máximo 100. sort padrão: dataCompra,desc. Para o status de UM pedido específico, use guedder_status_da_compra.",
    openApiOperationId: "getMinhasCompras",
    inputSchema: {
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de compras retornadas; máximo 100"),
      sort: z.string().optional(),
    },
    auth: true,
    escopo: "conta:read",
    build: (a) => ({ path: "/api/v3/compras", query: { page: 0, size: a.max_results, sort: a.sort } }),
  },
  {
    name: "guedder_buscar_compras_evento",
    title: "Buscar compras de um evento",
    description:
      "Extrato de compras de um evento para gestão de vendas. Filtre por texto e status; retorna até max_results da primeira página. Requer permissão sobre o evento.",
    openApiOperationId: "findExtratosByEvento",
    inputSchema: {
      eventoId: UUID_,
      filtro: z.string().optional().describe("Busca textual no extrato"),
      status: z.array(z.string()).optional().describe("Status de compra, ex.: PAGO ou PENDENTE"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de compras retornadas; máximo 100"),
    },
    auth: true,
    build: (a) => ({
      path: `/api/v2/compra/evento/${enc(a.eventoId)}/extrato`,
      query: { filtro: a.filtro, status: a.status?.join(","), page: 0, size: a.max_results },
    }),
  },
  {
    name: "guedder_auditar_vendas_evento",
    title: "Auditar vendas recentes do evento",
    description:
      "Retorna as vendas recentes de um evento para auditoria operacional. Não é uma trilha de alterações do evento; exige o escopo vendas:read e permissão sobre o evento.",
    openApiOperationId: "getContagemIngressosVendidos",
    inputSchema: {
      eventoId: UUID_,
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de vendas retornadas; máximo 100"),
    },
    auth: true,
    escopo: "vendas:read",
    build: (a) => ({ path: `/api/v1/metrica/${enc(a.eventoId)}/ultimas-vendas`, query: { page: 0, size: a.max_results } }),
  },
  {
    name: "guedder_resumo_vendas_evento",
    title: "Resumo de vendas do evento",
    description:
      "Agregados de vendas de um evento para gestão. Exige o escopo vendas:read e permissão sobre o evento.",
    openApiOperationId: "getResumoVendas",
    inputSchema: { eventoId: UUID_ },
    auth: true,
    escopo: "vendas:read",
    build: (a) => ({ path: `/api/v1/metrica/${enc(a.eventoId)}/resumo-vendas` }),
  },
  {
    name: "guedder_listar_integracoes_pagamento",
    title: "Listar integrações de pagamento",
    description:
      "Lista as integrações de adquirentes/gateways configuradas, opcionalmente por método de pagamento. Requer role ADMIN.",
    openApiOperationId: "getGatewaysAdquirentes_1",
    inputSchema: {
      metodoPagamento: z.string().optional().describe("Método de pagamento para filtrar as integrações"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de integrações retornadas; máximo 100"),
    },
    auth: true,
    build: (a) => ({
      path: "/api/v1/administrativo/gateway-adquirentes",
      query: { metodoPagamento: a.metodoPagamento, page: 0, size: a.max_results },
    }),
  },
  {
    name: "guedder_listar_resumo_repasses_eventos",
    title: "Resumo financeiro de repasses por evento",
    description:
      "Lista eventos com total vendido, total repassado e saldo de repasse. Requer role ADMIN; retorna até max_results da primeira página.",
    openApiOperationId: "listarResumoRepassesPorEvento",
    inputSchema: {
      filtro: z.string().optional().describe("Filtro parcial pelo nome do evento"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de eventos retornados; máximo 100"),
    },
    auth: true,
    build: (a) => ({
      path: "/api/v3/administrativo/repasses/eventos",
      query: { filtro: a.filtro, page: 0, size: a.max_results },
    }),
  },
  {
    name: "guedder_listar_locais_recentes",
    title: "Listar locais recentes do produtor",
    description: "Lista, no máximo, cinco locais de evento usados recentemente pelo produtor autenticado. Requer role ADMIN.",
    openApiOperationId: "listarLocaisRecentes",
    inputSchema: {},
    auth: true,
    build: () => ({ path: "/api/v3/administrativo/locais-recentes" }),
  },
  {
    name: "guedder_usuario_logado",
    title: "Quem sou eu (auth)",
    description: "Dados do usuário autenticado — confirma identidade/claims do token em uso.",
    openApiOperationId: "getUsuarioLogado",
    inputSchema: {},
    auth: true,
    // `usuario_logado` é o nome da rota em v1; em v3 a mesma operação
    // (getUsuarioLogado) foi renomeada para /perfil. O path errado passava batido
    // porque o 404 vinha depois do auth — só aparece com token válido.
    build: () => ({ path: "/api/v3/usuarios/perfil" }),
  },
];

const INSTRUCTIONS = `MCP sobre a API Guedder (plataforma de venda de ingressos). Quase tudo é leitura; as operações que mudam estado estão descritas no fim.

Tools por TAREFA, não por endpoint — cada uma pode chamar mais de uma operação
da API por dentro. O endpoint concreto não importa para decidir qual tool usar.

Fluxo para responder sobre um evento:
1. Ache o evento e o id: guedder_descobrir_eventos. Sem filtro nenhum, traz os
   destaques da home (o que está em cartaz); com cidade/estado/categoria/busca,
   procura no catálogo completo. O id é UUID ou código alfanumérico.
2. Com o id, guedder_detalhes_evento. Sem \`incluir\`, só o básico (nome, data,
   local). Peça \`incluir\` para o que mais faltar: line-up, lotes com preço,
   formas de pagamento. parametrosVenda === null significa "organizador ainda
   não divulgou" (404 internamente), não "evento inexistente".
3. Categorias disponíveis para filtrar: guedder_listar_categorias_evento.

Fluxo para responder sobre a conta da pessoa logada:
- Ingressos: guedder_meus_ingressos.
- Histórico de compras: guedder_minhas_compras.
- Status de UM pedido específico (identificador = idPedido, que aparece nos
  dois acima): guedder_status_da_compra — agrega todos os ingressos daquele
  pedido num resultado só.

Regras:
- Nunca invente id, data, preço ou regra. Se uma tool não devolver, diga que não tem a informação.
- Toda tool devolve o JSON cru em content e em structuredContent.result. O schema de saída detalhado de cada tool está no resource guedder://openapi/v3/tools/<nome_da_tool>; o índice compacto de todas as operações está em guedder://openapi/v3.
- Com GUEDDER_MCP_PUBLIC_ONLY=1 (agentes de comprador) só guedder_descobrir_eventos, guedder_detalhes_evento e guedder_listar_categorias_evento ficam disponíveis. As demais (ingressos, compras, auditoria, administrativo) exigem um token Guedder e perfil compatível.

Gestão de evento (para quem produz):
1. Ache o evento e o id entre os que a pessoa gerencia: guedder_meus_eventos
   (dona do evento ou papel SOCIO/GERENTE/CHECKIN). Não use a lista de
   repasses administrativos. Por padrão devolve os mais recentes (sort
   dataCriacao,desc) com página pequena; peça página seguinte se precisar.
   ADMIN da plataforma pode ver eventos além dos seus vínculos — ok, desde
   que a lista venha paginada e recente primeiro.
2. Com o id: ingressos vendidos num período (até 31 dias, dias em São Paulo;
   sem datas = hoje): guedder_ingressos_vendidos_periodo.
3. Lotes que esgotaram: guedder_lotes_esgotados.
4. Criar lote: guedder_criar_lote. Criar cupom: guedder_criar_cupom (lotes pelo NOME; sem lotes = todos).
- Exemplos de pedidos e a tool de cada um: resource guedder://prompts-sugeridos.

Escrita — guedder_cancelar_pedido, guedder_criar_lote, guedder_criar_cupom:
São as únicas tools que mudam estado, e todas seguem o mesmo protocolo de duas fases:
1. Chame SEM \`confirmacao\`. Nada é feito, e você recebe um resumo do efeito mais um código.
2. Mostre esse resumo à pessoa e espere ela confirmar, com todas as letras.
3. Só então chame de novo com os MESMOS argumentos, passando aquele código em \`confirmacao\`.
Nunca invente o código nem pule a etapa 2: o código existe justamente para garantir que a pessoa viu o que ia acontecer. Ele vale para aquela operação, com aqueles argumentos, por 10 a 20 minutos; mudou um argumento, peça um código novo.
Cancelar pedido devolve o valor pelo mesmo meio de pagamento e não tem desfazer.
Cada tool exige um escopo concedido ao conectar (pedido:cancelar, lote:write, cupom:write; as de vendas, vendas:read). Se a pessoa não concedeu, o erro diz isso, e o caminho é ela reconectar autorizando — não há como contornar por aqui.
Dados pessoais (CPF, e-mail, telefone, código de ingresso, cartão) chegam como "[redigido]" de propósito. Não tente obtê-los por outra tool.`;

/**
 * Pedidos de exemplo de quem produz evento, como chegam do chat da Guedder no WhatsApp. Ficam num
 * resource, e não no INSTRUCTIONS, para o cliente poder mostrar como sugestão e o agente consultar
 * qual tool atende cada um. Cada item aponta para uma tool que existe (o teste confere).
 */
const PROMPTS_SUGERIDOS: { pedido: string; tool: string }[] = [
  { pedido: "Quais são os meus eventos?", tool: "guedder_meus_eventos" },
  { pedido: "Quantos ingressos eu vendi hoje?", tool: "guedder_ingressos_vendidos_periodo" },
  { pedido: "Já esgotou algum lote? Se sim, quais?", tool: "guedder_lotes_esgotados" },
  { pedido: 'Crie um lote chamado "acesso vip" com limitação de 100 retiradas', tool: "guedder_criar_lote" },
  {
    pedido:
      'Crie um cupom chamado PROMO10 que dá 10% de desconto, limite de 100 utilizações, apenas nos lotes "acesso vip" e "Lote inicial"',
    tool: "guedder_criar_cupom",
  },
];

function promptsSugeridosMarkdown(): string {
  const linhas = PROMPTS_SUGERIDOS.map((p) => `- ${p.pedido} → \`${p.tool}\``);
  return [
    "# Pedidos sugeridos",
    "",
    "Exemplos do que quem produz evento pode pedir. O primeiro item resolve o id do evento quando o pedido não o traz.",
    "Criar lote e cupom passam pela confirmação em duas fases.",
    "",
    ...linhas,
    "",
  ].join("\n");
}

function createMcpServer(caller?: Caller): McpServer {
  const server = new McpServer({ name: "guedder-ops", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  server.registerResource(
    "guedder_openapi_v3_index",
    "guedder://openapi/v3",
    {
      title: "Índice OpenAPI Guedder v3",
      description: "Índice compacto das operações GET /api/v3/**. Leia o resource específico da ferramenta para o schema completo.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(OPENAPI_INDEX, null, 2) }],
    }),
  );
  // Os quatro pedidos usam tools com login; no modo comprador (PUBLIC_ONLY) nenhuma existe.
  if (!PUBLIC_ONLY) server.registerResource(
    "guedder_prompts_sugeridos",
    "guedder://prompts-sugeridos",
    {
      title: "Pedidos sugeridos",
      description: "Exemplos de pedidos de quem produz evento, cada um com a tool que o atende.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: promptsSugeridosMarkdown() }],
    }),
  );
  const activeTools = PUBLIC_ONLY ? TOOLS.filter((t) => !t.auth) : TOOLS;
  for (const t of activeTools) {
    const schemaUri = `guedder://openapi/v3/tools/${t.name}`;
    server.registerResource(
      `${t.name}_schema`,
      schemaUri,
      {
        title: `Schema: ${t.title}`,
        description: `Operação OpenAPI ${t.openApiOperationId}, incluindo schema de resposta e componentes referenciados.`,
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(openApiOperation(t.openApiOperationId), null, 2) }],
      }),
    );
    server.registerTool(
      t.name,
      {
        title: t.title,
        description: `${t.description} Schema detalhado de saída: ${schemaUri}.`,
        inputSchema: t.inputSchema,
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          if (t.escopo) portaoDeEscopo(t.name, t.escopo, caller, args?.eventoId);
          const { path, query } = t.build(args ?? {});
          return ok(await apiGet(path, { query, auth: t.auth, caller }));
        } catch (e: any) {
          return falha(e, t.escopo);
        }
      },
    );
  }

  // ── Tools por tarefa (compostas) ────────────────────────────────────────────
  // Substituem o desenho de 1 tool por endpoint para o comprador: cada uma
  // compõe internamente uma ou mais chamadas GET, e o endpoint concreto vira
  // detalhe de implementação, não superfície da tool. Não entram no array
  // TOOLS porque `build()` genérico assume UMA chamada sem pós-processamento;
  // estas decidem QUAL endpoint chamar, ou agregam mais de um resultado.
  //
  // Por isso também não passam pelo spec-paths.test.mjs (ver FORA_DO_CONTRATO_GET
  // lá): o teste confere "uma tool = uma operação da spec", e estas são,
  // deliberadamente, mais de uma.

  server.registerResource(
    "guedder_descobrir_eventos_schema",
    "guedder://openapi/v3/tools/guedder_descobrir_eventos",
    {
      title: "Schema: Descobrir eventos",
      description: "Duas operações compostas: getEventosDestaque (sem filtro) e listarEventos (com filtro).",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          { destaque: openApiOperation("getEventosDestaque"), busca: openApiOperation("listarEventos") },
          null,
          2,
        ),
      }],
    }),
  );
  server.registerTool(
    "guedder_descobrir_eventos",
    {
      title: "Descobrir eventos",
      description:
        "Descobre eventos: sem nenhum filtro, traz os destaques da home (o que está em cartaz agora). " +
        "Com cidade/estado/categoria/busca, procura no catálogo completo. " +
        "Substitui guedder_listar_eventos e guedder_eventos_destaque. " +
        "Schema detalhado: guedder://openapi/v3/tools/guedder_descobrir_eventos.",
      inputSchema: {
        cidade: z.string().optional().describe("Nome da cidade"),
        estado: z.string().optional().describe("Sigla UF, ex: SP"),
        categoria: z.string().optional().describe("Ver guedder_listar_categorias_evento"),
        busca: z.string().optional().describe("Texto livre no nome do evento"),
        max_results: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(20)
          .describe("Máximo de eventos; ignorado sem filtro (destaques não paginam)"),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: any) => {
      try {
        const temFiltro = Boolean(args?.cidade || args?.estado || args?.categoria || args?.busca);
        const data = temFiltro
          ? await apiGet("/api/v3/eventos", {
              query: {
                page: 1, // a API pagina a partir de 1, não de 0.
                page_size: args?.max_results,
                filtro: args?.busca,
                nomeCidade: args?.cidade,
                nomeEstado: args?.estado,
                categoriaEventoEnum: args?.categoria,
              },
            })
          : await apiGet("/api/v3/home/destaques");
        return ok(data);
      } catch (e: any) {
        return falha(e);
      }
    },
  );

  server.registerResource(
    "guedder_detalhes_evento_schema",
    "guedder://openapi/v3/tools/guedder_detalhes_evento",
    {
      title: "Schema: Detalhes do evento",
      description: "Operações compostas: getEventoById + listarAtracoesPorEvento + listarLotesPublicos + getParametrosVenda.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            evento: openApiOperation("getEventoById"),
            atracoes: openApiOperation("listarAtracoesPorEvento"),
            lotes: openApiOperation("listarLotesPublicos"),
            parametrosVenda: openApiOperation("getParametrosVenda"),
          },
          null,
          2,
        ),
      }],
    }),
  );
  server.registerTool(
    "guedder_detalhes_evento",
    {
      title: "Detalhes de um evento",
      description:
        "Dados de UM evento (id de guedder_descobrir_eventos). Sem `incluir`, só o básico: nome, data, local. " +
        "Peça `incluir` para o que mais precisar: line-up, lotes com preço, formas de pagamento. " +
        "Substitui guedder_get_evento, guedder_listar_atracoes_evento, guedder_listar_lotes_evento e " +
        "guedder_get_parametros_venda. Ausência de parametrosVenda (null) = organizador ainda não " +
        "configurou — \"ainda não divulgado\", não é erro nem significa evento inexistente. " +
        "Schema detalhado: guedder://openapi/v3/tools/guedder_detalhes_evento.",
      inputSchema: {
        eventoId: ID_OU_CODIGO.describe("UUID ou código alfanumérico do evento"),
        incluir: z
          .array(z.enum(["atracoes", "lotes", "venda"]))
          .optional()
          .describe("O que buscar além do básico: line-up, lotes com preço, formas de pagamento"),
      },
      outputSchema: TOOL_OUTPUT_SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args: any) => {
      try {
        const eventoId = String(args?.eventoId ?? "");
        const incluir = new Set<string>(args?.incluir ?? []);
        const resultado: Record<string, unknown> = {
          evento: await apiGet(`/api/v3/eventos/${enc(eventoId)}`),
        };
        if (incluir.has("atracoes")) resultado.atracoes = await apiGet(`/api/v3/eventos/${enc(eventoId)}/atracoes`);
        if (incluir.has("lotes")) resultado.lotes = await apiGet(`/api/v3/eventos/${enc(eventoId)}/lotes`);
        if (incluir.has("venda")) {
          try {
            resultado.parametrosVenda = await apiGet(`/api/v3/eventos/${enc(eventoId)}/parametros-venda`);
          } catch (e: any) {
            // 404 aqui é regra de negócio ("ainda não divulgado"), não falha da
            // tool — só o 404 DESTE endpoint; o do evento acima propaga normal.
            if (/-> 404\b/.test(String(e?.message))) resultado.parametrosVenda = null;
            else throw e;
          }
        }
        return ok(resultado);
      } catch (e: any) {
        return falha(e);
      }
    },
  );

  // guedder_status_da_compra — não existia como endpoint. /api/v3/compras
  // (ResumoTicketsVO) não expõe NENHUM id de pedido; quem tem `idPedido` é o
  // ingresso. "Status desta compra" só é respondível agregando os ingressos do
  // mesmo idPedido — daí compor sobre /api/v3/ingressos, não sobre /compras.
  if (!PUBLIC_ONLY) {
    server.registerTool(
      "guedder_status_da_compra",
      {
        title: "Status de uma compra",
        description:
          "Agrega os ingressos de UM pedido (identificador = idPedido, como aparece em " +
          "guedder_meus_ingressos ou guedder_minhas_compras) e devolve evento, quantidade e o " +
          "status de cada ingresso daquele pedido. Sem correspondência, devolve erro apontando " +
          "para guedder_meus_ingressos.",
        inputSchema: {
          identificador: z.string().describe("idPedido de um dos ingressos"),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: any) => {
        try {
          portaoDeEscopo("guedder_status_da_compra", "conta:read", caller);
          const identificador = String(args?.identificador ?? "");
          const pagina: any = await apiGet("/api/v3/ingressos", { query: { size: 100, page: 0 }, auth: true, caller });
          // Redige ANTES de recortar: o `codigo` do ingresso é a credencial de
          // entrada, e o recorte abaixo o copiaria para fora do objeto que tem
          // cara de ingresso, onde a redação já não o reconheceria.
          const doPedido = redigir(pagina?.content ?? []).filter(
            (i: any) => i?.idPedido === identificador || i?.compraId === identificador,
          );
          if (doPedido.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: `Nenhum ingresso encontrado para "${identificador}". Use guedder_meus_ingressos para achar o idPedido correto.`,
              }],
              isError: true,
            };
          }
          const resultado = {
            idPedido: identificador,
            nomeEvento: doPedido[0].nomeEvento,
            dataInicioEvento: doPedido[0].dataInicioEvento,
            quantidade: doPedido.length,
            ingressos: doPedido.map((i: any) => ({ codigo: i.codigo, status: i.status, ativo: i.ativo })),
          };
          return ok(resultado);
        } catch (e: any) {
          return falha(e, "conta:read");
        }
      },
    );
  }

  // ── Escrita ────────────────────────────────────────────────────────────────
  // Primeira tool que muda estado. Três portões em série, e cada um responde uma
  // pergunta diferente:
  //
  //   escopo        — a pessoa autorizou o AGENTE a fazer isto por ela?
  //   confirmação   — a pessoa mandou fazer ISTO, neste pedido, agora?
  //   a própria API — a pessoa PODE fazer isto? (dono do pedido, prazo, check-in)
  //
  // O terceiro é o que já existia e continua sendo a autoridade: o MCP não
  // reimplementa regra de cancelamento, e não deve. `validarCancelamentoDeCompra`
  // na API é quem sabe de janela de 7 dias, 48h do evento e ingresso já bipado.
  if (!PUBLIC_ONLY) {
    server.registerTool(
      "guedder_cancelar_pedido",
      {
        title: "Cancelar um pedido",
        description:
          "Cancela um pedido da pessoa logada e devolve o valor pelo mesmo meio de pagamento. " +
          "Chame PRIMEIRO sem `confirmacao` para receber o resumo e o código; mostre esse resumo à pessoa, " +
          "e só chame de novo com o código depois que ela confirmar. Nunca invente o código. " +
          "O cancelamento é assíncrono: a API aceita o pedido e o estorno acontece em seguida no gateway.",
        inputSchema: {
          pedidoId: ID_OU_CODIGO.describe("Id do pedido a cancelar, como aparece em guedder_minhas_compras"),
          confirmacao: z
            .string()
            .optional()
            .describe("Código devolvido pela chamada anterior. Sem ele, nada é cancelado."),
        },
        // Sem `outputSchema` de propósito: esta tool devolve duas coisas
        // diferentes — o resumo em português da fase 1 e a resposta da API na
        // fase 2. Declarar o schema da segunda obrigaria a primeira a fingir ser
        // um resultado de API que ela não é.
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          // Cancelar duas vezes não é o mesmo que cancelar uma: a segunda tende a
          // bater num pedido que já não está PAGO e voltar erro.
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        const pedidoId = String(args?.pedidoId ?? "");
        // `caller?` e não `caller!`: com Cognito ligado e transporte stdio o
        // servidor sobe sem caller; `portaoDeEscopo` devolve o erro de
        // autenticação certo em vez de um TypeError.
        return executarEscrita({
          tool: "guedder_cancelar_pedido",
          escopo: "pedido:cancelar",
          alvo: pedidoId,
          args: args ?? {},
          caller,
          preparar: async () => ({
            resumo:
              `Vou cancelar o pedido ${pedidoId}. O valor volta pelo mesmo meio de pagamento, ` +
              `e a operação não tem desfazer: reservar de novo depende de ainda haver lote disponível.`,
            executar: () => apiPost(`/api/v3/pedidos/${enc(pedidoId)}/cancelamento`, { caller }),
          }),
        });
      },
    );
  }

  // ── Gestão de evento (GUE-550 + GUE-568) ───────────────────────────────────
  // Primeiro passo de quem produz: achar o evento entre os que gerencia.
  // Depois: duas leituras e duas escritas. Quem decide se a pessoa PODE ver
  // vendas ou criar lote neste evento é a API; aqui o portão é só o escopo
  // (o que ela deixou o agente fazer) e, nas escritas, a confirmação.
  //
  // guedder_meus_eventos: um GET só em /api/v3/eventos/gestao. Sem atalho de
  // repasses e sem filtro local por vendedorId/papel — isso seria heurística
  // frágil (ADMIN+GERENTE de terceiro sumiria, ou pior: inventaríamos vínculo).
  //
  // O UNION da API inclui ramo `isAdmin` (acervo). Decisão do Danilo (GUE-568
  // follow-up): ver mais eventos como ADMIN não é problema, desde que a tool
  // pagine e, por padrão, traga só os mais recentes (`sort=dataCriacao,desc`,
  // `page_size` pequeno). Sem `somenteVinculo`.
  if (!PUBLIC_ONLY) {
    server.registerResource(
      "guedder_meus_eventos_schema",
      "guedder://openapi/v3/tools/guedder_meus_eventos",
      {
        title: "Schema: Meus eventos",
        description: "Operação listarEventosDeGestao; a tool devolve um recorte (id, nome, datas, terminou).",
        mimeType: "application/json",
      },
      async (uri) => ({
        contents: [{
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(openApiOperation("listarEventosDeGestao"), null, 2),
        }],
      }),
    );
    server.registerTool(
      "guedder_meus_eventos",
      {
        title: "Meus eventos (gestão)",
        description:
          "Lista os eventos que a pessoa logada gerencia: os que produz e os em que tem papel " +
          "SOCIO, GERENTE ou CHECKIN. Devolve id, nome, dataInicio, dataFim e se já terminou, " +
          "mais página/total para seguir paginando. Por padrão: os mais recentes " +
          "(`dataCriacao,desc`) e poucas linhas. ADMIN da plataforma pode ver além dos " +
          "vínculos — use página e filtro. Não é a lista de repasses. " +
          "Schema: guedder://openapi/v3/tools/guedder_meus_eventos.",
        inputSchema: {
          filtro: z.string().optional().describe("Busca textual no nome, local ou descrição"),
          page: z
            .number()
            .int()
            .min(1)
            .default(1)
            .describe("Página 1-based; padrão 1"),
          max_results: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(10)
            .describe("Itens por página; padrão 10, máximo 50"),
        },
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: any) => {
        try {
          // page 1-based. sort fechado da API: só dataCriacao — "mais recentes".
          const pagina: any = await apiGet("/api/v3/eventos/gestao", {
            query: {
              page: args?.page ?? 1,
              page_size: args?.max_results ?? 10,
              filtro: args?.filtro,
              sort: "dataCriacao,desc",
            },
            auth: true,
            caller,
          });
          const agora = Date.now();
          const eventos = (pagina?.content ?? []).map((e: any) => {
            const dataFim = e?.dataFim ?? null;
            const fimMs = dataFim == null ? NaN : Date.parse(String(dataFim));
            return {
              id: e?.id,
              nome: e?.nome,
              dataInicio: e?.dataInicio ?? null,
              dataFim,
              terminou: Number.isFinite(fimMs) && fimMs < agora,
            };
          });
          const meta = pagina?.page ?? {};
          return ok({
            eventos,
            page: meta.number != null ? Number(meta.number) + 1 : (args?.page ?? 1),
            pageSize: meta.size ?? args?.max_results ?? 10,
            totalElements: meta.totalElements ?? eventos.length,
            totalPages: meta.totalPages ?? 1,
          });
        } catch (e: any) {
          return falha(e);
        }
      },
    );

    server.registerTool(
      "guedder_ingressos_vendidos_periodo",
      {
        title: "Ingressos vendidos no período",
        description:
          "Soma os ingressos pagos de UM evento num período de até 31 dias, com dias no fuso de São Paulo. " +
          "Sem datas, é o dia de hoje. Devolve o total e a quebra por dia (0 nos dias sem venda). " +
          "Exige o escopo vendas:read e permissão sobre o evento.",
        inputSchema: {
          eventoId: UUID_,
          de: DIA.optional().describe("Primeiro dia (AAAA-MM-DD). Padrão: o mesmo de `ate`"),
          ate: DIA.optional().describe("Último dia, inclusivo (AAAA-MM-DD). Padrão: hoje"),
        },
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: any) => {
        try {
          const eventoId = String(args?.eventoId ?? "");
          portaoDeEscopo("guedder_ingressos_vendidos_periodo", "vendas:read", caller, eventoId);
          const ate: string = args?.ate ?? hojeEmSaoPaulo();
          const de: string = args?.de ?? ate;
          const n = quantosDias(de, ate);
          if (n <= 0) throw new Error(`Período inválido: ${de} é depois de ${ate}.`);
          if (n > MAX_DIAS_PERIODO) {
            throw new Error(`Período de ${n} dias; o máximo é ${MAX_DIAS_PERIODO}. Divida em consultas menores.`);
          }
          const dias = diasDoPeriodo(de, ate);
          const { nomeEvento, porDia } = await vendasPorDia(eventoId, de, caller);
          const quebra = dias.map((data) => ({ data, ingressosPagos: porDia.get(data) ?? 0 }));
          return ok({
            eventoId,
            nomeEvento,
            de,
            ate,
            totalIngressosPagos: quebra.reduce((soma, d) => soma + d.ingressosPagos, 0),
            porDia: quebra,
          });
        } catch (e: any) {
          return falha(e, "vendas:read");
        }
      },
    );

    server.registerTool(
      "guedder_lotes_esgotados",
      {
        title: "Lotes esgotados",
        description:
          "Lista os lotes ATIVOS de um evento que já venderam todo o estoque. Lote desativado não conta como esgotado. " +
          "Exige o escopo vendas:read e permissão sobre o evento.",
        inputSchema: { eventoId: UUID_ },
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      },
      async (args: any) => {
        try {
          const eventoId = String(args?.eventoId ?? "");
          portaoDeEscopo("guedder_lotes_esgotados", "vendas:read", caller, eventoId);
          const lotes = await listarLotes(eventoId, caller);
          // Conta própria em vez de `estoqueDisponivel`: a API devolve 0 ali para
          // lote INATIVO, e todo lote desligado apareceria como esgotado.
          // Sem `estoqueInicial` não dá para dizer que esgotou: ausente não é zero.
          const esgotados = lotes
            .filter((l) => (l?.enabled ?? l?.ativo) !== false)
            .filter((l) => typeof l?.estoqueInicial === "number")
            .filter((l) => l.estoqueInicial - Number(l?.ingressosVendidos ?? 0) <= 0)
            .map((l) => ({ id: l.id, nome: l.nome, estoqueInicial: l.estoqueInicial, ingressosVendidos: l.ingressosVendidos ?? 0 }));
          return ok({ eventoId, totalLotes: lotes.length, esgotados });
        } catch (e: any) {
          return falha(e, "vendas:read");
        }
      },
    );

    server.registerTool(
      "guedder_criar_lote",
      {
        title: "Criar lote",
        description:
          "Cria um lote de ingressos num evento. `estoqueInicial` é o total de ingressos do lote (o \"limite de retiradas\"). " +
          "Datas com offset explícito, ex.: 2026-11-01T20:00:00-03:00. " +
          "Chame PRIMEIRO sem `confirmacao` para receber o resumo e o código; mostre o resumo à pessoa e só chame de novo, " +
          "com os mesmos argumentos e o código, depois que ela confirmar. Exige o escopo lote:write.",
        inputSchema: {
          eventoId: UUID_,
          nome: z.string().trim().min(1).describe("Nome do lote, único no evento"),
          estoqueInicial: z.number().int().positive().describe("Quantidade de ingressos do lote"),
          precoUnitario: z.number().nonnegative().default(0).describe("Preço por ingresso, em reais. Padrão 0 (gratuito)"),
          inicioVendas: DATA_COM_OFFSET,
          terminoVendas: DATA_COM_OFFSET,
          privado: z.boolean().default(false).describe("Lote privado só aparece para quem tem o link/código"),
          compraMaxima: z.number().int().positive().optional().describe("Máximo de ingressos por compra"),
          confirmacao: z.string().optional().describe("Código devolvido pela chamada anterior. Sem ele, nada é criado."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args: any) => {
        const a = args ?? {};
        const eventoId = String(a.eventoId ?? "");
        return executarEscrita({
          tool: "guedder_criar_lote",
          escopo: "lote:write",
          alvo: eventoId,
          eventoId,
          args: a,
          caller,
          preparar: async () => ({
            resumo: [
              `Vou criar o lote "${a.nome}" no evento ${eventoId}:`,
              `- ${a.estoqueInicial} ingressos (é o limite de vendas/retiradas do lote);`,
              `- preço: ${a.precoUnitario > 0 ? `${brl(a.precoUnitario)} por ingresso` : "gratuito"};`,
              `- vendas de ${a.inicioVendas} até ${a.terminoVendas};`,
              `- ${a.privado ? "privado (só aparece para quem tem o link do lote)" : "público"};`,
              `- compra máxima: ${a.compraMaxima ? `${a.compraMaxima} por compra` : "sem limite por compra"}.`,
              "O lote já nasce ativo.",
            ].join("\n"),
            executar: () =>
              apiPost(`/api/v1/lote/${enc(eventoId)}/adicionar`, {
                caller,
                // Defaults do LoteDto mandados explícitos: no Jackson 3, campo
                // omitido vira null em vez de pegar o default do DTO, e estoura
                // coluna NOT NULL.
                body: {
                  nome: a.nome,
                  estoqueInicial: a.estoqueInicial,
                  precoUnitario: a.precoUnitario,
                  inicioVendas: a.inicioVendas,
                  terminoVendas: a.terminoVendas,
                  privado: a.privado,
                  enabled: true,
                  ativo: true,
                  compraMinima: 1,
                  compraMaxima: a.compraMaxima,
                  limitarPorCpf: false,
                  aplicavelEmTodosOsSetores: true,
                  usoDeCupomObrigatorio: false,
                  ocultarValor: false,
                  taxaAmortecidaPeloProdutor: false,
                  selfCheckinHabilitado: false,
                  setores: [],
                  janelasCheckin: [],
                },
              }),
          }),
          traduzirErro: (e) =>
            e.status === 400 && /já existe um lote/i.test(e.corpo)
              ? `Já existe um lote chamado "${a.nome}" neste evento. Escolha outro nome; nada foi criado.`
              : undefined,
        });
      },
    );

    server.registerTool(
      "guedder_criar_cupom",
      {
        title: "Criar cupom de desconto",
        description:
          "Cria um cupom de desconto num evento, para lotes escolhidos pelo NOME ou para todos os lotes (lista vazia). " +
          "PERCENTUAL vai de 0 a 100; VALOR é em reais. " +
          "Chame PRIMEIRO sem `confirmacao` para receber o resumo e o código; mostre o resumo à pessoa e só chame de novo, " +
          "com os mesmos argumentos e o código, depois que ela confirmar. Exige o escopo cupom:write.",
        inputSchema: {
          eventoId: UUID_,
          nome: z.string().trim().min(1).describe("Código do cupom que o comprador digita, único no evento"),
          tipoDesconto: z.enum(["PERCENTUAL", "VALOR"]),
          valorDesconto: z.number().positive().describe("Percentual (0 a 100) ou valor em reais"),
          limite: z.number().int().positive().optional().describe("Total de usos do cupom. Ausente = sem limite"),
          lotes: z.array(z.string().trim().min(1)).optional().describe("Nomes dos lotes. Vazio ou ausente = todos os lotes"),
          confirmacao: z.string().optional().describe("Código devolvido pela chamada anterior. Sem ele, nada é criado."),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async (args: any) => {
        const a = args ?? {};
        const eventoId = String(a.eventoId ?? "");
        return executarEscrita({
          tool: "guedder_criar_cupom",
          escopo: "cupom:write",
          alvo: eventoId,
          eventoId,
          args: a,
          caller,
          preparar: async () => {
            if (a.tipoDesconto === "PERCENTUAL" && a.valorDesconto > 100) {
              throw new Error("Desconto percentual vai de 0 a 100. Nada foi criado.");
            }
            const nomes: string[] = a.lotes ?? [];
            const lotes = nomes.length ? await resolverLotes(eventoId, nomes, caller) : [];
            return {
              resumo: [
                `Vou criar o cupom "${a.nome}" no evento ${eventoId}:`,
                `- desconto: ${a.tipoDesconto === "PERCENTUAL" ? `${a.valorDesconto}%` : brl(a.valorDesconto)};`,
                `- vale para: ${lotes.length ? lotes.map((l) => `"${l.nome}" (id ${l.id})`).join(", ") : "todos os lotes do evento"};`,
                `- limite: ${a.limite ? `${a.limite} usos no total` : "sem limite de usos"};`,
                "- cada pessoa usa o cupom em uma compra, e o desconto vale para um ingresso por compra (o mais caro).",
                "O cupom já nasce ativo.",
              ].join("\n"),
              amarra: lotes,
              executar: () =>
                apiPost(`/api/v1/cupom/${enc(eventoId)}`, {
                  caller,
                  body: {
                    nome: a.nome,
                    tipoDesconto: a.tipoDesconto,
                    valorDesconto: a.valorDesconto,
                    limite: a.limite,
                    lotes: lotes.map((l) => ({ id: l.id, nome: l.nome })),
                    // Explícito: a API já trata lista vazia como "todos", mas
                    // por um caminho (carrega os lotes de hoje) que congela a
                    // lista. Com a flag, vale também para lote criado depois.
                    aplicavelEmTodosOsLotes: lotes.length === 0,
                    ativo: true,
                    // Defaults do CupomDto, explícitos pelo mesmo motivo do lote.
                    limitarUmaCompraPorUsuario: true,
                    limitarUmIngressoPorCompra: true,
                  },
                }),
            };
          },
          traduzirErro: (e) =>
            e.status === 409
              ? `Já existe um cupom chamado "${a.nome}" neste evento. Escolha outro nome; nada foi criado.`
              : undefined,
        });
      },
    );
  }

  // Auditoria: única tool que não age como o usuário — ela usa a credencial AWS da task.
  // Por isso o portão é aqui e não na API: a API não está no caminho (ADR 0001 §9.7).
  if (auditoria && !PUBLIC_ONLY) {
    server.registerTool(
      "guedder_rastrear_compra",
      {
        title: "Rastrear compra no log",
        description:
          "Correlaciona uma compra com o rastro dela na plataforma. Informe o id do pedido, o id da compra OU um trace_id. " +
          "Devolve a linha do tempo do request, com campos recortados. Requer perfil administrativo.",
        inputSchema: {
          identificador: z
            .string()
            .describe("id do pedido, id da compra ou trace_id. Sem curingas."),
          max_linhas: z
            .number()
            .int()
            .positive()
            .max(200)
            .optional()
            .describe("Teto de linhas devolvidas."),
        },
        outputSchema: TOOL_OUTPUT_SCHEMA,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      async (args: any) => {
        try {
          if (AUTH && !caller?.isAdmin) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: "Acesso negado: rastreio de log exige perfil administrativo.",
                },
              ],
              isError: true,
            };
          }
          const identificador = String(args?.identificador ?? "");
          // trace_id do OTel é hex de 32; qualquer outra coisa passa pela busca da âncora.
          const traceId = /^[0-9a-f]{32}$/i.test(identificador.trim())
            ? identificador.trim()
            : await auditoria.traceDoIdentificador(identificador);

          if (!traceId) {
            const data = {
              encontrado: false,
              motivo:
                "Nenhuma linha de log com esse identificador na janela consultada. Confirme o id, ou informe o trace_id diretamente.",
            };
            return ok(data);
          }

          const linhas = await auditoria.linhasDoTrace(traceId, args?.max_linhas);
          // `message` de log é texto livre e pode ter e-mail de comprador: a
          // allowlist de campos de auditoria.ts não basta, a redação também passa.
          return ok({ encontrado: true, trace_id: traceId, linhas });
        } catch (e: any) {
          return falha(e);
        }
      },
    );
  }

  return server;
}

const METADATA_PATH = "/.well-known/oauth-protected-resource";

const AS_METADATA_PATH = "/.well-known/oauth-authorization-server";

/** Corpo cru do request. Usado só no repasse do /token, que é form-urlencoded. */
function lerCorpo(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let dados = "";
    req.on("data", (c) => {
      dados += c;
      // Teto defensivo: o corpo de um token request tem centenas de bytes. Sem
      // limite, um POST grande neste endpoint público viraria memória do processo.
      if (dados.length > 64_000) reject(new Error("Corpo do token request grande demais."));
    });
    req.on("end", () => resolve(dados));
    req.on("error", reject);
  });
}

async function handleStreamableHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = `http://${req.headers.host ?? "localhost"}`;
  const pathname = new URL(req.url ?? "/", base).pathname;

  // Log de request. O servidor era mudo, e quando um cliente MCP desistia no meio
  // da descoberta não havia como saber em que passo — só o erro genérico do lado
  // dele. Uma linha por request responde "ele chegou a buscar isto?", que é a
  // primeira pergunta em toda investigação de OAuth.
  const inicio = Date.now();
  res.on("finish", () => {
    console.error(
      `${req.method} ${pathname}${detalheOauth(pathname, req)} -> ${res.statusCode} (${Date.now() - inicio}ms)`,
    );
  });

  // RFC 9728: o cliente MCP lê isto depois do 401 para saber onde autenticar.
  if (AUTH && pathname === METADATA_PATH) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(protectedResourceMetadata(AUTH), null, 2));
    return;
  }

  // RFC 8414. O Cognito não serve este caminho (400 em todas as formas) e declara
  // errado o que serve — ver authorizationServerMetadata em auth.ts.
  if (AUTH && pathname === AS_METADATA_PATH) {
    try {
      const doc = await authorizationServerMetadata(AUTH);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(doc, null, 2));
    } catch (e: any) {
      console.error(`Falha ao espelhar a metadata do Cognito: ${e?.message ?? e}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Não foi possível obter a metadata do authorization server." }));
    }
    return;
  }

  // Fachada de authorization server.
  //
  // Alguns clientes MCP ignoram o `authorization_endpoint` do documento e montam
  // `<base do AS>/authorize` por convenção. Como a nossa metadata RFC 9728
  // declara este servidor como authorization server, o navegador do usuário vem
  // parar aqui — comprovado por um `GET /favicon.ico` no log, que só existe se um
  // navegador navegou até esta origem.
  //
  // Redirecionar em vez de reimplementar: o Cognito segue sendo quem autentica,
  // emite código e troca por token. Isto é só o encaminhamento que falta para o
  // cliente que não lê o documento.
  if (AUTH && pathname === "/authorize") {
    try {
      const pedido = new URL(req.url ?? "/", base).searchParams;

      // A tela de consent vive aqui porque o Cognito não tem uma: se o escopo
      // está no app client e o cliente pede, ele emite sem perguntar nada à
      // pessoa (`prompt=consent` só é repassado a IdP externo). Como já somos o
      // front door do /authorize, é aqui que a pessoa escolhe.
      if (!consentiuDeVerdade(pedido)) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(telaDeConsent(pedido, escoposConcediveis(AUTH), AUTH.resource));
        return;
      }

      const { authorize } = await cognitoEndpoints(AUTH);
      const destino = new URL(authorize);
      pedido.forEach((v, k) => destino.searchParams.set(k, v));
      destino.searchParams.delete("consentido");

      // Interseção com o que ESTE servidor anuncia. Sem ela a tela é decorativa:
      // bastaria montar a query à mão com o escopo que se quisesse. Escopo que o
      // Cognito não conhece ainda seria ignorado por ele, mas escopo que ele
      // conhece e nós não anunciamos passaria direto.
      const pedidos = new Set(pedido.getAll("scope").flatMap((s) => s.split(/\s+/)).filter(Boolean));
      const concedidos = escoposConcediveis(AUTH).filter((s) => pedidos.has(s));
      destino.searchParams.set("scope", concedidos.join(" "));

      // RFC 8707: sem isto o access token sai sem `aud` e a amarração de
      // superfície volta a depender só do client_id.
      destino.searchParams.set("resource", AUTH.resource);

      res.writeHead(302, { location: destino.toString() });
      res.end();
    } catch (e: any) {
      console.error(`Falha ao resolver o authorize do Cognito: ${e?.message ?? e}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Authorization server indisponível." }));
    }
    return;
  }

  // RFC 7591, versão mascarada: devolve SEMPRE o app client já registrado, em vez
  // de criar um no Cognito por registro.
  //
  // O Cognito não tem DCR, e sem isto todo cliente que exige registro dinâmico
  // (MCP Inspector, Claude Code) para antes de autenticar. Como este MCP vai no
  // plugin da Guedder, exigir `client_id` colado à mão em cada instalação não é
  // opção — é justamente o que o plugin existe para evitar.
  //
  // Mascarar em vez de criar de verdade: os `redirect_uri` que importam já estão
  // na lista de callbacks do app client, e o `client_id` não é segredo (cliente
  // público, PKCE). Quem gateia continua sendo o login no Cognito, e o recorte de
  // `redirect_uri` continua sendo dele — registrar aqui um callback fora da lista
  // não faz o Cognito aceitá-lo no /authorize.
  //
  // Se algum dia aparecer cliente com `redirect_uri` imprevisível (porta local
  // sorteada), este atalho deixa de servir e a saída é CreateUserPoolClient por
  // registro, com TTL e coleta — o log abaixo é o que vai dizer se chegamos lá.
  if (AUTH && pathname === "/register" && req.method === "POST") {
    try {
      const corpo = await lerCorpo(req);
      const pedido = corpo ? JSON.parse(corpo) : {};
      console.error(`register: redirect_uris=${JSON.stringify(pedido.redirect_uris ?? [])}`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        client_id: AUTH.clientId,
        // Cliente público: sem secret, e o `token_endpoint_auth_method` precisa
        // dizer isso, senão o cliente tenta autenticar no /token e o Cognito
        // recusa.
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        redirect_uris: pedido.redirect_uris ?? [],
        client_id_issued_at: Math.floor(Date.now() / 1000),
      }));
    } catch (e: any) {
      console.error(`Falha no registro: ${e?.message ?? e}`);
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client_metadata" }));
    }
    return;
  }

  // Método errado em endpoint que EXISTE responde 405, não 404. O 404 manda
  // investigar roteamento, que é o caminho errado — foi o que fez `GET /token`
  // parecer rota inexistente quando era só método.
  if (AUTH && ["/token", "/register"].includes(pathname) && req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json", allow: "POST" });
    res.end(JSON.stringify({ error: `${pathname} aceita apenas POST.` }));
    return;
  }

  // O /token NÃO pode ser 302: é POST com corpo, e redirect faria o cliente
  // perder o corpo (ou virar GET). Repassa e devolve a resposta como veio.
  if (AUTH && pathname === "/token" && req.method === "POST") {
    try {
      const { token } = await cognitoEndpoints(AUTH);
      const corpo = await lerCorpo(req);
      const upstream = await fetch(token, {
        method: "POST",
        headers: {
          "content-type": req.headers["content-type"] ?? "application/x-www-form-urlencoded",
          // Client confidencial manda Basic; o nosso é público e não manda nada.
          // Repassar o que vier mantém os dois casos funcionando.
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
        },
        body: corpo,
      });
      const texto = await upstream.text();
      // Erro do Cognito no log. Ele volta como {"error":"invalid_grant"} e sem
      // isto o log dizia só "POST /token -> 400", que não diz o que recusar
      // significa. O corpo de ERRO não traz token nem código — só o motivo.
      if (!upstream.ok) console.error(`token: cognito ${upstream.status} ${texto.slice(0, 200)}`);
      res.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      res.end(texto);
    } catch (e: any) {
      console.error(`Falha ao repassar o token do Cognito: ${e?.message ?? e}`);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Token endpoint indisponível." }));
    }
    return;
  }

  if (pathname !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint MCP não encontrado." }));
    return;
  }

  // Identidade do chamador. Sem Cognito configurado o servidor segue no modo antigo.
  let caller: Caller | undefined;
  if (AUTH && verifyToken) {
    try {
      caller = await verifyToken(req.headers.authorization);
    } catch (e) {
      const metadataUrl = `${req.headers["x-forwarded-proto"] ?? "http"}://${req.headers.host ?? "localhost"}${METADATA_PATH}`;
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": wwwAuthenticate(AUTH, metadataUrl),
      });
      res.end(
        JSON.stringify({
          error: e instanceof AuthError ? e.message : "Não autenticado.",
        }),
      );
      return;
    }
  }

  // Stateless MCP: cada requisição recebe um servidor/transport novo e não há sessão em memória.
  const server = createMcpServer(caller);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (error) {
    console.error("Erro no transporte Streamable HTTP:", error);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Erro interno do MCP." }));
    }
  }
}

if (MCP_TRANSPORT === "stdio") {
  const server = createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`guedder-ops MCP stdio no ar (base=${BASE}, auth=${BEARER_TOKEN ? "bearer definido" : "somente público"})`);
} else if (MCP_TRANSPORT === "streamable-http") {
  if (!Number.isInteger(MCP_PORT) || MCP_PORT < 1 || MCP_PORT > 65_535) {
    throw new Error("GUEDDER_MCP_PORT deve ser uma porta válida.");
  }
  createServer((req, res) => void handleStreamableHttpRequest(req, res)).listen(MCP_PORT, MCP_HOST, () => {
    console.error(`guedder-ops MCP Streamable HTTP no ar em http://${MCP_HOST}:${MCP_PORT}${MCP_PATH}`);
  });
} else {
  throw new Error("GUEDDER_MCP_TRANSPORT deve ser 'streamable-http' ou 'stdio'.");
}

/**
 * Query string dos endpoints de OAuth, para o log.
 *
 * Sem isto o log diz "GET /authorize -> 302" e não diz PARA ONDE nem COM QUE
 * parâmetros — que é justamente a pergunta quando o cliente reclama de
 * `provider_redirect`. Duas rodadas de investigação foram perdidas por hipótese
 * sobre `redirect_uri` que o log não confirmava nem desmentia.
 *
 * `code` e `code_verifier` saem redigidos: são credenciais de uso único, e log de
 * container vai para o CloudWatch, que tem retenção e leitores diferentes de quem
 * está depurando.
 */
const REDIGIR = new Set(["code", "code_verifier", "client_secret", "refresh_token"]);

/**
 * Escopos de identidade. Não entram na tela porque não são permissão: são o
 * mínimo para o Cognito dizer QUEM é a pessoa. Desmarcá-los não daria uma
 * conexão mais restrita, daria uma conexão que não funciona.
 */
const ESCOPOS_DE_IDENTIDADE = new Set(["openid", "email", "profile", "phone"]);

/**
 * O que este servidor aceita conceder, com `openid` garantido.
 *
 * `GUEDDER_MCP_SCOPES` precisa espelhar o `allowed_oauth_scopes` do Terraform, e
 * listar ali só os escopos customizados é um erro plausível. Sem `openid` o
 * authorize sai sem escopo de identidade, então não vem id_token nem a claim
 * `email`, e o verifier recusa todo token com "Token sem email". Falha que só
 * aparece no login real, nunca em teste.
 *
 * Um lugar só, porque o formulário e a interseção precisam concordar: garantir
 * `openid` no HTML e deixá-lo cair na interseção não consertaria nada.
 */
function escoposConcediveis(cfg: { scopes?: string[] }): string[] {
  const lista = cfg.scopes ?? [];
  return lista.includes("openid") ? lista : ["openid", ...lista];
}

/**
 * O que cada escopo autoriza, na língua de quem vai decidir. Escopo sem texto
 * aqui aparece pelo nome cru — feio, e de propósito: é o lembrete de que escopo
 * novo sem explicação é permissão que a pessoa concede sem entender.
 */
const TEXTO_DO_ESCOPO: Record<string, string> = {
  "conta:read": "Ver seus ingressos, suas compras e seus dados de perfil",
  "pedido:cancelar":
    "Cancelar pedidos seus, o que devolve o valor pelo mesmo meio de pagamento. O agente vai pedir sua confirmação antes de cada cancelamento",
  "vendas:read":
    "Ver vendas dos eventos que você gerencia: resumo, auditoria de vendas recentes, ingressos vendidos por período e lotes esgotados",
  "lote:write":
    "Criar lotes de ingresso nos eventos que você gerencia. O agente vai pedir sua confirmação antes de cada criação",
  "cupom:write":
    "Criar cupons de desconto nos eventos que você gerencia. O agente vai pedir sua confirmação antes de cada criação",
};

/**
 * Prova de que a tela de consent foi renderizada para ESTE pedido de autorização.
 *
 * A primeira versão usava um literal (`consentido=1`), e quem monta a URL do
 * /authorize é o cliente MCP: bastava acrescentar o parâmetro para o servidor
 * conceder sem nunca mostrar a tela, e a pessoa via só o login do Cognito, que
 * não exibe escopo nenhum. O parâmetro precisa ser algo que o cliente não
 * consiga escrever sozinho.
 *
 * Amarrada ao pedido (client_id, redirect_uri, state, code_challenge), para não
 * virar passe reutilizável em outro redirect_uri. A janela de tempo vem em
 * blocos de 10 minutos, e aceitamos o bloco atual e o anterior: a pessoa está
 * lendo a tela nesse meio tempo, e expirar no meio da leitura seria pior que o
 * risco de uma prova velha.
 *
 * ponytail: HMAC sem estado, não nonce em banco. Um nonce de uso único não
 * compraria o que parece comprar, porque a tela é pública e o cliente pode
 * buscá-la para obter um nonce fresco. Isto eleva a barra de "somar um
 * parâmetro" para "buscar a tela e repetir a prova", e fecha o caso do cliente
 * que pula a tela por descuido. Fechar o caso do cliente deliberado exige o
 * pacote da ADR 0006 ((a) ou (b)) — confidencial + sessão sozinho não basta.
 */
function provaDeConsent(pedido: URLSearchParams, deslocamento = 0): string {
  return hmacDeConsent(
    ["client_id", "redirect_uri", "state", "code_challenge"].map((k) => pedido.get(k) ?? ""),
    deslocamento,
  );
}

function consentiuDeVerdade(pedido: URLSearchParams): boolean {
  const veio = pedido.get("consentido");
  if (!veio) return false;
  // Sem short-circuit por igualdade de string em cima de segredo: compara as
  // duas janelas sempre, e o custo é irrelevante num caminho de navegador.
  return [0, 1].some((d) => {
    const esperado = provaDeConsent(pedido, d);
    return veio.length === esperado.length && timingSafeEqual(Buffer.from(veio), Buffer.from(esperado));
  });
}

function escaparHtml(valor: string): string {
  return valor.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/**
 * Tela de consent.
 *
 * TETO CONHECIDO, registrado para quem vier depois: isto é camada de
 * autorização, não barreira criptográfica. O app client do agente é público
 * (PKCE, sem secret), então um cliente malicioso que já tenha o client_id pode
 * ir direto ao /authorize do Cognito e pular esta tela. O que limita o estrago
 * continua sendo a lista de `callback_urls` do app client e os escopos que ele
 * permite. PKCE público no piloto: ADR 0006 Decisão 1 (aceita).
 *
 * "Confidencial + sessão própria" NÃO fecha o bypass sozinho (Codex P1 /
 * ADR 0006): o cliente ainda autoriza no Cognito e troca o code no /token
 * deste servidor. Fechar de verdade exige também (a) transação de consent
 * amarrada ao /token ou (b) callback upstream do MCP + code downstream.
 */
function telaDeConsent(pedido: URLSearchParams, anunciados: string[], resource: string): string {
  // O valor do checkbox é o nome COMPLETO (é o que o Cognito entende no
  // /authorize); o texto é o nome curto, que é o que a pessoa consegue ler.
  const curto = (s: string) =>
    s.startsWith(`${resource.replace(/\/+$/, "")}/`)
      ? s.slice(resource.replace(/\/+$/, "").length + 1)
      : s;
  const opcionais = anunciados.filter((s) => !ESCOPOS_DE_IDENTIDADE.has(s));
  const pedidos = new Set(
    pedido.getAll("scope").flatMap((s) => s.split(/\s+/)).filter(Boolean),
  );

  // Todo parâmetro do pedido original atravessa a tela como hidden: PKCE, state
  // e redirect_uri são do cliente, e perder qualquer um quebra o retorno.
  const ocultos = [...pedido.entries()]
    .filter(([k]) => k !== "scope" && k !== "consentido")
    .map(([k, v]) => `<input type="hidden" name="${escaparHtml(k)}" value="${escaparHtml(v)}">`)
    .join("\n      ");

  const identidade = anunciados
    .filter((s) => ESCOPOS_DE_IDENTIDADE.has(s))
    .map((s) => `<input type="hidden" name="scope" value="${escaparHtml(s)}">`)
    .join("\n      ");

  const itens = opcionais
    .map((escopo) => {
      const nome = curto(escopo);
      const marcado = pedidos.has(escopo) || pedidos.has(nome);
      return `<label class="item">
        <input type="checkbox" name="scope" value="${escaparHtml(escopo)}"${marcado ? " checked" : ""}>
        <span><strong>${escaparHtml(TEXTO_DO_ESCOPO[nome] ?? nome)}</strong>
        <code>${escaparHtml(nome)}</code></span>
      </label>`;
    })
    .join("\n      ");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Conectar agente à sua conta Guedder</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;600;700&display=swap" rel="stylesheet">
<style>
  /* Tokens de design-system/variables.css (guedder_app + guedder-ng). Login não
     carrega o CSS do front, então os valores que importam vêm hardcoded aqui —
     atualizar os dois lados juntos se a marca mudar. */
  :root {
    color-scheme: light dark;
    --cor-marca: #635BFF;
    --cor-marca-fim-gradiente: #9A00FF;
    --cor-perigo: #FF2952;
    --cor-texto: #292929;
    --cor-texto-suave: #666666;
    --cor-superficie: #FFFFFF;
    --cor-superficie-clara: #F9F9F9;
    --cor-borda: #E4E4E4;
    --sombra-card: 0 4px 15px rgba(102, 102, 102, .16);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --cor-texto: #FFFFFF;
      --cor-texto-suave: #CCCCCC;
      --cor-superficie: #1C1C1C;
      --cor-superficie-clara: #282828;
      --cor-borda: #333333;
      --sombra-card: none;
    }
  }
  * { box-sizing: border-box; }
  body {
    font: 400 16px/1.5 "Open Sans", system-ui, sans-serif;
    color: var(--cor-texto);
    background: var(--cor-superficie-clara);
    max-width: 34rem;
    margin: 0 auto;
    padding: 2.5rem 1.25rem;
  }
  .logo { height: 28px; margin-bottom: 1.75rem; }
  .logo img { height: 100%; display: block; }
  h1 { font-size: 1.35rem; font-weight: 700; margin: 0 0 .5rem; }
  .aviso { color: var(--cor-texto-suave); font-size: .9rem; margin: 0 0 1.5rem; }
  .item {
    display: flex; gap: .75rem; align-items: flex-start;
    padding: 1rem; margin-bottom: .75rem;
    background: var(--cor-superficie);
    border: 1px solid var(--cor-borda);
    border-radius: 12pt;
    box-shadow: var(--sombra-card);
  }
  .item input[type=checkbox] { accent-color: var(--cor-marca); width: 18px; height: 18px; margin-top: 2px; flex-shrink: 0; }
  .item strong { font-weight: 600; }
  .item code {
    display: block; margin-top: .25rem; font-size: .78rem;
    color: var(--cor-texto-suave); font-family: ui-monospace, monospace;
  }
  button {
    font: 600 16px "Open Sans", system-ui, sans-serif;
    color: #fff;
    background: linear-gradient(135deg, var(--cor-marca) 0%, var(--cor-marca-fim-gradiente) 100%);
    border: none;
    padding: .9rem 1.6rem;
    border-radius: 25pt;
    letter-spacing: .015rem;
    cursor: pointer;
    width: 100%;
    margin-top: .5rem;
  }
  button:hover { filter: brightness(1.05); }
  .rodape { color: var(--cor-texto-suave); font-size: .85rem; margin-top: 1.5rem; }
</style>
</head>
<body>
  <div class="logo">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://static.guedder.com/emailphotos/logobrancabottom.png">
      <img src="https://static.guedder.com/emailphotos/logoroxatop.png" alt="Guedder">
    </picture>
  </div>
  <h1>Conectar o agente à sua conta Guedder</h1>
  <p class="aviso">O agente vai agir <strong>em seu nome</strong>, com as permissões que você marcar.
  Você escolhe agora e pode reconectar com outras permissões depois.</p>
  <form method="GET" action="/authorize">
      ${ocultos}
      ${identidade}
      <input type="hidden" name="consentido" value="${escaparHtml(provaDeConsent(pedido))}">
      ${itens}
    <button type="submit">Continuar para o login</button>
  </form>
  <p class="rodape">Na próxima tela você entra com sua conta Guedder. Nada é autorizado antes disso.</p>
</body>
</html>`;
}

function detalheOauth(pathname: string, req: IncomingMessage): string {
  if (!["/authorize", "/token", "/register"].includes(pathname)) return "";
  const q = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams;
  const partes: string[] = [];
  q.forEach((v, k) => partes.push(`${k}=${REDIGIR.has(k) ? "[redigido]" : v}`));
  return partes.length ? ` ?${partes.join("&")}` : "";
}
