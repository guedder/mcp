/**
 * Fundação de escrita (ADR 0003): o que toda operação que muda estado precisa,
 * num lugar só e sem depender de transporte nem de API.
 *
 *   - código de confirmação amarrado à operação, ao alvo, aos ARGUMENTOS e à pessoa;
 *   - linha de auditoria;
 *   - redação de dado pessoal na saída (GUE-484).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Caller } from "./auth.js";

/**
 * Segredo dos HMACs (código de confirmação e prova de consent).
 *
 * Com N réplicas ele PRECISA vir de fora (`GUEDDER_MCP_CONFIRM_SECRET`, injetado
 * do Secrets Manager): a fase 1 pode cair numa task e a fase 2 noutra, e com
 * segredo por processo a confirmação simplesmente não confere. O aleatório fica
 * para stdio e dev local, onde só existe um processo.
 */
export const SEGREDO: Buffer = process.env.GUEDDER_MCP_CONFIRM_SECRET?.trim()
  ? Buffer.from(process.env.GUEDDER_MCP_CONFIRM_SECRET.trim())
  : randomBytes(32);

export function usuarioDe(caller?: Caller): string {
  return caller?.usuarioId ?? caller?.email ?? "local";
}

/** JSON com chaves ordenadas, para `{a,b}` e `{b,a}` darem o mesmo código. */
export function jsonCanonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function hashArgs(args: unknown): string {
  return createHash("sha256").update(jsonCanonico(args)).digest("hex").slice(0, 16);
}

const BLOCO_MS = 600_000;

/**
 * Código que amarra a confirmação a UMA operação, com ESTES argumentos, para
 * UMA pessoa, por 10 a 20 minutos.
 *
 * Os argumentos entram porque, sem eles, o código do "lote de 100 ingressos a
 * R$ 10" confirmaria o "lote de 10.000 a R$ 0" no mesmo evento. Imprevisível de
 * propósito: um código fixo deixaria o modelo pular a fase de resumo.
 */
export function codigoDeConfirmacao(
  op: string,
  alvo: string,
  args: unknown,
  caller?: Caller,
  deslocamento = 0,
): string {
  const bloco = Math.floor(Date.now() / BLOCO_MS) - deslocamento;
  return createHmac("sha256", SEGREDO)
    .update([op, alvo, jsonCanonico(args), usuarioDe(caller), bloco].join("\n"))
    .digest("base64url")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 10);
}

/** Bloco atual e o anterior: a pessoa pode levar uns minutos lendo o resumo. */
export function confirmacaoConfere(
  codigo: unknown,
  op: string,
  alvo: string,
  args: unknown,
  caller?: Caller,
): boolean {
  if (typeof codigo !== "string") return false;
  return [0, 1].some((d) => {
    const esperado = codigoDeConfirmacao(op, alvo, args, caller, d);
    return codigo.length === esperado.length && timingSafeEqual(Buffer.from(codigo), Buffer.from(esperado));
  });
}

export type EventoDeAuditoria = {
  tool: string;
  fase: "resumo" | "execucao" | "codigo_invalido" | "negado";
  escopo?: string;
  usuario: string;
  eventoId?: string;
  alvo?: string;
  argsHash?: string;
  resultado?: string;
};

/**
 * Uma linha JSON por evento, filtrável no CloudWatch por `{ $.audit IS TRUE }`.
 *
 * stderr e não stdout: no transporte stdio o stdout é o canal JSON-RPC, e uma
 * linha de log ali derruba o cliente. O awslogs da task captura os dois.
 * Sem args crus, só o hash: o arg de uma escrita pode ter o nome de um cupom
 * ou de um lote, mas o de uma leitura futura pode ter CPF.
 */
export function auditar(e: EventoDeAuditoria): void {
  process.stderr.write(`${JSON.stringify({ audit: true, ts: new Date().toISOString(), ...e })}\n`);
}

/**
 * Chaves que nunca saem para o contexto do LLM (GUE-484). Lista única: tool
 * nova herda sem fazer nada, e somar chave aqui vale para todas.
 * Comparação sem caixa.
 */
export const CHAVES_SENSIVEIS = new Set(
  [
    "cpf",
    "documento",
    "email",
    "emailParticipante",
    "telefone",
    "telefoneParticipante",
    "celular",
    "nomePortador",
    "fotoPortador",
    "codigoIngresso",
    "codigoIngressoPortador",
    "numeroCartao",
    "cartao",
    "dadosCartao",
    "tokenCartao",
    "cvv",
    "cvc",
  ].map((k) => k.toLowerCase()),
);

/**
 * `codigo` sozinho é ambíguo: em evento e lote é identificador público (a
 * pessoa digita na URL), em ingresso é a credencial de entrada no portão.
 * Só é mascarado no objeto que tem cara de ingresso.
 */
const CARA_DE_INGRESSO = ["idPedido", "nomePortador"];

const REDIGIDO = "[redigido]";

export function redigir<T>(valor: T): T {
  if (Array.isArray(valor)) return valor.map(redigir) as T;
  if (!valor || typeof valor !== "object") return valor;
  const o = valor as Record<string, unknown>;
  const ingresso = CARA_DE_INGRESSO.some((k) => k in o);
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const sensivel = CHAVES_SENSIVEIS.has(k.toLowerCase()) || (ingresso && k === "codigo");
    saida[k] = sensivel && v !== null && v !== undefined ? REDIGIDO : redigir(v);
  }
  return saida as T;
}
