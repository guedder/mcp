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

/** RFC 9728: como o cliente MCP descobre onde autenticar depois de tomar 401. */
export function protectedResourceMetadata(cfg: AuthConfig) {
  return {
    resource: cfg.resource,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
  };
}

export function wwwAuthenticate(cfg: AuthConfig, metadataUrl: string): string {
  return `Bearer resource_metadata="${metadataUrl}", error="invalid_token"`;
}
