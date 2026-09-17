/**
 * Tools por TAREFA do comprador, substituindo o desenho de 1 tool por endpoint.
 *
 * guedder_descobrir_eventos  — repõe guedder_listar_eventos + guedder_eventos_destaque
 * guedder_detalhes_evento    — repõe get_evento + listar_atracoes_evento +
 *                              listar_lotes_evento + get_parametros_venda
 * guedder_status_da_compra   — não existia: /api/v3/compras não tem id nenhum
 *                              (ResumoTicketsVO não expõe idPedido/compraId), então
 *                              "status desta compra" só é respondível compondo sobre
 *                              /api/v3/ingressos, que tem `idPedido` por item.
 *
 * guedder_meus_ingressos e guedder_listar_categorias_evento continuam como estavam:
 * já eram tarefas de um endpoint só, não wrappers que precisassem de composição.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function comApiFalsa(roteador, fn) {
  const recebidos = [];
  const server = http.createServer((req, res) => {
    recebidos.push({ method: req.method, url: req.url });
    const resposta = roteador(req.url ?? "");
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
  });
  const client = new Client({ name: "comprador-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client, recebidos);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

// ── guedder_descobrir_eventos ───────────────────────────────────────────────

test("sem filtro nenhum, descobrir_eventos usa os destaques da home", async () => {
  await comApiFalsa(
    (url) => ({ body: { origem: url } }),
    async (client, recebidos) => {
      const r = await client.callTool({ name: "guedder_descobrir_eventos", arguments: {} });
      assert.notEqual(r.isError, true);
      assert.equal(recebidos.length, 1);
      assert.match(recebidos[0].url, /^\/api\/v3\/home\/destaques/);
    },
  );
});

test("com cidade, descobrir_eventos busca no catálogo, não nos destaques", async () => {
  await comApiFalsa(
    (url) => ({ body: { origem: url } }),
    async (client, recebidos) => {
      const r = await client.callTool({
        name: "guedder_descobrir_eventos",
        arguments: { cidade: "Maringá" },
      });
      assert.notEqual(r.isError, true);
      assert.equal(recebidos.length, 1);
      const u = new URL(recebidos[0].url, "http://localhost");
      assert.equal(u.pathname, "/api/v3/eventos");
      assert.equal(u.searchParams.get("nomeCidade"), "Maringá");
      // page=1: a API pagina a partir de 1, não de 0 — mesma pegadinha de antes.
      assert.equal(u.searchParams.get("page"), "1");
    },
  );
});

test("categoria também conta como filtro, mesmo sem cidade", async () => {
  await comApiFalsa(
    (url) => ({ body: {} }),
    async (client, recebidos) => {
      await client.callTool({ name: "guedder_descobrir_eventos", arguments: { categoria: "show" } });
      assert.match(recebidos[0].url, /^\/api\/v3\/eventos\?/);
    },
  );
});

// ── guedder_detalhes_evento ─────────────────────────────────────────────────

test("sem incluir, detalhes_evento só busca o básico", async () => {
  await comApiFalsa(
    (url) => ({ body: { url } }),
    async (client, recebidos) => {
      const r = await client.callTool({
        name: "guedder_detalhes_evento",
        arguments: { eventoId: "evt-1" },
      });
      assert.notEqual(r.isError, true);
      assert.equal(recebidos.length, 1, "não deveria buscar atrações/lotes/venda sem pedir");
      assert.equal(recebidos[0].url, "/api/v3/eventos/evt-1");
    },
  );
});

test("com incluir, detalhes_evento busca e agrega cada peça pedida", async () => {
  await comApiFalsa(
    (url) => {
      if (url.endsWith("/atracoes")) return { body: [{ nome: "Banda X" }] };
      if (url.endsWith("/lotes")) return { body: [{ nome: "1º lote" }] };
      if (url.endsWith("/parametros-venda")) return { body: { parcelamento: 3 } };
      return { body: { nome: "Evento Teste" } };
    },
    async (client, recebidos) => {
      const r = await client.callTool({
        name: "guedder_detalhes_evento",
        arguments: { eventoId: "evt-1", incluir: ["atracoes", "lotes", "venda"] },
      });
      assert.notEqual(r.isError, true);
      assert.equal(recebidos.length, 4);
      const resultado = JSON.parse(r.content[0].text);
      assert.equal(resultado.evento.nome, "Evento Teste");
      assert.deepEqual(resultado.atracoes, [{ nome: "Banda X" }]);
      assert.deepEqual(resultado.lotes, [{ nome: "1º lote" }]);
      assert.deepEqual(resultado.parametrosVenda, { parcelamento: 3 });
    },
  );
});

// A regra que já existia (404 em parametros-venda = "ainda não divulgado") não pode
// virar falha da tool inteira só porque agora ela é uma peça de uma composição.
test("404 em parametros-venda não derruba o resto de detalhes_evento", async () => {
  await comApiFalsa(
    (url) => {
      if (url.endsWith("/parametros-venda")) return { status: 404, body: {} };
      if (url.endsWith("/lotes")) return { body: [{ nome: "1º lote" }] };
      return { body: { nome: "Evento Teste" } };
    },
    async (client) => {
      const r = await client.callTool({
        name: "guedder_detalhes_evento",
        arguments: { eventoId: "evt-1", incluir: ["lotes", "venda"] },
      });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      const resultado = JSON.parse(r.content[0].text);
      assert.equal(resultado.parametrosVenda, null);
      assert.deepEqual(resultado.lotes, [{ nome: "1º lote" }]);
    },
  );
});

// 404 no evento em si é outra coisa: o evento não existe, e isso propaga como erro.
test("404 no evento em si continua sendo erro", async () => {
  await comApiFalsa(
    () => ({ status: 404, body: {} }),
    async (client) => {
      const r = await client.callTool({
        name: "guedder_detalhes_evento",
        arguments: { eventoId: "nao-existe" },
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /404/, "tem que ser o 404 real, não a tool inexistente");
    },
  );
});

// ── guedder_status_da_compra ────────────────────────────────────────────────

const INGRESSOS_DA_CONTA = {
  content: [
    { idPedido: "ped-1", nomeEvento: "Show A", status: "PAGO", ativo: true, codigo: "cod1" },
    { idPedido: "ped-1", nomeEvento: "Show A", status: "PAGO", ativo: true, codigo: "cod2" },
    { idPedido: "ped-2", nomeEvento: "Show B", status: "PAGO", ativo: false, codigo: "cod3" },
  ],
  page: { totalElements: 3 },
};

test("status_da_compra agrega os ingressos do mesmo pedido", async () => {
  await comApiFalsa(
    () => ({ body: INGRESSOS_DA_CONTA }),
    async (client, recebidos) => {
      const r = await client.callTool({
        name: "guedder_status_da_compra",
        arguments: { identificador: "ped-1" },
      });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      assert.equal(recebidos.length, 1);
      const resultado = JSON.parse(r.content[0].text);
      assert.equal(resultado.nomeEvento, "Show A");
      assert.equal(resultado.quantidade, 2);
      assert.deepEqual(
        resultado.ingressos.map((i) => i.codigo).sort(),
        ["cod1", "cod2"],
      );
    },
  );
});

test("identificador que não bate com nenhum pedido dá erro com dica", async () => {
  await comApiFalsa(
    () => ({ body: INGRESSOS_DA_CONTA }),
    async (client) => {
      const r = await client.callTool({
        name: "guedder_status_da_compra",
        arguments: { identificador: "ped-inexistente" },
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /guedder_meus_ingressos/, "tem que apontar o próximo passo");
    },
  );
});

// O gap achado ao construir esta tool: nenhuma tool de leitura checava o escopo
// `conta:read`, embora ele exista no Cognito e apareça no consent. Corrigido aqui e
// em guedder_meus_ingressos/guedder_minhas_compras, que expõem o mesmo tipo de dado.
test("status_da_compra exige o escopo conta:read quando o Cognito está ligado", async () => {
  const recebidos = [];
  const server = http.createServer((req, res) => {
    recebidos.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(INGRESSOS_DA_CONTA));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port: apiPort } = server.address();

  // Cognito de mentira, só para o servidor conseguir montar a metadata no boot.
  const cognito = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        issuer: "http://127.0.0.1",
        authorization_endpoint: "http://exemplo/oauth2/authorize",
        token_endpoint: "http://exemplo/oauth2/token",
        jwks_uri: "http://127.0.0.1/jwks.json",
      }),
    );
  });
  await new Promise((r) => cognito.listen(0, "127.0.0.1", r));
  const { port: cognitoPort } = cognito.address();

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      GUEDDER_MCP_TRANSPORT: "stdio",
      GUEDDER_API_BASE: `http://127.0.0.1:${apiPort}`,
      GUEDDER_COGNITO_ISSUER: `http://127.0.0.1:${cognitoPort}`,
      GUEDDER_MCP_CLIENT_ID: "cliente",
    },
  });
  const client = new Client({ name: "escopo-test", version: "0" });
  try {
    await client.connect(transport);
    // Sem token de usuário nenhum (stdio + Cognito ligado = sem caller), a tool
    // tem que recusar antes de qualquer chamada à API — nunca "funcionar mesmo
    // assim" por acidente de fallback.
    const r = await client.callTool({ name: "guedder_status_da_compra", arguments: { identificador: "ped-1" } });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /escopo|token/i, "tem que ser recusa de auth, não tool inexistente");
    assert.deepEqual(recebidos, []);
  } finally {
    await client.close();
    await new Promise((r) => server.close(r));
    await new Promise((r) => cognito.close(r));
  }
});
