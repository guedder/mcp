#!/usr/bin/env node
/**
 * @guedder/mcp — MCP over Guedder API v3 (operational tasks).
 *
 * Auth: a caller-provided Bearer token (`GUEDDER_BEARER_TOKEN`) is forwarded only
 * to authenticated endpoints. OAuth2 can later replace tokenProvider() without
 * changing the tools or the HTTP client.
 *
 * Wrappers finos sobre a v3: leitura via `apiGet`, e uma única escrita
 * (`guedder_cancelar_pedido`) via `apiPost`, atrás de escopo e confirmação em
 * duas fases. Não existe helper genérico de verbo, e isso é deliberado.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
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

/**
 * Escrita na API, em nome do usuário.
 *
 * Deliberadamente NÃO é `apiRequest(metodo, ...)`: um helper genérico de verbo
 * transformaria "este servidor escreve em dois lugares" em "este servidor pode
 * escrever em qualquer lugar", e a diferença só apareceria numa auditoria.
 * Enquanto houver uma escrita só, existe um helper só — e somar a segunda é uma
 * decisão que alguém toma de olho aberto, não um parâmetro que já estava lá.
 */
async function apiPost(path: string, opts: { caller?: Caller } = {}): Promise<unknown> {
  const res = await fetch(new URL(BASE + path), {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${await tokenProvider(opts.caller)}`,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`POST ${path} -> ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 500)}` : ""}`);
  }
  const ct = res.headers.get("content-type") ?? "";
  return ct.includes("application/json") ? res.json() : res.text();
}

/**
 * Segredo de processo para os códigos de confirmação. Aleatório por instância, e
 * isso basta: o código vive dentro de uma conversa, e a conversa não sobrevive a
 * um restart de qualquer jeito.
 *
 * ponytail: segredo por processo, não por cluster. Com mais de uma réplica a
 * confirmação pode cair noutra e a pessoa confirma de novo — atrito aceitável
 * hoje. Se virar incômodo, o upgrade é uma chave em SSM lida no boot, não uma
 * sessão em banco.
 */
const SEGREDO_DE_CONFIRMACAO = randomBytes(32);

/**
 * Código que amarra a confirmação a UM pedido e a UMA pessoa.
 *
 * Imprevisível de propósito. Se fosse fixo (um "CONFIRMAR" da vida), o modelo
 * poderia mandá-lo de primeira e a fase de resumo nunca chegaria à pessoa — que
 * é justamente a parte que faz o consent valer alguma coisa numa operação que
 * devolve dinheiro.
 */
function codigoDeConfirmacao(pedidoId: string, caller?: Caller): string {
  return createHmac("sha256", SEGREDO_DE_CONFIRMACAO)
    .update(`${pedidoId}\n${caller?.usuarioId ?? caller?.email ?? "local"}`)
    .digest("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 10);
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

const INSTRUCTIONS = `MCP sobre a API Guedder v3 (plataforma de venda de ingressos). Quase tudo é leitura; há UMA operação que muda estado, descrita no fim.

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

Escrita — guedder_cancelar_pedido:
É a única tool que muda estado. Cancela um pedido da pessoa logada e devolve o valor pelo mesmo meio de pagamento; não tem desfazer.
1. Chame SEM \`confirmacao\`. Nada é cancelado, e você recebe um resumo do efeito mais um código.
2. Mostre esse resumo à pessoa e espere ela confirmar, com todas as letras.
3. Só então chame de novo, passando aquele código em \`confirmacao\`.
Nunca invente o código nem pule a etapa 2: o código existe justamente para garantir que a pessoa viu o que ia acontecer. Um código vale para um pedido só.
A tool exige que a pessoa tenha concedido o escopo \`pedido:cancelar\` ao conectar. Se não concedeu, o erro diz isso, e o caminho é ela reconectar autorizando — não há como contornar por aqui.`;

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
          if (AUTH && t.escopo) {
            if (!caller) throw new AuthError("Token ausente: esta tool age em nome de alguém.");
            exigirEscopo(caller, t.escopo);
          }
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
        return {
          structuredContent: { result: data },
          content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Erro: ${e?.message ?? String(e)}` }], isError: true };
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
        eventoId: z.string().describe("UUID ou código alfanumérico do evento"),
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
        return {
          structuredContent: { result: resultado },
          content: [{ type: "text" as const, text: JSON.stringify(resultado, null, 2) }],
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Erro: ${e?.message ?? String(e)}` }], isError: true };
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
          if (AUTH) {
            if (!caller) throw new AuthError("Token ausente: esta tool age em nome de alguém.");
            exigirEscopo(caller, "conta:read");
          }
          const identificador = String(args?.identificador ?? "");
          const pagina: any = await apiGet("/api/v3/ingressos", { query: { size: 100, page: 0 }, auth: true, caller });
          const doPedido = (pagina?.content ?? []).filter(
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
          return {
            content: [{ type: "text" as const, text: JSON.stringify(resultado, null, 2) }],
          };
        } catch (e: any) {
          const motivo = e instanceof EscopoError ? `${e.message} (escopo \`conta:read\`)` : (e?.message ?? String(e));
          return { content: [{ type: "text" as const, text: `Erro: ${motivo}` }], isError: true };
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
          pedidoId: z.string().describe("Id do pedido a cancelar, como aparece em guedder_minhas_compras"),
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
        try {
          // `caller?` e não `caller!`: com Cognito ligado e transporte stdio o
          // servidor sobe sem caller, e o `!` derefava undefined, devolvendo um
          // TypeError no lugar do erro de autenticação. Fechava do lado certo,
          // mas com a mensagem errada.
          if (AUTH) {
            if (!caller) throw new AuthError("Token ausente: esta tool age em nome de alguém.");
            exigirEscopo(caller, "pedido:cancelar");
          }

          const esperado = codigoDeConfirmacao(pedidoId, caller);
          if (args?.confirmacao !== esperado) {
            const texto =
              args?.confirmacao
                ? `Confirmação inválida para o pedido ${pedidoId}. ` +
                  `Um código vale para um pedido só, e não se reaproveita. ` +
                  `Chame esta tool sem \`confirmacao\` para obter o código deste pedido.`
                : `Vou cancelar o pedido ${pedidoId}. O valor volta pelo mesmo meio de pagamento, ` +
                  `e a operação não tem desfazer: reservar de novo depende de ainda haver lote disponível.\n\n` +
                  `Mostre isto à pessoa e, se ela confirmar, chame de novo com confirmacao="${esperado}".`;
            return {
              content: [{ type: "text" as const, text: texto }],
              ...(args?.confirmacao ? { isError: true as const } : {}),
            };
          }

          const data = await apiPost(`/api/v3/pedidos/${enc(pedidoId)}/cancelamento`, { caller });
          return {
            structuredContent: { result: data },
            content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
          };
        } catch (e: any) {
          const motivo =
            e instanceof EscopoError
              ? `${e.message} (escopo \`pedido:cancelar\`)`
              : (e?.message ?? String(e));
          return { content: [{ type: "text" as const, text: `Erro: ${motivo}` }], isError: true };
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
 * que pula a tela por descuido. Fechar o caso do cliente deliberado é o mesmo
 * passo já registrado no `telaDeConsent`: client confidencial e sessão emitida
 * aqui.
 */
function provaDeConsent(pedido: URLSearchParams, deslocamento = 0): string {
  const bloco = Math.floor(Date.now() / 600_000) - deslocamento;
  return createHmac("sha256", SEGREDO_DE_CONFIRMACAO)
    .update(
      [
        pedido.get("client_id") ?? "",
        pedido.get("redirect_uri") ?? "",
        pedido.get("state") ?? "",
        pedido.get("code_challenge") ?? "",
        bloco,
      ].join("\n"),
    )
    .digest("base64url");
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
 * permite.
 *
 * Fechar isso de verdade exige tornar o app client confidencial, com o secret
 * só neste servidor, e o MCP passar a emitir a sessão (o molde é o
 * `CheckinSessionTokenService`). É o passo seguinte quando aparecer um cliente
 * de terceiro de fato não confiável, e não vale o custo enquanto o cliente é o
 * plugin da própria Guedder.
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
