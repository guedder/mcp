/**
 * Validação do token que chega no MCP (ADR 0001 do repo auth, §9.6).
 *
 * O usuário faz UM login Guedder; o token dele vem no `Authorization` do request MCP e é
 * repassado à API. As credenciais AWS das tools de auditoria são do servidor, não da pessoa —
 * por isso não existe segunda conexão.
 *
 * Enquanto `GUEDDER_COGNITO_ISSUER` não estiver definido o módulo fica inerte e o servidor
 * segue no modo antigo (token estático de processo), que é o do stdio local e do smoke.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export type Caller = {
  token: string;
  email: string;
  usuarioId?: string;
  role?: string;
  isAdmin: boolean;
};

export type AuthConfig = {
  issuer: string;
  /** Audiência esperada — o próprio servidor MCP. Separa esta superfície da API. */
  resource: string;
  /** client_id do App Client do agente. Token de outro client é recusado. */
  clientId?: string;
  getKey?: JWTVerifyGetKey;
};

export function authConfigFromEnv(): AuthConfig | null {
  const issuer = process.env.GUEDDER_COGNITO_ISSUER?.trim();
  if (!issuer) return null;
  return {
    issuer,
    resource: process.env.GUEDDER_MCP_RESOURCE?.trim() || "https://mcp.guedder.com/mcp",
    clientId: process.env.GUEDDER_MCP_CLIENT_ID?.trim() || undefined,
  };
}

export function createVerifier(cfg: AuthConfig) {
  // Cognito publica o JWKS em <issuer>/.well-known/jwks.json. O jose cuida de cache e rotação.
  const getKey = cfg.getKey ?? createRemoteJWKSet(new URL(`${cfg.issuer}/.well-known/jwks.json`));

  return async function verify(authorization: string | undefined): Promise<Caller> {
    if (!authorization) throw new AuthError("Token ausente.");
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (!token) throw new AuthError("Token ausente.");

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, getKey, { issuer: cfg.issuer }));
    } catch (e: any) {
      throw new AuthError(`Token inválido: ${e?.code ?? e?.message ?? "verificação falhou"}`);
    }

    // Access token do Cognito não tem `aud`; a amarração de superfície é pelo client_id.
    // Token do app web (outro client) não serve aqui, mesmo sendo do mesmo usuário.
    if (cfg.clientId && payload.client_id !== cfg.clientId) {
      throw new AuthError("Token emitido para outro client.");
    }

    const email = (payload.email ?? payload["cognito:username"]) as string | undefined;
    if (!email) throw new AuthError("Token sem email — não dá para resolver o usuário.");

    const role = payload["custom:role"] as string | undefined;

    return {
      token,
      email,
      usuarioId: payload["custom:usuario_id"] as string | undefined,
      role,
      // A Pre-Token Lambda NUNCA emite `custom:is_admin` — ela copia `role` da
      // coluna `usuario.role` (UserRole: ADMIN | PRODUTOR | USER). Ler
      // `custom:is_admin` deixava isAdmin sempre false, fechando a auditoria
      // até para admin. Passou despercebido porque enquanto o Postgres estava
      // inalcançável nenhum token trazia `custom:*`, e a recusa parecia certa.
      isAdmin: role === "ADMIN",
    };
  };
}

export class AuthError extends Error {}

/**
 * RFC 9728: como o cliente MCP descobre onde autenticar depois de tomar 401.
 *
 * `authorization_servers` aponta para o PRÓPRIO MCP, e não para o issuer do
 * Cognito, porque é daqui que sai a metadata do authorization server — ver
 * `authorizationServerMetadata` abaixo para o porquê.
 */
export function protectedResourceMetadata(cfg: AuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [asBaseUrl(cfg)],
    bearer_methods_supported: ["header"],
  };
}

export function wwwAuthenticate(cfg: AuthConfig, metadataUrl: string): string {
  return `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`;
}

/** Base pública deste servidor, derivada do `resource` (que já é <base>/mcp). */
function asBaseUrl(cfg: AuthConfig): string {
  const u = new URL(cfg.resource);
  return u.origin;
}

/**
 * RFC 8414 servida por nós, espelhando o Cognito e corrigindo o que ele declara
 * errado sobre si mesmo.
 *
 * O Cognito só publica `<issuer>/.well-known/openid-configuration`. As duas
 * formas do RFC 8414 (`/.well-known/oauth-authorization-server`, com e sem
 * inserção de path) devolvem 400 — conferido ao vivo. Cliente que só procura o
 * caminho do 8414 nunca acha nada.
 *
 * Pior: o documento que ele publica mente por omissão em dois pontos que decidem
 * se um cliente público consegue autenticar:
 *
 *   token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"]
 *   code_challenge_methods_supported: (ausente)
 *
 * Ou seja, o Cognito afirma exigir secret e não afirma suportar PKCE — as duas
 * ao contrário do que ele faz na prática. Nosso app client é público, sem secret
 * (o Cognito fixa isso na criação), e o login por PKCE/S256 funciona.
 *
 * Republicamos o documento dele com esses dois campos corrigidos. Buscar em vez
 * de escrever à mão é de propósito: endpoint que o Cognito mudar continua certo
 * aqui sem ninguém lembrar de editar.
 *
 * O `issuer` mantém o do Cognito, e não a URL deste servidor. É uma escolha com
 * custo conhecido: o RFC 8414 §3.3 manda o issuer bater com a URL de onde o
 * documento veio, então cliente estrito pode recusar. A alternativa — declarar
 * este servidor como issuer — faria o `iss` do token emitido pelo Cognito não
 * bater com o do AS, que é a checagem de segurança de verdade. Entre quebrar uma
 * regra de descoberta e quebrar a validação do token, quebra-se a primeira.
 */
export async function authorizationServerMetadata(
  cfg: AuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${cfg.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery do Cognito falhou: ${res.status}`);
  const doc = (await res.json()) as Record<string, unknown>;

  return {
    ...doc,
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_basic", "client_secret_post"],
  };
}
