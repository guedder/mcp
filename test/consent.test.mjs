/**
 * A tela de consent do MCP.
 *
 * Existe aqui, e não no Cognito, porque o Cognito não tem tela de consent por
 * escopo: se o escopo está no app client e o cliente pede, ele emite sem
 * perguntar nada à pessoa (doc do authorization endpoint — `prompt=consent` só
 * é repassado a IdP externo). Como o MCP já é o front door de /authorize, a
 * escolha do que o agente recebe é feita neste servidor.
 *
 * O teto desse desenho está registrado em `src/index.ts`, no handler: consent
 * aqui é camada de autorização, não barreira criptográfica contra um cliente
 * malicioso que já tenha o client_id público.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import test from "node:test";

const COGNITO_AUTHORIZE = "https://exemplo.auth.us-east-1.amazoncognito.com/oauth2/authorize";
const RESOURCE = "https://mcp.guedder.com/mcp";
const ESCOPOS = "openid email profile conta:read pedido:cancelar";

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  return port;
}

/** Cognito de mentira: só precisa publicar a descoberta que o MCP espelha. */
async function cognitoFalso() {
  const porta = await freePort();
  const issuer = `http://127.0.0.1:${porta}`;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        issuer,
        authorization_endpoint: COGNITO_AUTHORIZE,
        token_endpoint: "https://exemplo.auth.us-east-1.amazoncognito.com/oauth2/token",
        jwks_uri: `${issuer}/.well-known/jwks.json`,
      }),
    );
  });
  await new Promise((resolve) => server.listen(porta, "127.0.0.1", resolve));
  return { issuer, fechar: () => new Promise((r) => server.close(r)) };
}

async function subirMcp(issuer) {
  const port = await freePort();
  const proc = spawn("node", ["dist/index.js"], {
    env: {
      ...globalThis.process.env,
      GUEDDER_MCP_PORT: String(port),
      GUEDDER_COGNITO_ISSUER: issuer,
      GUEDDER_MCP_CLIENT_ID: "cliente-do-agente",
      GUEDDER_MCP_RESOURCE: RESOURCE,
      GUEDDER_MCP_SCOPES: ESCOPOS,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  await new Promise((resolve, reject) => {
    proc.stderr.on("data", (c) => c.toString().includes("Streamable HTTP no ar") && resolve());
    proc.once("error", reject);
    proc.once("exit", (code) => reject(new Error(`MCP encerrou antes de iniciar (${code}).`)));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    parar: async () => {
      proc.kill();
      await new Promise((r) => proc.once("exit", r));
    },
  };
}

const PEDIDO_BASE =
  "response_type=code&client_id=cliente-do-agente&redirect_uri=http%3A%2F%2Flocalhost%3A6274%2Fcallback" +
  "&state=xyz&code_challenge=abc&code_challenge_method=S256";

async function comAmbiente(fn) {
  const cognito = await cognitoFalso();
  const mcp = await subirMcp(cognito.issuer);
  try {
    await fn(mcp.base);
  } finally {
    await mcp.parar();
    await cognito.fechar();
  }
}

test("/authorize sem consentimento mostra a tela, não redireciona", async () => {
  await comAmbiente(async (base) => {
    const res = await fetch(`${base}/authorize?${PEDIDO_BASE}&scope=openid+conta%3Aread+pedido%3Acancelar`, {
      redirect: "manual",
    });

    assert.equal(res.status, 200, "tem que servir HTML, não 302 direto pro Cognito");
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);

    const html = await res.text();
    // Os escopos opcionais aparecem para a pessoa escolher, um a um.
    assert.match(html, /conta:read/);
    assert.match(html, /pedido:cancelar/);
    // E o pedido original sobrevive à tela, senão o fluxo OAuth quebra no retorno.
    assert.match(html, /xyz/, "state tem que atravessar a tela");
    assert.match(html, /abc/, "code_challenge tem que atravessar a tela");
  });
});

test("consentimento leva ao Cognito só com o que foi marcado", async () => {
  await comAmbiente(async (base) => {
    // A pessoa marcou só leitura: deixou `pedido:cancelar` de fora.
    const res = await fetch(
      `${base}/authorize?${PEDIDO_BASE}&consentido=1&scope=openid+email+profile+conta%3Aread`,
      { redirect: "manual" },
    );

    assert.equal(res.status, 302);
    const destino = new URL(res.headers.get("location"));
    assert.equal(`${destino.origin}${destino.pathname}`, COGNITO_AUTHORIZE);

    const escopos = (destino.searchParams.get("scope") ?? "").split(/\s+/);
    assert.ok(escopos.includes("conta:read"), "o que a pessoa marcou tem que ir");
    assert.ok(
      !escopos.includes("pedido:cancelar"),
      "o que a pessoa NÃO marcou não pode ir — é o ponto inteiro do consent",
    );

    // RFC 8707: sem `resource`, o Cognito não põe `aud` no access token e o MCP
    // perde a amarração forte de superfície.
    assert.equal(destino.searchParams.get("resource"), RESOURCE);

    // O resto do pedido OAuth tem que chegar intacto.
    assert.equal(destino.searchParams.get("state"), "xyz");
    assert.equal(destino.searchParams.get("code_challenge"), "abc");
    assert.equal(destino.searchParams.get("redirect_uri"), "http://localhost:6274/callback");
  });
});

// O teste que faz a tela valer alguma coisa: marcar na mão um escopo que o
// servidor não anuncia não pode virar concessão. Sem esta interseção, o
// formulário é só uma sugestão e qualquer um monta a query que quiser.
test("escopo que o servidor não anuncia não passa, mesmo forjado na query", async () => {
  await comAmbiente(async (base) => {
    const res = await fetch(
      `${base}/authorize?${PEDIDO_BASE}&consentido=1&scope=openid+conta%3Aread+admin%3Atudo`,
      { redirect: "manual" },
    );

    assert.equal(res.status, 302);
    const escopos = (new URL(res.headers.get("location")).searchParams.get("scope") ?? "").split(/\s+/);
    assert.ok(!escopos.includes("admin:tudo"), "escopo fora do anunciado tem que ser descartado");
    assert.ok(escopos.includes("conta:read"));
  });
});
