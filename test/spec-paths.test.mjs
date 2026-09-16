import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Preenche TODOS os parametros (obrigatorios e opcionais) para que cada query param
// declarado pela tool chegue ao servidor fake e seja conferido com a spec.
function sampleArgs(schema) {
  const out = {};
  for (const [name, prop] of Object.entries(schema.properties ?? {})) {
    if (prop.type === "integer" || prop.type === "number") out[name] = 1;
    else if (prop.type === "array") out[name] = ["amostra"];
    else out[name] = "amostra";
  }
  return out;
}

/**
 * Tools que NAO mapeiam para uma operacao GET da spec, cada uma por um motivo
 * declarado. Lista curta de propósito: acrescentar nome aqui é mudança de
 * segurança, e o ADR 0001 §9.4 do repo auth pede que ela seja revisada como tal,
 * não absorvida como detalhe.
 *
 *   guedder_rastrear_compra  — não fala com a API; usa a credencial AWS da task.
 *   guedder_cancelar_pedido  — escreve (POST); coberto por escrita.test.mjs.
 */
const FORA_DO_CONTRATO_GET = new Set(["guedder_rastrear_compra", "guedder_cancelar_pedido"]);

test("cada tool chama o path e os query params da sua operacao OpenAPI", async () => {
  const seen = [];
  const server = http.createServer((request, response) => {
    seen.push(Object.assign(new URL(request.url, "http://localhost"), { metodo: request.method }));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  const client = new Client({ name: "spec-paths-test", version: "0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      if (FORA_DO_CONTRATO_GET.has(tool.name)) continue;
      const resource = await client.readResource({ uri: `guedder://openapi/v3/tools/${tool.name}` });
      const spec = JSON.parse(resource.contents[0].text);
      const [specPath, methods] = Object.entries(spec.paths)[0];
      const operation = methods.get;
      const declared = new Set((operation.parameters ?? []).filter((p) => p.in === "query").map((p) => p.name));
      // findExtratosByEvento, getContagemIngressosVendidos e getGatewaysAdquirentes_1
      // documentam a paginacao como um schema Pageable opaco (nao expandem "page"/"size"
      // como nomes de query literais), diferente dos endpoints v3 equivalentes. Sem
      // nome usavel na spec para conferir, pulamos so a checagem de query para elas;
      // o path continua sendo conferido para todas.
      const skipQueryCheck = declared.size === 0 || (declared.has("pageable") && !declared.has("page"));
      const pattern = new RegExp("^" + specPath.replace(/\{[^}]+\}/g, "[^/]+") + "$");

      seen.length = 0;
      const result = await client.callTool({ name: tool.name, arguments: sampleArgs(tool.inputSchema) });
      assert.notEqual(result.isError, true, `${tool.name}: ${result.content?.[0]?.text}`);
      assert.equal(seen.length, 1, `${tool.name} deve fazer exatamente um GET`);
      // O verbo, e nao so a contagem. Ate agora "read-only" era inferido de o
      // servidor so ter `apiGet`; desde que existe `apiPost`, a propriedade
      // precisa ser afirmada onde ela pode ser quebrada.
      assert.equal(seen[0].metodo, "GET", `${tool.name} escreveu, e nao esta na lista de escrita`);
      assert.match(seen[0].pathname, pattern, `${tool.name}: ${seen[0].pathname} nao casa com ${specPath} (${operation.operationId})`);
      if (skipQueryCheck) continue;
      for (const key of seen[0].searchParams.keys()) {
        assert.ok(declared.has(key), `${tool.name}: query param "${key}" nao existe em ${operation.operationId} (${[...declared].join(", ")})`);
      }
    }
  } finally {
    await client.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
