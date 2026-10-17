/**
 * O resource guedder://prompts-sugeridos: cada pedido aponta para uma tool que o servidor registra
 * de fato. Tool renomeada sem atualizar a lista vira sugestão que leva a agente perdido.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function comServidor(env, fn) {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { ...process.env, GUEDDER_MCP_TRANSPORT: "stdio", GUEDDER_API_BASE: "http://127.0.0.1:9", ...env },
    stderr: "pipe",
  });
  const client = new Client({ name: "prompts-sugeridos-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client);
  } finally {
    await client.close();
  }
}

test("os pedidos sugeridos apontam para tools registradas e começam pelos meus eventos", async () => {
  await comServidor({ GUEDDER_BEARER_TOKEN: "token-de-teste" }, async (client) => {
    const { contents } = await client.readResource({ uri: "guedder://prompts-sugeridos" });
    const texto = contents[0].text;
    const citadas = [...texto.matchAll(/`(guedder_[a-z_]+)`/g)].map((m) => m[1]);
    assert.equal(citadas.length, 5);
    assert.equal(citadas[0], "guedder_meus_eventos");

    const registradas = new Set((await client.listTools()).tools.map((t) => t.name));
    for (const tool of citadas) assert.ok(registradas.has(tool), `${tool} não está registrada`);
    assert.match(texto, /Quais são os meus eventos\?/);
    assert.match(texto, /Quantos ingressos eu vendi hoje\?/);
    assert.match(texto, /PROMO10/);
  });
});

test("no modo comprador (PUBLIC_ONLY) o resource não existe", async () => {
  await comServidor({ GUEDDER_MCP_PUBLIC_ONLY: "1" }, async (client) => {
    const { resources } = await client.listResources();
    assert.ok(!resources.some((r) => r.uri === "guedder://prompts-sugeridos"));
  });
});
