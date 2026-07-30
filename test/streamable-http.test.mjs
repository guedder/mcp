import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import test from "node:test";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

test("expõe ferramentas via Streamable HTTP stateless em /mcp", async () => {
  const port = await freePort();
  const process = spawn("node", ["dist/index.js"], {
    env: { ...globalThis.process.env, GUEDDER_MCP_PORT: String(port) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      process.stderr.on("data", (chunk) => {
        if (chunk.toString().includes("Streamable HTTP no ar")) resolve();
      });
      process.once("error", reject);
      process.once("exit", (code) => reject(new Error(`MCP encerrou antes de iniciar (${code}).`)));
    });

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    const json = body.match(/^data: (.+)$/m)?.[1] ?? body;
    const payload = JSON.parse(json);
    assert.equal(payload.result.tools.length, 17);
    assert.equal(payload.result.tools[0].annotations.readOnlyHint, true);
    assert.equal(payload.result.tools[0].annotations.destructiveHint, false);
    assert.equal(payload.result.tools[0].annotations.idempotentHint, true);
    for (const name of [
      "guedder_listar_eventos",
      "guedder_buscar_ingressos_evento",
      "guedder_minhas_compras",
      "guedder_buscar_compras_evento",
      "guedder_auditar_vendas_evento",
      "guedder_listar_integracoes_pagamento",
      "guedder_listar_resumo_repasses_eventos",
    ]) {
      const tool = payload.result.tools.find((item) => item.name === name);
      assert.ok(tool, `missing ${name}`);
      assert.ok(tool.inputSchema.properties.max_results, `${name} must expose max_results`);
      assert.equal(tool.inputSchema.properties.page, undefined, `${name} must not expose page`);
      assert.equal(tool.inputSchema.properties.size, undefined, `${name} must not expose size`);
    }
  } finally {
    process.kill();
    await new Promise((resolve) => process.once("exit", resolve));
  }
});
