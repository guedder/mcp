#!/usr/bin/env node
/**
 * @guedder/mcp — readonly MCP over Guedder API v3 (operational tasks).
 *
 * Auth: a caller-provided Bearer token (`GUEDDER_BEARER_TOKEN`) is forwarded only
 * to authenticated endpoints. OAuth2 can later replace tokenProvider() without
 * changing the tools or the HTTP client.
 *
 * 17 thin readonly wrappers, one generic GET client and a bearer token provider.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import {
  AuthError,
  authConfigFromEnv,
  createVerifier,
  protectedResourceMetadata,
  authorizationServerMetadata,
  cognitoEndpoints,
  wwwAuthenticate,
  type Caller,
} from "./auth.js";
import { auditoriaConfigFromEnv, criarAuditoria } from "./auditoria.js";

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

async function apiGet(
  path: string,
  opts: { query?: Record<string, unknown>; auth?: boolean; caller?: Caller } = {},
): Promise<unknown> {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const run = async () => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (opts.auth) headers.authorization = `Bearer ${await tokenProvider(opts.caller)}`;
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
      "Lista até max_results eventos públicos ativos. A consulta sempre usa a primeira página; max_results tem padrão 50 e máximo 100. Filtros opcionais: filtro (texto livre), nomeCidade, nomeEstado (sigla UF), categoriaEventoEnum.",
    openApiOperationId: "listarEventos",
    inputSchema: {
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de eventos retornados; máximo 100"),
      filtro: z.string().optional().describe("Busca por texto no nome do evento"),
      nomeCidade: z.string().optional(),
      nomeEstado: z.string().optional().describe("Sigla UF, ex: SP"),
      categoriaEventoEnum: z.string().optional(),
    },
    auth: false,
    // /api/v3/eventos e paginado a partir de 1 (page=0 -> 400). Os demais endpoints seguem em 0.
    build: (a) => ({
      path: "/api/v3/eventos",
      query: {
        page: 1,
        page_size: a.max_results,
        filtro: a.filtro,
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
    build: (a) => ({ path: `/api/v3/eventos/${enc(a.id)}` }),
  },
  {
    name: "guedder_listar_categorias_evento",
    title: "Listar categorias de evento",
    description: "Lista todas as categorias de evento disponíveis.",
    openApiOperationId: "listarCategoriasEvento",
    inputSchema: {},
    auth: false,
    build: () => ({ path: "/api/v3/categorias-evento" }),
  },
  {
    name: "guedder_listar_atracoes_evento",
    title: "Line-up do evento",
    description: "Lista as atrações (line-up) de um evento.",
    openApiOperationId: "listarAtracoesPorEvento",
    inputSchema: { eventoId: z.string() },
    auth: false,
    build: (a) => ({ path: `/api/v3/eventos/${enc(a.eventoId)}/atracoes` }),
  },
  {
    name: "guedder_listar_lotes_evento",
    title: "Lotes do evento",
    description: "Lista os lotes disponíveis para compra num evento.",
    openApiOperationId: "listarLotesPublicos",
    inputSchema: { eventoId: z.string() },
    auth: false,
    build: (a) => ({ path: `/api/v3/eventos/${enc(a.eventoId)}/lotes` }),
  },
  {
    name: "guedder_get_parametros_venda",
    title: "Parâmetros de venda do evento",
    description: "Formas de pagamento e regras de venda de um evento. Pode retornar 404 se não configurado.",
    openApiOperationId: "getParametrosVenda",
    inputSchema: { eventoId: z.string() },
    auth: false,
    build: (a) => ({ path: `/api/v3/eventos/${enc(a.eventoId)}/parametros-venda` }),
  },
  {
    name: "guedder_eventos_destaque",
    title: "Eventos em destaque",
    description: "Lista os eventos em destaque na home da Guedder (seções e listas principais). Sem parâmetros.",
    openApiOperationId: "getEventosDestaque",
    inputSchema: {},
    auth: false,
    build: () => ({ path: "/api/v3/home/destaques" }),
  },
  {
    name: "guedder_get_lote",
    title: "Lote por código/ID",
    description: "Retorna um lote pelo código ou ID do evento e do lote (aceita UUID ou código). Requer auth.",
    openApiOperationId: "getLotePorCodigoOuId",
    inputSchema: { codigoOrEventoId: z.string(), codigoOrLoteId: z.string() },
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
      eventoId: z.string(),
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
    build: (a) => ({ path: "/api/v3/ingressos", query: { cicloDeVida: a.status, eventoId: a.eventoId } }),
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
    build: (a) => ({ path: "/api/v3/compras", query: { page: 0, size: a.max_results, sort: a.sort } }),
  },
  {
    name: "guedder_buscar_compras_evento",
    title: "Buscar compras de um evento",
    description:
      "Extrato de compras de um evento para gestão de vendas. Filtre por texto e status; retorna até max_results da primeira página. Requer permissão sobre o evento.",
    openApiOperationId: "findExtratosByEvento",
    inputSchema: {
      eventoId: z.string().describe("UUID do evento"),
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
      "Retorna as vendas recentes de um evento para auditoria operacional. Não é uma trilha de alterações do evento; requer permissão de leitura de vendas.",
    openApiOperationId: "getContagemIngressosVendidos",
    inputSchema: {
      eventoId: z.string().describe("UUID do evento"),
      max_results: z.number().int().min(1).max(100).default(50).describe("Máximo de vendas retornadas; máximo 100"),
    },
    auth: true,
    build: (a) => ({ path: `/api/v1/metrica/${enc(a.eventoId)}/ultimas-vendas`, query: { page: 0, size: a.max_results } }),
  },
  {
    name: "guedder_resumo_vendas_evento",
    title: "Resumo de vendas do evento",
    description: "Agregados de vendas de um evento para gestão. Requer permissão de leitura de vendas.",
    openApiOperationId: "getResumoVendas",
    inputSchema: { eventoId: z.string().describe("UUID do evento") },
    auth: true,
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

function createMcpServer(caller?: Caller): McpServer {
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
          const { path, query } = t.build(args ?? {});
          const data = await apiGet(path, { query, auth: t.auth, caller });
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
            return {
              structuredContent: { result: data },
              content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
            };
          }

          const linhas = await auditoria.linhasDoTrace(traceId, args?.max_linhas);
          const data = { encontrado: true, trace_id: traceId, linhas };
          return {
            structuredContent: { result: data },
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          return {
            content: [{ type: "text" as const, text: `Erro: ${e?.message ?? String(e)}` }],
            isError: true,
          };
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
      const { authorize } = await cognitoEndpoints(AUTH);
      const destino = new URL(authorize);
      // Repassa a query INTEIRA sem interpretar: PKCE, state e scope são do
      // cliente e do Cognito. Reconstruir só criaria oportunidade de perder um
      // parâmetro que ainda não existe.
      new URL(req.url ?? "/", base).searchParams.forEach((v, k) => destino.searchParams.set(k, v));
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

function detalheOauth(pathname: string, req: IncomingMessage): string {
  if (!["/authorize", "/token", "/register"].includes(pathname)) return "";
  const q = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).searchParams;
  const partes: string[] = [];
  q.forEach((v, k) => partes.push(`${k}=${REDIGIR.has(k) ? "[redigido]" : v}`));
  return partes.length ? ` ?${partes.join("&")}` : "";
}
