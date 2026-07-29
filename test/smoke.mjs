// Smoke test: spawn the built server over stdio, list tools, call a public tool.
// Verifies tool wiring + the generic GET client end-to-end against prod (public endpoint).
// Run: npm run build && npm run smoke
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, GUEDDER_MCP_TRANSPORT: "stdio" },
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(", ")}`);
assert.ok(tools.length >= 11, "expected >= 11 tools");
assert.ok(tools.find((t) => t.name === "guedder_buscar_ingressos_evento"), "missing check-in tool");
assert.ok(tools.every((tool) => tool.outputSchema?.properties?.result), "all tools must document structured output");

const { resources } = await client.listResources();
assert.ok(resources.find((resource) => resource.uri === "guedder://openapi/v3"), "missing OpenAPI v3 resource");
assert.ok(resources.find((resource) => resource.uri === "guedder://openapi/v3/tools/guedder_listar_eventos"), "missing tool schema resource");
const index = await client.readResource({ uri: "guedder://openapi/v3" });
const manifest = JSON.parse(index.contents[0].text);
assert.ok(manifest.operations.every((operation) => operation.path.startsWith("/api/v3/")), "OpenAPI index must contain only v3 paths");
const schema = await client.readResource({ uri: "guedder://openapi/v3/tools/guedder_listar_eventos" });
const specification = JSON.parse(schema.contents[0].text);
assert.deepEqual(Object.keys(specification.paths), ["/api/v3/evento"]);

const res = await client.callTool({ name: "guedder_listar_eventos", arguments: { max_results: 1 } });
const text = res.content?.[0]?.text ?? "";
assert.ok(!res.isError, `public tool errored: ${text.slice(0, 300)}`);
const parsed = JSON.parse(text);
assert.equal(parsed.content.length, 1, "expected MCP to limit the event page to one item");
assert.equal(parsed.page.size, 1, "expected max_results to be forwarded as API page_size");
assert.deepEqual(res.structuredContent, { result: parsed });
console.log(`guedder_listar_eventos OK — page size: ${parsed.page.size}`);

await client.close();
console.log("SMOKE OK");
