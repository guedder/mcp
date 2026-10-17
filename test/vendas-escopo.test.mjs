/**
 * ADR 0006 Decisão 2: as leituras de venda antigas exigem `vendas:read`,
 * igual às tools novas. Com Cognito ligado e sem caller/token, o portão
 * recusa antes de qualquer GET à API.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EVENTO = "11111111-1111-4111-8111-111111111111";

async function comCognitoSemCaller(fn) {
  const recebidos = [];
  const api = http.createServer((req, res) => {
    recebidos.push(req.url);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ content: [] }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const { port: apiPort } = api.address();

  const cognito = http.createServer((_req, res) => {
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
      GUEDDER_MCP_SCOPES: "openid email profile vendas:read",
    },
  });
  const client = new Client({ name: "vendas-escopo-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client, recebidos);
  } finally {
    await client.close();
    await new Promise((r) => api.close(r));
    await new Promise((r) => cognito.close(r));
  }
}

for (const name of ["guedder_auditar_vendas_evento", "guedder_resumo_vendas_evento"]) {
  test(`${name} exige vendas:read quando o Cognito está ligado`, async () => {
    await comCognitoSemCaller(async (client, recebidos) => {
      const r = await client.callTool({
        name,
        arguments: name === "guedder_auditar_vendas_evento" ? { eventoId: EVENTO, max_results: 5 } : { eventoId: EVENTO },
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /escopo|token|vendas:read/i);
      assert.deepEqual(recebidos, [], "não pode chamar a API sem passar no portão");
    });
  });
}
