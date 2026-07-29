import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("encaminha o bearer token aos endpoints autenticados", async () => {
  const server = http.createServer((request, response) => {
    assert.equal(request.headers.authorization, "Bearer token-de-teste");
    response.writeHead(200, { "content-type": "application/json" });
    if (request.url === "/api/v3/usuarios/usuario_logado") {
      response.end(JSON.stringify({ id: "usuario-teste" }));
      return;
    }
    assert.equal(request.url, "/api/v3/ingresso/evento-teste/buscar?page=0&size=1");
    response.end(JSON.stringify({ content: [{ id: "ingresso-teste" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      GUEDDER_MCP_TRANSPORT: "stdio",
      GUEDDER_API_BASE: `http://127.0.0.1:${address.port}`,
      GUEDDER_BEARER_TOKEN: "token-de-teste",
    },
  });
  const client = new Client({ name: "bearer-test", version: "0" });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: "guedder_usuario_logado", arguments: {} });
    assert.notEqual(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { id: "usuario-teste" });

    const ingressos = await client.callTool({
      name: "guedder_buscar_ingressos_evento",
      arguments: { eventoId: "evento-teste", max_results: 1 },
    });
    assert.notEqual(ingressos.isError, true);
    assert.deepEqual(JSON.parse(ingressos.content[0].text), { content: [{ id: "ingresso-teste" }] });
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
