/**
 * Validação ponta a ponta do MCP contra staging.
 *
 * Sobe o servidor com a configuração real de staging e exercita as três camadas que só se
 * provam juntas: identidade (token do Cognito), acesso à API (token repassado) e auditoria
 * (credencial AWS do servidor, não do usuário). É o "um login só" do ADR 0001 §9.2 sendo
 * verificado de verdade.
 *
 * O único passo humano é obter o token — o consent screen do Google é anti-bot por design, e
 * senha não passa por aqui. Sem token, o script roda mesmo assim e valida tudo que não depende
 * dele, marcando o resto como PULADO em vez de fingir sucesso.
 *
 *   node test/validar-staging.mjs                    # sem token: valida o que dá
 *   TOKEN=eyJ... node test/validar-staging.mjs       # ponta a ponta
 *   TOKEN=eyJ... ID_PEDIDO=5daig7vi11 node test/validar-staging.mjs
 *
 * Para obter o token, abra a Hosted UI e troque o code:
 *   https://guedder-auth-staging.auth.us-east-1.amazoncognito.com/oauth2/authorize
 *     ?client_id=3ano9ppcdnf5ikuk22mgjvo62h&response_type=code&scope=openid+profile+email
 *     &redirect_uri=http://localhost:6274/oauth/callback
 */
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const POOL = process.env.GUEDDER_COGNITO_ISSUER
  ?? "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_UhlIAqn5b";
const CLIENT_ID = process.env.GUEDDER_MCP_CLIENT_ID ?? "3ano9ppcdnf5ikuk22mgjvo62h";
const LOG_GROUPS = process.env.GUEDDER_MCP_LOG_GROUPS ?? "/ecs/guedder-staging";
const API = process.env.GUEDDER_API_BASE ?? "https://dev-api.guedder.com";
const PORTA = Number(process.env.PORTA ?? 3399);
const TOKEN = process.env.TOKEN?.trim();
const ID_PEDIDO = process.env.ID_PEDIDO?.trim();

const base = `http://127.0.0.1:${PORTA}`;
let passou = 0, falhou = 0, pulado = 0;

function ok(nome, detalhe = "") {
  passou++; console.log(`  ✅ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
}
function erro(nome, detalhe) {
  falhou++; console.log(`  ❌ ${nome} — ${detalhe}`);
}
function pular(nome, motivo) {
  pulado++; console.log(`  ⏭  ${nome} — ${motivo}`);
}

async function mcp(metodo, params, token) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: metodo, params }),
  });
  const texto = await res.text();
  // Streamable HTTP responde em SSE; o corpo JSON vem depois de "data: ".
  const linha = texto.split("\n").find((l) => l.startsWith("data: "));
  return { status: res.status, headers: res.headers, corpo: linha ? JSON.parse(linha.slice(6)) : texto };
}

const servidor = spawn(process.execPath, ["dist/index.js"], {
  env: {
    ...process.env,
    GUEDDER_COGNITO_ISSUER: POOL,
    GUEDDER_MCP_CLIENT_ID: CLIENT_ID,
    GUEDDER_MCP_LOG_GROUPS: LOG_GROUPS,
    GUEDDER_API_BASE: API,
    GUEDDER_MCP_PORT: String(PORTA),
    AWS_REGION: process.env.AWS_REGION ?? "us-east-1",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
servidor.stderr.on("data", (d) => {
  const s = String(d);
  if (!s.includes("no ar")) process.stderr.write(`    [servidor] ${s}`);
});

try {
  await sleep(1500);
  console.log(`\nMCP em ${base} · pool ${POOL.split("/").pop()} · API ${API}\n`);

  console.log("1. Identidade");
  {
    const meta = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
    meta.authorization_servers?.[0] === POOL
      ? ok("metadata aponta o pool de staging")
      : erro("metadata", `esperava ${POOL}, veio ${meta.authorization_servers?.[0]}`);

    const semToken = await mcp("tools/list", {});
    const wa = semToken.headers.get("www-authenticate") ?? "";
    semToken.status === 401 && wa.includes("resource_metadata")
      ? ok("sem token: 401 com WWW-Authenticate")
      : erro("sem token", `status ${semToken.status}, www-authenticate="${wa}"`);

    const lixo = await mcp("tools/list", {}, "nao.e.um.jwt");
    lixo.status === 401 ? ok("token inválido recusado") : erro("token inválido", `status ${lixo.status}`);
  }

  console.log("\n2. Acesso à API com o token do usuário");
  if (!TOKEN) {
    pular("tools/list autenticado", "sem TOKEN");
    pular("tool pública via MCP", "sem TOKEN");
    pular("tool autenticada repassa o token à API", "sem TOKEN");
  } else {
    const lista = await mcp("tools/list", {}, TOKEN);
    const tools = lista.corpo?.result?.tools ?? [];
    tools.length > 0
      ? ok("tools/list autenticado", `${tools.length} tools`)
      : erro("tools/list", JSON.stringify(lista.corpo).slice(0, 200));

    const pub = await mcp("tools/call", { name: "guedder_listar_eventos", arguments: { max_results: 1 } }, TOKEN);
    pub.corpo?.result && !pub.corpo.result.isError
      ? ok("tool pública responde")
      : erro("tool pública", JSON.stringify(pub.corpo?.result ?? pub.corpo).slice(0, 200));

    const priv = await mcp("tools/call", { name: "guedder_usuario_logado", arguments: {} }, TOKEN);
    if (priv.corpo?.result && !priv.corpo.result.isError) {
      const dados = priv.corpo.result.structuredContent?.result ?? {};
      ok("tool autenticada: token repassado à API", dados.email ? `usuário ${dados.email}` : "sem email no retorno");
    } else {
      erro("tool autenticada", JSON.stringify(priv.corpo?.result ?? priv.corpo).slice(0, 250));
    }
  }

  console.log("\n3. Auditoria com credencial do servidor");
  if (!TOKEN) {
    pular("rastrear compra", "sem TOKEN");
  } else if (!ID_PEDIDO) {
    pular("rastrear compra", "sem ID_PEDIDO — passe um id de pedido real de staging");
  } else {
    const aud = await mcp("tools/call",
      { name: "guedder_rastrear_compra", arguments: { identificador: ID_PEDIDO } }, TOKEN);
    const r = aud.corpo?.result;
    if (r?.isError) {
      const txt = r.content?.[0]?.text ?? "";
      txt.includes("administrativo")
        ? ok("portão de admin barrou usuário comum", "esperado se o token não for de admin")
        : erro("rastrear compra", txt.slice(0, 200));
    } else {
      const dados = r?.structuredContent?.result ?? {};
      dados.encontrado
        ? ok("rastreou a compra", `trace ${dados.trace_id}, ${dados.linhas?.length ?? 0} linhas`)
        : erro("rastrear compra", dados.motivo ?? "não encontrou");
    }
  }

  console.log(`\n${"─".repeat(50)}`);
  console.log(`passou: ${passou}   falhou: ${falhou}   pulado: ${pulado}`);
  if (pulado > 0 && falhou === 0) {
    console.log("\nPara fechar a validação, obtenha o token pela Hosted UI (link no topo deste arquivo)");
    console.log("e rode: TOKEN=... ID_PEDIDO=... node test/validar-staging.mjs");
  }
  process.exitCode = falhou > 0 ? 1 : 0;
} finally {
  servidor.kill();
}
