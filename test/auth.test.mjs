/**
 * Cobre a fronteira de autenticação do MCP: um token só é aceito se a assinatura confere, o
 * emissor é o esperado e foi emitido para o nosso client. É o ponto onde a superfície do MCP
 * se separa da do app web — ver ADR 0001 §9.6 do repo auth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet } from "jose";
import {
  createVerifier,
  AuthError,
  EscopoError,
  exigirEscopo,
  protectedResourceMetadata,
  authorizationServerMetadata,
  cognitoEndpoints,
  limparCacheDeEndpoints,
} from "../dist/auth.js";

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

// authorization_servers aponta para o PRÓPRIO MCP, não para o issuer do Cognito:
// é daqui que sai a metadata RFC 8414, porque o Cognito não serve aquele caminho.
test("metadata aponta o resource e o authorization server", () => {
  const meta = protectedResourceMetadata({
    issuer: ISSUER,
    resource: "https://mcp.guedder.com/mcp",
  });
  assert.equal(meta.resource, "https://mcp.guedder.com/mcp");
  assert.deepEqual(meta.authorization_servers, ["https://mcp.guedder.com"]);
});

test("espelho do authorization server corrige o que o Cognito declara errado", async () => {
  // Documento como o Cognito realmente publica: sem PKCE anunciado e afirmando
  // exigir secret. As duas coisas ao contrário do que ele faz na prática.
  const doCognito = {
    issuer: ISSUER,
    authorization_endpoint: "https://exemplo.auth.us-east-1.amazoncognito.com/oauth2/authorize",
    token_endpoint: "https://exemplo.auth.us-east-1.amazoncognito.com/oauth2/token",
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    scopes_supported: ["openid", "email", "phone", "profile"],
  };
  const fetchFalso = async (url) => {
    assert.equal(url, `${ISSUER}/.well-known/openid-configuration`);
    return { ok: true, json: async () => doCognito };
  };

  const doc = await authorizationServerMetadata(
    { issuer: ISSUER, resource: "https://mcp.guedder.com/mcp" },
    fetchFalso,
  );

  assert.deepEqual(doc.code_challenge_methods_supported, ["S256"]);
  assert.ok(doc.token_endpoint_auth_methods_supported.includes("none"),
    "cliente público precisa ver `none`, senão conclui que o AS exige secret");

  // issuer e endpoints são NOSSOS. O MCP Inspector recusou a versão anterior
  // aplicando o RFC 8414 §3.3 — o issuer tem que bater com a URL de origem do
  // documento. E é coerente: servimos /authorize e /token, então somos o AS da
  // perspectiva do cliente.
  assert.equal(doc.issuer, "https://mcp.guedder.com");
  assert.equal(doc.authorization_endpoint, "https://mcp.guedder.com/authorize");
  assert.equal(doc.token_endpoint, "https://mcp.guedder.com/token");

  // Sem registration_endpoint, cliente que exige DCR para antes de autenticar —
  // e este MCP vai no plugin, onde colar client_id à mão não é opção.
  assert.equal(doc.registration_endpoint, "https://mcp.guedder.com/register");

  // scopes_supported é do APP CLIENT, não do pool. O documento do Cognito trazia
  // `phone`, que o app client não permite, e o cliente pediu um escopo que o
  // próprio Cognito recusa — anunciado por nós.
  assert.deepEqual(doc.scopes_supported, ["openid", "email", "profile"]);
  assert.ok(!doc.scopes_supported.includes("phone"));

  // jwks_uri continua sendo o do Cognito: quem assina os tokens é ele.
  assert.equal(doc.jwks_uri, doCognito.jwks_uri);
});

test("espelho falha alto quando o Cognito não responde", async () => {
  const fetchFalso = async () => ({ ok: false, status: 503, json: async () => ({}) });
  await assert.rejects(
    () => authorizationServerMetadata({ issuer: ISSUER, resource: "https://m/mcp" }, fetchFalso),
    /OIDC discovery do Cognito falhou: 503/,
  );
});

test("endpoints do Cognito saem do documento e ficam em cache", async () => {
  limparCacheDeEndpoints();
  let chamadas = 0;
  const fetchFalso = async () => {
    chamadas++;
    return {
      ok: true,
      json: async () => ({
        issuer: ISSUER,
        authorization_endpoint: "https://exemplo.amazoncognito.com/oauth2/authorize",
        token_endpoint: "https://exemplo.amazoncognito.com/oauth2/token",
      }),
    };
  };
  const cfg = { issuer: ISSUER, resource: "https://mcp.guedder.com/mcp" };

  const um = await cognitoEndpoints(cfg, fetchFalso);
  const dois = await cognitoEndpoints(cfg, fetchFalso);

  assert.equal(um.authorize, "https://exemplo.amazoncognito.com/oauth2/authorize");
  assert.equal(um.token, "https://exemplo.amazoncognito.com/oauth2/token");
  // Cache: o fluxo OAuth acontece com o usuário esperando no navegador, e buscar
  // a descoberta a cada request só somaria latência num caminho fixo por pool.
  assert.equal(chamadas, 1, "segunda chamada deve vir do cache");
  assert.deepEqual(dois, um);
  limparCacheDeEndpoints();
});

test("falta de endpoint no documento falha alto", async () => {
  limparCacheDeEndpoints();
  const fetchFalso = async () => ({ ok: true, json: async () => ({ issuer: ISSUER }) });
  await assert.rejects(
    () => cognitoEndpoints({ issuer: ISSUER, resource: "https://m/mcp" }, fetchFalso),
    /não publicou authorization_endpoint/,
  );
  limparCacheDeEndpoints();
});

// ── Escopos concedidos (GUE — consent do MCP) ────────────────────────────────
// O que muda aqui: até agora o token dizia QUEM é a pessoa, e o alcance vinha do
// papel dela (`isAdmin`). Com consent, o token passa a dizer também O QUE ela
// autorizou o agente a fazer em nome dela — e essas duas coisas não são a mesma.
// Mirror do check-in: escopo é congelado na emissão do token, não reconsultado.

// Formato do fio: o Cognito prefixa cada escopo com o identificador do resource
// server. Escrever o teste com o nome curto seria testar um token que nunca
// existe — foi exatamente o erro que `prefixo do resource server` pegou.
const P = "https://mcp.guedder.com/mcp";

test("escopos concedidos saem da claim `scope`", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(
    `Bearer ${await emitir({ scope: `openid ${P}/conta:read ${P}/pedido:cancelar` })}`,
  );

  assert.deepEqual(caller.scopes, ["conta:read", "pedido:cancelar"]);
});

test("token sem `scope` não concede nada", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(`Bearer ${await emitir({})}`);

  // Ausência é o conjunto vazio, nunca "tudo". Um token velho, emitido antes do
  // consent existir, não pode virar passe livre quando o gate entrar.
  assert.deepEqual(caller.scopes, []);
});

test("exigirEscopo barra o que não foi concedido", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(`Bearer ${await emitir({ scope: `${P}/conta:read` })}`);

  exigirEscopo(caller, "conta:read"); // não lança

  assert.throws(
    () => exigirEscopo(caller, "pedido:cancelar"),
    (e) => e instanceof EscopoError && /pedido:cancelar/.test(e.message),
  );
});

// A propriedade que faz o consent significar alguma coisa. Sem este teste, a
// primeira pessoa a escrever `if (isAdmin) return true` num gate de escopo
// transforma consent em decoração: o agente de um admin poderia cancelar
// ingresso que o admin nunca autorizou o agente a cancelar.
test("admin NÃO fura escopo — papel diz onde pode, consent diz o que autorizou", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(
    `Bearer ${await emitir({ "custom:role": "ADMIN", scope: `${P}/conta:read` })}`,
  );

  assert.equal(caller.isAdmin, true);
  assert.throws(() => exigirEscopo(caller, "pedido:cancelar"), EscopoError);
});

// RFC 8707: o Cognito só põe `aud` no access token quando o cliente pede
// resource binding. Quando vier, é a amarração forte de superfície e vale mais
// que o client_id; quando não vier, o client_id segue sendo o que temos.
test("audiência errada é recusada quando o token traz `aud`", async () => {
  const { verify, emitir } = await ambiente();
  const token = await emitir({ aud: "https://api.guedder.com" });

  await assert.rejects(
    () => verify(`Bearer ${token}`),
    (e) => e instanceof AuthError && /audi/i.test(e.message),
  );
});

test("audiência certa passa, e token sem `aud` continua valendo pelo client_id", async () => {
  const { verify, emitir } = await ambiente();

  const comAud = await verify(`Bearer ${await emitir({ aud: "https://mcp.guedder.com/mcp" })}`);
  assert.equal(comAud.email, "suporte@guedder.com");

  const semAud = await verify(`Bearer ${await emitir({})}`);
  assert.equal(semAud.email, "suporte@guedder.com");
});

// No Cognito o identificador do resource server vira PREFIXO do escopo dentro do
// token: quem declara `conta:read` em `https://mcp.guedder.com/mcp` recebe
// `https://mcp.guedder.com/mcp/conta:read`. O n8n já vive isso com o resource
// server da API. Se o prefixo vazasse para o código das tools, cada gate viraria
// uma URL literal e trocar o host do MCP quebraria autorização.
test("prefixo do resource server é removido do escopo", async () => {
  const { verify, emitir } = await ambiente();
  const caller = await verify(
    `Bearer ${await emitir({
      scope: "openid https://mcp.guedder.com/mcp/conta:read https://mcp.guedder.com/mcp/pedido:cancelar",
    })}`,
  );

  assert.ok(caller.scopes.includes("conta:read"), `veio ${JSON.stringify(caller.scopes)}`);
  assert.ok(caller.scopes.includes("pedido:cancelar"));
  exigirEscopo(caller, "pedido:cancelar"); // o gate usa o nome curto

  // Escopo de OUTRO resource server não pode virar permissão nossa só por ter o
  // mesmo sufixo — senão `https://api.guedder.com/pedido:cancelar` abriria a
  // tool de cancelamento do MCP.
  const outro = await verify(
    `Bearer ${await emitir({ scope: "https://api.guedder.com/pedido:cancelar" })}`,
  );
  assert.deepEqual(outro.scopes, []);
});
