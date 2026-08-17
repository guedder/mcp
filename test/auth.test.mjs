/**
 * Cobre a fronteira de autenticação do MCP: um token só é aceito se a assinatura confere, o
 * emissor é o esperado e foi emitido para o nosso client. É o ponto onde a superfície do MCP
 * se separa da do app web — ver ADR 0001 §9.6 do repo auth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import { createVerifier, AuthError, protectedResourceMetadata } from "../dist/auth.js";

const ISSUER = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TESTE";
const CLIENT_ID = "cliente-do-agente";

async function ambiente() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "chave-de-teste";
  jwk.alg = "RS256";
  const getKey = createLocalJWKSet({ keys: [jwk] });
  const verify = createVerifier({
    issuer: ISSUER,
    resource: "https://mcp.guedder.com/mcp",
    clientId: CLIENT_ID,
    getKey,
  });
  const emitir = (claims = {}, issuer = ISSUER) =>
    new SignJWT({ client_id: CLIENT_ID, email: "suporte@guedder.com", ...claims })
      .setProtectedHeader({ alg: "RS256", kid: "chave-de-teste" })
      .setIssuer(issuer)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  return { verify, emitir };
}

// Só `custom:role`, sem `custom:is_admin`: é exatamente o que a Pre-Token
// Lambda emite. A versão anterior forjava as duas claims e por isso passava
// verde com o código lendo a que nunca chega em token real.
test("token válido devolve a identidade do usuário", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(`Bearer ${await emitir({ "custom:role": "ADMIN" })}`);

  assert.equal(caller.email, "suporte@guedder.com");
  assert.equal(caller.isAdmin, true);
  assert.equal(caller.role, "ADMIN");
});

test("papel não-admin não abre a auditoria", async () => {
  const { verify, emitir } = await ambiente();

  for (const role of ["PRODUTOR", "USER"]) {
    const caller = await verify(`Bearer ${await emitir({ "custom:role": role })}`);
    assert.equal(caller.isAdmin, false, `${role} não pode ser admin`);
    assert.equal(caller.role, role);
  }

  // Token sem `custom:*` (Pre-Token falhou ou usuário não está no Postgres):
  // fecha o portão em vez de assumir qualquer coisa.
  const semClaims = await verify(`Bearer ${await emitir({})}`);
  assert.equal(semClaims.isAdmin, false);
  assert.equal(semClaims.role, undefined);
});

test("token de outro client é recusado", async () => {
  const { verify, emitir } = await ambiente();
  const token = await emitir({ client_id: "guedder-web" });
  await assert.rejects(
    () => verify(`Bearer ${token}`),
    (e) => e instanceof AuthError && /outro client/.test(e.message),
  );
});

test("token de outro emissor é recusado", async () => {
  const { verify, emitir } = await ambiente();
  const token = await emitir({}, "https://evil.example.com");
  await assert.rejects(() => verify(`Bearer ${token}`), AuthError);
});

test("token assinado por outra chave é recusado", async () => {
  const { verify } = await ambiente();
  const outro = await ambiente();
  const token = await outro.emitir();
  await assert.rejects(() => verify(`Bearer ${token}`), AuthError);
});

test("sem Authorization é recusado", async () => {
  const { verify } = await ambiente();
  await assert.rejects(() => verify(undefined), AuthError);
  await assert.rejects(() => verify("Bearer   "), AuthError);
});

test("token sem email não autentica", async () => {
  const { verify, emitir } = await ambiente();
  const semEmail = await emitir({ email: undefined, "cognito:username": undefined });
  await assert.rejects(() => verify(`Bearer ${semEmail}`), AuthError);
});

test("metadata aponta o resource e o authorization server", () => {
  const meta = protectedResourceMetadata({
    issuer: ISSUER,
    resource: "https://mcp.guedder.com/mcp",
  });
  assert.equal(meta.resource, "https://mcp.guedder.com/mcp");
  assert.deepEqual(meta.authorization_servers, [ISSUER]);
});
