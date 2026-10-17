/**
 * guedder_meus_eventos (GUE-568): lista os eventos que a pessoa gerencia —
 * próprios ou com papel SOCIO/GERENTE/CHECKIN — com id, nome, datas e se já
 * terminou. Primeiro passo de "vendi hoje" / "esgotou lote" / "crie um cupom".
 *
 * Não é a lista de repasses. ADMIN pode ver o acervo da API; o MCP pagina e,
 * por padrão, pede os mais recentes (dataCriacao,desc) com page_size pequeno.
 * Sem filtro local nem `somenteVinculo` (decisão do Danilo).
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function comApiFalsa(roteador, fn) {
  const recebidos = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    recebidos.push({ method: req.method, url, auth: req.headers.authorization });
    const resposta = roteador({ method: req.method, url }) ?? {};
    res.writeHead(resposta.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(resposta.body ?? {}));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      GUEDDER_MCP_TRANSPORT: "stdio",
      GUEDDER_API_BASE: `http://127.0.0.1:${port}`,
      GUEDDER_BEARER_TOKEN: "token-de-teste",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "meus-eventos-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client, recebidos);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

async function chamar(client, args = {}) {
  try {
    return await client.callTool({ name: "guedder_meus_eventos", arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] };
  }
}

test("lista id, nome, datas e terminou; chama gestao com sort recente", async () => {
  const passado = "2020-01-01T22:00:00Z";
  const futuro = "2099-12-31T22:00:00Z";
  await comApiFalsa(
    () => ({
      body: {
        content: [
          { id: "e-proprio", nome: "Meu show", dataInicio: "2020-01-01T20:00:00Z", dataFim: passado, vendedorId: "u-1" },
          { id: "e-gerente", nome: "De outra pessoa", dataInicio: futuro, dataFim: futuro, vendedorId: "u-outro" },
          { id: "e-sem-fim", nome: "Sem data fim", dataInicio: futuro, dataFim: null, vendedorId: "u-1" },
        ],
        page: { size: 20, number: 0, totalElements: 3, totalPages: 1 },
      },
    }),
    async (client, recebidos) => {
      const r = await chamar(client, { max_results: 20 });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      assert.deepEqual(r.structuredContent.result.eventos, [
        { id: "e-proprio", nome: "Meu show", dataInicio: "2020-01-01T20:00:00Z", dataFim: passado, terminou: true },
        { id: "e-gerente", nome: "De outra pessoa", dataInicio: futuro, dataFim: futuro, terminou: false },
        { id: "e-sem-fim", nome: "Sem data fim", dataInicio: futuro, dataFim: null, terminou: false },
      ]);
      assert.equal(r.structuredContent.result.page, 1);
      assert.equal(r.structuredContent.result.totalElements, 3);
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0].method, "GET");
      assert.equal(recebidos[0].url.pathname, "/api/v3/eventos/gestao");
      assert.equal(recebidos[0].url.searchParams.get("page"), "1");
      assert.equal(recebidos[0].url.searchParams.get("page_size"), "20");
      assert.equal(recebidos[0].url.searchParams.get("sort"), "dataCriacao,desc");
      assert.equal(recebidos[0].auth, "Bearer token-de-teste");
      assert.ok(
        !recebidos.some((p) => p.url.pathname.includes("repasses")),
        "não pode cair na lista administrativa de repasses",
      );
    },
  );
});

test("padrão: página 1, 10 itens, sort recente; filtro e página 2 passam na query", async () => {
  await comApiFalsa(
    () => ({ body: { content: [], page: { size: 10, number: 1, totalElements: 25, totalPages: 3 } } }),
    async (client, recebidos) => {
      const rPadrao = await chamar(client, {});
      assert.notEqual(rPadrao.isError, true, rPadrao.content?.[0]?.text);
      assert.equal(recebidos[0].url.searchParams.get("page"), "1");
      assert.equal(recebidos[0].url.searchParams.get("page_size"), "10");
      assert.equal(recebidos[0].url.searchParams.get("sort"), "dataCriacao,desc");

      const r = await chamar(client, { filtro: "rock", page: 2, max_results: 5 });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      assert.deepEqual(r.structuredContent.result.eventos, []);
      assert.equal(r.structuredContent.result.page, 2);
      assert.equal(r.structuredContent.result.totalPages, 3);
      assert.equal(recebidos[1].url.searchParams.get("filtro"), "rock");
      assert.equal(recebidos[1].url.searchParams.get("page"), "2");
      assert.equal(recebidos[1].url.searchParams.get("page_size"), "5");
      assert.equal(recebidos[1].url.searchParams.get("sort"), "dataCriacao,desc");
    },
  );
});

test("no modo comprador a tool não existe", async () => {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      GUEDDER_MCP_TRANSPORT: "stdio",
      GUEDDER_API_BASE: "http://127.0.0.1:9",
      GUEDDER_MCP_PUBLIC_ONLY: "1",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "meus-eventos-public", version: "0" });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(!names.includes("guedder_meus_eventos"));
  } finally {
    await client.close();
  }
});

/**
 * ADMIN vê o acervo via ramo isAdmin da API — aceito (Danilo). O MCP não
 * filtra vínculo; pagina e ordena por mais recentes.
 */
test("ADMIN (simulado pela API): eventos sem vínculo passam; pagina e ordena por recentes", async () => {
  const futuro = "2099-12-31T22:00:00Z";
  await comApiFalsa(
    () => ({
      body: {
        content: [
          { id: "e-plataforma-1", nome: "Show alheio A", dataInicio: futuro, dataFim: futuro, vendedorId: "outro-1" },
          { id: "e-plataforma-2", nome: "Show alheio B", dataInicio: futuro, dataFim: futuro, vendedorId: "outro-2" },
        ],
        page: { size: 2, number: 0, totalElements: 1688, totalPages: 844 },
      },
    }),
    async (client, recebidos) => {
      const schema = await client.readResource({ uri: "guedder://openapi/v3/tools/guedder_meus_eventos" });
      const spec = JSON.parse(schema.contents[0].text);
      const desc = spec.paths["/api/v3/eventos/gestao"].get.description;
      assert.match(desc, /acervo inteiro/, "o contrato ainda documenta o ramo ADMIN");

      const r = await chamar(client, { max_results: 2 });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      const ids = r.structuredContent.result.eventos.map((e) => e.id);
      assert.deepEqual(ids, ["e-plataforma-1", "e-plataforma-2"], "MCP não filtra vínculo no cliente");
      assert.equal(r.structuredContent.result.totalElements, 1688);
      assert.equal(r.structuredContent.result.totalPages, 844);
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0].url.pathname, "/api/v3/eventos/gestao");
      assert.equal(recebidos[0].url.searchParams.get("page"), "1");
      assert.equal(recebidos[0].url.searchParams.get("page_size"), "2");
      assert.equal(recebidos[0].url.searchParams.get("sort"), "dataCriacao,desc");
      assert.equal(recebidos[0].url.searchParams.get("somenteVinculo"), null);
      assert.ok(!recebidos.some((p) => /repasses|administrativo/.test(p.url.pathname)));
    },
  );
});
