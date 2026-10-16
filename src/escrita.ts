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

/**
 * Bloco atual e o anterior: a pessoa pode levar uns minutos lendo o resumo.
 *
 * O formato é conferido ANTES do `timingSafeEqual`: ele lança se os buffers
 * tiverem tamanhos diferentes, e "ÁÁÁÁÁÁÁÁÁÁ" tem 10 caracteres mas 20 bytes em
 * UTF-8. Sem esta linha, um código não-ASCII virava exceção em vez de recusa.
 */
export function confirmacaoConfere(
  codigo: unknown,
  op: string,
  alvo: string,
  args: unknown,
  caller?: Caller,
): boolean {
  if (typeof codigo !== "string" || !/^[A-Z0-9]{10}$/.test(codigo)) return false;
  return [0, 1].some((d) =>
    timingSafeEqual(Buffer.from(codigo), Buffer.from(codigoDeConfirmacao(op, alvo, args, caller, d))),
  );
}

export type EventoDeAuditoria = {
  tool: string;
  /** `recusado` = a fase de preparo recusou (validação local, lote inexistente): nada foi escrito. */
  fase: "resumo" | "execucao" | "codigo_invalido" | "negado" | "recusado";
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
    "chavePix",
  ].map((k) => k.toLowerCase()),
);

/**
 * `codigo` sozinho é ambíguo: em evento e lote é identificador público (a
 * pessoa digita na URL), em ingresso é a credencial de entrada no portão.
 *
 * Por isso a regra é de negação por padrão: `codigo` só fica visível em objeto
 * reconhecível como lote (`estoqueInicial`) ou evento (`dataInicio`), e nunca se
 * o objeto tiver marcador de ingresso. Um ingresso de formato novo, sem marcador
 * nenhum, sai redigido; o custo de errar para esse lado é um código de evento
 * a menos na resposta, e o do outro lado é a entrada de alguém no portão.
 */
const CARA_DE_LOTE_OU_EVENTO = ["estoqueInicial", "dataInicio"];
const CARA_DE_INGRESSO = ["ingressoId", "idPedido", "nomePortador", "checkIn"];

function codigoPublico(o: Record<string, unknown>): boolean {
  return CARA_DE_LOTE_OU_EVENTO.some((k) => k in o) && !CARA_DE_INGRESSO.some((k) => k in o);
}

/**
 * Dado pessoal em texto livre: corpo de erro da API, mensagem de log. Só os
 * formatos inequívocos (e-mail, CPF pontuado): mascarar toda sequência de 11
 * dígitos comeria id de pedido e trace_id.
 */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CPF = /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g;

export function mascararTexto(s: string): string {
  return s.replace(EMAIL, REDIGIDO).replace(CPF, REDIGIDO);
}

const REDIGIDO = "[redigido]";

export function redigir<T>(valor: T): T {
  if (typeof valor === "string") return mascararTexto(valor) as T;
  if (Array.isArray(valor)) return valor.map(redigir) as T;
  if (!valor || typeof valor !== "object") return valor;
  const o = valor as Record<string, unknown>;
  const saida: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    const sensivel = CHAVES_SENSIVEIS.has(k.toLowerCase()) || (k === "codigo" && !codigoPublico(o));
    saida[k] = sensivel && v !== null && v !== undefined ? REDIGIDO : redigir(v);
  }
  return saida as T;
}
