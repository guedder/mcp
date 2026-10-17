/**
 * guedder_meus_eventos (GUE-568): lista os eventos que a pessoa gerencia —
 * próprios ou com papel SOCIO/GERENTE/CHECKIN — com id, nome, datas e se já
 * terminou. Primeiro passo de "vendi hoje" / "esgotou lote" / "crie um cupom".
 *
 * Não é a lista de repasses (ADMIN). Sem bypass de admin neste servidor: o
 * mesmo GET serve para todo caller autenticado.
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

test("lista id, nome, datas e terminou; chama gestao (não repasses)", async () => {
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
        page: { size: 50, number: 0, totalElements: 3, totalPages: 1 },
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
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0].method, "GET");
      assert.equal(recebidos[0].url.pathname, "/api/v3/eventos/gestao");
      assert.equal(recebidos[0].url.searchParams.get("page"), "1");
      assert.equal(recebidos[0].url.searchParams.get("page_size"), "20");
      assert.equal(recebidos[0].auth, "Bearer token-de-teste");
      assert.ok(
        !recebidos.some((p) => p.url.pathname.includes("repasses")),
        "não pode cair na lista administrativa de repasses",
      );
    },
  );
});

test("filtro textual vai na query; lista vazia é ok", async () => {
  await comApiFalsa(
    () => ({ body: { content: [], page: { size: 50, number: 0, totalElements: 0, totalPages: 0 } } }),
    async (client, recebidos) => {
      const r = await chamar(client, { filtro: "rock" });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      assert.deepEqual(r.structuredContent.result.eventos, []);
      assert.equal(recebidos[0].url.searchParams.get("filtro"), "rock");
      assert.equal(recebidos[0].url.searchParams.get("page_size"), "50");
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
