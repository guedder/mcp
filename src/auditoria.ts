/**
 * Rastreio de compra em log (ADR 0001 do repo auth, §9.6 e §9.7).
 *
 * Duas regras que não são detalhe de implementação:
 *
 * 1. Consulta é sempre POR IDENTIFICADOR — id de pedido, id de compra ou trace_id. Nunca por
 *    janela de tempo. "Me traz o log das últimas duas horas" é exfiltração com passos extras.
 * 2. A resposta carrega campos ALLOWLISTED. O log de produção tem PII de comprador e o destino
 *    é o contexto de um LLM de terceiro, então o evento cru não sai daqui.
 *
 * As credenciais AWS são as da task do servidor, não do usuário: o IAM estreita quais log
 * groups, e o recorte da resposta é problema deste módulo.
 */
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";

/** Campos que podem sair para o modelo. Qualquer outro é descartado. */
const CAMPOS_PERMITIDOS = ["@timestamp", "level", "logger_name", "trace_id", "xray_trace_id", "message"] as const;

export type LinhaLog = Partial<Record<(typeof CAMPOS_PERMITIDOS)[number], string>>;

export type AuditoriaConfig = {
  logGroups: string[];
  region: string;
  /** Teto de linhas devolvidas por consulta. */
  maxLinhas: number;
  /** Janela de busca da âncora, em dias. Não é filtro do usuário: é limite do scan. */
  janelaDias: number;
  client?: CloudWatchLogsClient;
};

export function auditoriaConfigFromEnv(): AuditoriaConfig | null {
  const groups = (process.env.GUEDDER_MCP_LOG_GROUPS ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
  if (groups.length === 0) return null;
  return {
    logGroups: groups,
    region: process.env.AWS_REGION?.trim() || "us-west-2",
    maxLinhas: Number(process.env.GUEDDER_MCP_MAX_LINHAS ?? 100),
    janelaDias: Number(process.env.GUEDDER_MCP_JANELA_DIAS ?? 30),
  };
}

function sanitize(campos: ResultField[] | undefined): LinhaLog {
  const linha: LinhaLog = {};
  for (const campo of campos ?? []) {
    const nome = campo.field as (typeof CAMPOS_PERMITIDOS)[number];
    if (CAMPOS_PERMITIDOS.includes(nome) && campo.value != null) {
      linha[nome] = campo.value;
    }
  }
  return linha;
}

/**
 * Identificador vindo do modelo entra numa regex do Logs Insights. Restringe ao alfabeto de
 * UUID e de id de pedido para o valor não virar um padrão que casa com tudo.
 */
export function validarIdentificador(valor: string): string {
  const limpo = valor.trim();
  if (!/^[A-Za-z0-9._:-]{4,128}$/.test(limpo)) {
    throw new Error(
      "Identificador inválido: use o id do pedido, o id da compra ou o trace_id, sem espaços ou curingas.",
    );
  }
  return limpo;
}

export function criarAuditoria(cfg: AuditoriaConfig) {
  const client = cfg.client ?? new CloudWatchLogsClient({ region: cfg.region });

  async function consultar(query: string, limite: number): Promise<LinhaLog[]> {
    const fim = Math.floor(Date.now() / 1000);
    const inicio = fim - cfg.janelaDias * 24 * 60 * 60;

    const { queryId } = await client.send(
      new StartQueryCommand({
        logGroupNames: cfg.logGroups,
        startTime: inicio,
        endTime: fim,
        queryString: query,
        limit: limite,
      }),
    );
    if (!queryId) throw new Error("CloudWatch não devolveu queryId.");

    // Logs Insights é assíncrono: roda em background e a gente busca o resultado.
    for (let tentativa = 0; tentativa < 40; tentativa++) {
      await new Promise((r) => setTimeout(r, 500));
      const res = await client.send(new GetQueryResultsCommand({ queryId }));
      if (res.status === "Complete") return (res.results ?? []).map(sanitize);
      if (res.status === "Failed" || res.status === "Cancelled" || res.status === "Timeout") {
        throw new Error(`Consulta ao CloudWatch terminou como ${res.status}.`);
      }
    }
    throw new Error("Consulta ao CloudWatch não completou a tempo.");
  }

  /** Acha o trace_id a partir de um identificador de domínio, pela linha âncora. */
  async function traceDoIdentificador(identificador: string): Promise<string | null> {
    const id = validarIdentificador(identificador);
    const linhas = await consultar(
      `fields @timestamp, trace_id, xray_trace_id, message
       | filter message like /${id}/
       | filter ispresent(trace_id)
       | sort @timestamp asc
       | limit 5`,
      5,
    );
    return linhas.find((l) => l.trace_id)?.trace_id ?? null;
  }

  /** Todas as linhas de um trace, já recortadas. */
  async function linhasDoTrace(traceId: string, maxLinhas?: number): Promise<LinhaLog[]> {
    const id = validarIdentificador(traceId);
    const limite = Math.min(maxLinhas ?? cfg.maxLinhas, cfg.maxLinhas);
    return consultar(
      `fields @timestamp, level, logger_name, trace_id, xray_trace_id, message
       | filter trace_id = "${id}"
       | sort @timestamp asc
       | limit ${limite}`,
      limite,
    );
  }

  return { traceDoIdentificador, linhasDoTrace };
}
