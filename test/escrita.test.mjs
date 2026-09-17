/**
 * A primeira tool de ESCRITA do MCP.
 *
 * Até aqui o servidor era estruturalmente só-leitura (só existia `apiGet`), e
 * isso era propriedade de segurança, não convenção — ADR 0001 §9.4 do repo auth.
 * Abrir escrita troca aquela garantia por outra, e é esta que os testes abaixo
 * seguram: nada é escrito sem a pessoa ter confirmado AQUELA operação.
 *
 * Duas fases porque o agente é um LLM: a primeira devolve o que vai acontecer,
 * em português, com um código; a segunda só executa com o código na mão. O
 * código é imprevisível de propósito — se fosse fixo, o modelo poderia pular a
 * fase de resumo e a pessoa nunca veria o que estava sendo cancelado.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PEDIDO = "5daig7vi11";

async function comApiFalsa(fn) {
  const recebidos = [];
  const server = http.createServer((req, res) => {
    recebidos.push({ method: req.method, url: req.url });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/api/v3/pedidos/")) {
      res.end(JSON.stringify({ status: "CANCELAMENTO_SOLICITADO", pedidoId: PEDIDO }));
      return;
    }
    res.end(JSON.stringify({ content: [] }));
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
  const client = new Client({ name: "escrita-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client, recebidos);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

test("a tool de cancelamento se anuncia como destrutiva", async () => {
  await comApiFalsa(async (client) => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === "guedder_cancelar_pedido");

    assert.ok(tool, "guedder_cancelar_pedido tem que existir");
    // O cliente MCP usa estas dicas para decidir se pede aprovação humana. Uma
    // tool que devolve dinheiro anunciada como readOnly é mentira com efeito
    // colateral: o cliente deixaria passar sem perguntar.
    assert.equal(tool.annotations.readOnlyHint, false);
    assert.equal(tool.annotations.destructiveHint, true);
    assert.equal(tool.annotations.idempotentHint, false);
  });
});

test("sem confirmação, descreve o efeito e não toca na API", async () => {
  await comApiFalsa(async (client, recebidos) => {
    const r = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: PEDIDO },
    });

    assert.notEqual(r.isError, true);
    const texto = r.content[0].text;
    assert.match(texto, /confirmac|confirmaç/i, "tem que devolver um código de confirmação");
    assert.match(texto, new RegExp(PEDIDO), "a pessoa precisa ver QUAL pedido");

    assert.deepEqual(
      recebidos.filter((x) => x.method !== "GET"),
      [],
      "a fase de resumo não pode escrever nada",
    );
  });
});

test("confirmação errada não cancela", async () => {
  await comApiFalsa(async (client, recebidos) => {
    const r = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: PEDIDO, confirmacao: "eu-quero-sim" },
    });

    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /confirmac|confirmaç/i);
    assert.deepEqual(recebidos.filter((x) => x.method === "POST"), []);
  });
});

test("com a confirmação da própria fase de resumo, cancela", async () => {
  await comApiFalsa(async (client, recebidos) => {
    const resumo = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: PEDIDO },
    });
    const codigo = resumo.content[0].text.match(/[A-Z0-9]{8,}/)?.[0];
    assert.ok(codigo, `não achei o código no resumo: ${resumo.content[0].text}`);

    const r = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: PEDIDO, confirmacao: codigo },
    });

    assert.notEqual(r.isError, true);
    const escritas = recebidos.filter((x) => x.method === "POST");
    assert.equal(escritas.length, 1, "exatamente um POST");
    assert.equal(escritas[0].url, `/api/v3/pedidos/${PEDIDO}/cancelamento`);
  });
});

// O código vale para UM pedido. Sem isso, a pessoa confirma o cancelamento de um
// ingresso de cinema e o agente reaproveita o código no pedido do show.
test("confirmação de um pedido não serve para outro", async () => {
  await comApiFalsa(async (client, recebidos) => {
    const resumo = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: PEDIDO },
    });
    const codigo = resumo.content[0].text.match(/[A-Z0-9]{8,}/)?.[0];
    assert.ok(codigo, "sem código no resumo o resto do teste não prova nada");

    const r = await client.callTool({
      name: "guedder_cancelar_pedido",
      arguments: { pedidoId: "outro-pedido-999", confirmacao: codigo },
    });

    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /confirmac|confirmaç/i);
    assert.deepEqual(recebidos.filter((x) => x.method === "POST"), []);
  });
});
