#!/usr/bin/env node
/**
 * @guedder/mcp — readonly MCP over Guedder API v3 (operational tasks).
 *
 * Auth: a caller-provided Bearer token (`GUEDDER_BEARER_TOKEN`) is forwarded only
 * to authenticated endpoints. OAuth2 can later replace tokenProvider() without
 * changing the tools or the HTTP client.
 *
 * ponytail: 11 thin readonly wrappers, one generic GET client, token cached + 401 re-login.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

const BASE = (process.env.GUEDDER_API_BASE ?? "https://api.guedder.com").replace(/\/+$/, "");
const BEARER_TOKEN = process.env.GUEDDER_BEARER_TOKEN?.trim();
const MCP_TRANSPORT = process.env.GUEDDER_MCP_TRANSPORT ?? "streamable-http";
const MCP_HOST = process.env.GUEDDER_MCP_HOST ?? "127.0.0.1";
const MCP_PORT = Number.parseInt(process.env.GUEDDER_MCP_PORT ?? "3000", 10);
const MCP_PATH = process.env.GUEDDER_MCP_PATH ?? "/mcp";
const OPENAPI_V3: any = JSON.parse(readFileSync(new URL("./openapi-v3.json", import.meta.url), "utf8"));
const TOOL_OUTPUT_SCHEMA = z.object({
  result: z.unknown().describe("Resultado bruto da API Guedder. O schema detalhado está em guedder://openapi/v3."),
});

async function tokenProvider(): Promise<string> {
  if (!BEARER_TOKEN) {
    throw new Error(
      "Endpoint autenticado: defina GUEDDER_BEARER_TOKEN na configuração do MCP.",
    );
  }
  return BEARER_TOKEN;
}

async function apiGet(
  path: string,
  opts: { query?: Record<string, unknown>; auth?: boolean } = {},
): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const run = async () => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth) headers.authorization = `Bearer ${await tokenProvider()}`;
    return fetch(url, { headers });
  };
  let res = await run();
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GET ${path} -> ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

type Tool = {
  name: string;
  title: string;
  description: string;
  openApiOperationId: string;
  inputSchema: z.ZodRawShape;
  auth: boolean;
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

const TOOLS: Tool[] = [
  {
    name: "guedder_listar_eventos",
    title: "Listar eventos públicos",
    description:
      "Lista até max_results eventos públicos ativos. A consulta sempre usa a primeira página; max_results tem padrão 50 e máximo 100. Filtros opcionais: nomeCidade, nomeEstado (sigla UF), categoriaEventoEnum.",
    openApiOperationId: "listarEventosLegacySingular",
    inputSchema: {
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de eventos retornados; máximo 100"),
      nomeCidade: z.string().optional(),
      nomeEstado: z.string().optional().describe("Sigla UF, ex: SP"),
      categoriaEventoEnum: z.string().optional(),
    },
    auth: false,
    build: (a) => ({
      path: "/api/v3/evento",
      query: {
        page: 0,
        page_size: a.max_results,
        nomeCidade: a.nomeCidade,
        nomeEstado: a.nomeEstado,
        categoriaEventoEnum: a.categoriaEventoEnum,
      },
    }),
  },
  {
    name: "guedder_get_evento",
    title: "Detalhe de evento",
    description: "Dados básicos de um evento por ID (UUID) ou código alfanumérico.",
    openApiOperationId: "getEventoById",
    inputSchema: { id: z.string().describe("UUID ou código do evento") },
    auth: false,
    build: (a) => ({ path: `/api/v3/evento/${enc(a.id)}` }),
  },
  {
    name: "guedder_listar_categorias_evento",
    title: "Listar categorias de evento",
    description: "Lista todas as categorias de evento disponíveis.",
    openApiOperationId: "listarCategoriasEvento",
    inputSchema: {},
    auth: false,
    build: () => ({ path: "/api/v3/evento/categorias/publico" }),
  },
  {
    name: "guedder_listar_atracoes_evento",
    title: "Line-up do evento",
    description: "Lista as atrações (line-up) de um evento.",
    openApiOperationId: "listarAtracoesPorEvento",
    inputSchema: { eventoId: z.string() },
    auth: false,
    build: (a) => ({ path: `/api/v3/evento/${enc(a.eventoId)}/atracoes/publico` }),
  },
  {
    name: "guedder_listar_lotes_evento",
    title: "Lotes do evento",
    description: "Lista os lotes disponíveis para compra num evento. loteId opcional filtra um lote específico.",
    openApiOperationId: "listarLotesPublicos",
    inputSchema: { eventoId: z.string(), loteId: z.string().optional() },
    auth: false,
    build: (a) => ({ path: `/api/v3/lote/evento/${enc(a.eventoId)}/publico`, query: { loteId: a.loteId } }),
  },
  {
    name: "guedder_get_parametros_venda",
    title: "Parâmetros de venda do evento",
    description: "Formas de pagamento e regras de venda de um evento. Pode retornar 404 se não configurado.",
    openApiOperationId: "getParametrosVenda",
    inputSchema: { eventoId: z.string() },
    auth: false,
    build: (a) => ({ path: `/api/v3/compra/evento/${enc(a.eventoId)}/parametros-venda/publico` }),
  },
  {
    name: "guedder_get_lote",
    title: "Lote por código/ID",
    description: "Retorna um lote pelo código ou ID do evento e do lote (aceita UUID ou código). Requer auth.",
    openApiOperationId: "getLotePorCodigoOuId",
    inputSchema: { codigoOrEventoId: z.string(), codigoOrLoteId: z.string() },
    auth: true,
    build: (a) => ({ path: `/api/v3/lote/${enc(a.codigoOrEventoId)}/lote/${enc(a.codigoOrLoteId)}` }),
  },
  {
    name: "guedder_buscar_ingressos_evento",
    title: "Ingressos do evento (check-in)",
    description:
      "Lista ingressos de um evento para check-in (acesso produtor/admin do evento). Filtro por texto livre (nome/email/código), paginação, sessão e ordenação.",
    openApiOperationId: "buscarIngressosPorEvento",
    inputSchema: {
      eventoId: z.string(),
      filtro: z.string().optional().describe("Busca por nome, email ou código"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de ingressos retornados; máximo 100"),
      sessaoId: z.string().optional(),
      sort: z.string().optional().describe("Ex: nomeParticipante,asc"),
    },
    auth: true,
    build: (a) => ({
      path: `/api/v3/ingresso/${enc(a.eventoId)}/buscar`,
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
    build: (a) => ({ path: "/api/v3/ingresso/meus_ingressos/todos", query: a }),
  },
  {
    name: "guedder_minhas_compras",
    title: "Minhas compras",
    description:
      "Histórico de compras do usuário autenticado. Retorna até max_results compras da primeira página; padrão 50 e máximo 100. sort padrão: dataCompra,desc.",
    openApiOperationId: "getMinhasCompras",
    inputSchema: {
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de compras retornadas; máximo 100"),
      sort: z.string().optional(),
    },
    auth: true,
    build: (a) => ({ path: "/api/v3/minhas_compras", query: { page: 0, size: a.max_results, sort: a.sort } }),
  },
  {
    name: "guedder_usuario_logado",
    title: "Quem sou eu (auth)",
    description: "Dados do usuário autenticado — confirma identidade/claims do token em uso.",
    openApiOperationId: "getUsuarioLogado",
    inputSchema: {},
    auth: true,
    build: () => ({ path: "/api/v3/usuarios/usuario_logado" }),
  },
];

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "guedder-ops", version: "0.1.0" });
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
  for (const t of TOOLS) {
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
          const { path, query } = t.build(args ?? {});
          const data = await apiGet(path, { query, auth: t.auth });
          return {
            structuredContent: { result: data },
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          return { content: [{ type: "text" as const, text: `Erro: ${e?.message ?? String(e)}` }], isError: true };
        }
      },
    );
  }
  return server;
}

async function handleStreamableHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname;
  if (pathname !== MCP_PATH) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Endpoint MCP não encontrado." }));
    return;
  }

  // Stateless MCP: cada requisição recebe um servidor/transport novo e não há sessão em memória.
  const server = createMcpServer();
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
