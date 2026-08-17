/**
 * Captura um token de staging para fechar a validação ponta a ponta.
 *
 * Gera o par PKCE, imprime a URL da Hosted UI, sobe um receptor em
 * localhost:6274 (o redirect_uri já autorizado no App Client) e troca o
 * `code` por token assim que o Cognito redireciona.
 *
 * A senha é digitada na página do Cognito, nunca aqui — este script não vê,
 * não pede e não guarda credencial. Ele só recebe o `code` de volta.
 *
 *   node test/login-staging.mjs           # imprime a URL e espera o callback
 *   node test/login-staging.mjs --validar # em seguida, roda validar-staging.mjs
 */
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const POOL_ID = process.env.POOL_ID ?? "us-east-1_UhlIAqn5b";
const CLIENT_ID = process.env.CLIENT_ID ?? "3ano9ppcdnf5ikuk22mgjvo62h";
const HOSTED_UI = process.env.HOSTED_UI
  ?? "https://guedder-auth-staging.auth.us-east-1.amazoncognito.com";
const REDIRECT = "http://localhost:6274/oauth/callback";
const PORTA = 6274;

const b64url = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const verifier = b64url(randomBytes(32));
const challenge = b64url(createHash("sha256").update(verifier).digest());
const state = b64url(randomBytes(16));

const url = `${HOSTED_UI}/oauth2/authorize?` + new URLSearchParams({
  client_id: CLIENT_ID,
  response_type: "code",
  scope: "openid profile email",
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
});

console.log("\nAbra no navegador e faça login (senha ou Google):\n");
console.log(url);
console.log("\nEsperando o callback em " + REDIRECT + " …\n");

const code = await new Promise((resolve, reject) => {
  const servidor = createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORTA}`);
    if (u.pathname !== "/oauth/callback") { res.writeHead(404).end(); return; }
    const erro = u.searchParams.get("error");
    const recebido = u.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(erro
      ? `<h2>Falhou: ${erro}</h2><p>${u.searchParams.get("error_description") ?? ""}</p>`
      : "<h2>Pode fechar esta aba.</h2><p>O token foi capturado no terminal.</p>");
    servidor.close();
    if (erro) reject(new Error(`${erro}: ${u.searchParams.get("error_description") ?? ""}`));
    else if (u.searchParams.get("state") !== state) reject(new Error("state não confere — possível CSRF"));
    else resolve(recebido);
  });
  servidor.listen(PORTA);
  setTimeout(() => { servidor.close(); reject(new Error("ninguém chamou o callback em 5 min")); }, 300_000);
});

const res = await fetch(`${HOSTED_UI}/oauth2/token`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  }),
});
const tokens = await res.json();
if (!res.ok) {
  console.error("troca do code falhou:", tokens);
  process.exit(1);
}

const claims = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64").toString());
console.log("Token obtido.");
console.log(`  client_id : ${claims.client_id}`);
console.log(`  usuário   : ${claims.username ?? claims.sub}`);
console.log(`  expira em : ${Math.round((claims.exp * 1000 - Date.now()) / 60000)} min`);
console.log(`  claims custom:* : ${Object.keys(claims).filter(k => k.startsWith("custom:")).join(", ") || "(nenhuma — Pre-Token não populou)"}`);
console.log(`\nexport TOKEN='${tokens.access_token}'\n`);

if (process.argv.includes("--validar")) {
  // Salva também em arquivo: assim o resultado não depende de copiar e colar do
  // terminal, e quem estiver acompanhando a sessão consegue ler direto.
  const destino = process.env.SAIDA ?? "/tmp/validacao-staging.txt";
  console.log(`Rodando a validação… (saída também em ${destino})\n`);
  const { createWriteStream } = await import("node:fs");
  const arquivo = createWriteStream(destino);
  const filho = spawn(process.execPath, ["test/validar-staging.mjs"], {
    env: { ...process.env, TOKEN: tokens.access_token },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const fluxo of [filho.stdout, filho.stderr]) {
    fluxo.on("data", (d) => { process.stdout.write(d); arquivo.write(d); });
  }
  filho.on("close", (c) => { arquivo.end(); process.exitCode = c ?? 0; });
}
