/**
 * Cobre as duas regras da auditoria que são decisão de arquitetura, não detalhe:
 * consulta sempre por identificador (nunca janela livre) e resposta com campos allowlisted.
 * Ver ADR 0001 §9.6 do repo auth.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { criarAuditoria, validarIdentificador } from "../dist/auditoria.js";

/** Dublê do cliente CloudWatch: registra as queries e devolve um resultado fixo. */
function clienteFalso(results) {
  const queries = [];
  return {
    queries,
    send: async (cmd) => {
      const nome = cmd.constructor.name;
      if (nome === "StartQueryCommand") {
        queries.push(cmd.input);
        return { queryId: "q-1" };
      }
      return { status: "Complete", results };
    },
  };
}

const cfgBase = { logGroups: ["/ecs/guedder"], region: "us-west-2", maxLinhas: 100, janelaDias: 30 };

test("descarta campo fora do allowlist", async () => {
  const client = clienteFalso([
    [
      { field: "@timestamp", value: "2026-08-17 12:10:56" },
      { field: "message", value: "Pedido criado | id_pedido=ABC" },
      { field: "trace_id", value: "6a832480d124b467bf30f56bfe5f8faa" },
      { field: "cpf_comprador", value: "123.456.789-00" },
      { field: "@ptr", value: "ponteiro-interno" },
    ],
  ]);
  const auditoria = criarAuditoria({ ...cfgBase, client });

  const linhas = await auditoria.linhasDoTrace("6a832480d124b467bf30f56bfe5f8faa");

  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].trace_id, "6a832480d124b467bf30f56bfe5f8faa");
  assert.ok(!("cpf_comprador" in linhas[0]), "PII não pode sair do módulo");
  assert.ok(!("@ptr" in linhas[0]));
});

test("busca por trace é filtro exato, não varredura", async () => {
  const client = clienteFalso([]);
  const auditoria = criarAuditoria({ ...cfgBase, client });

  await auditoria.linhasDoTrace("6a832480d124b467bf30f56bfe5f8faa");

  const q = client.queries[0].queryString;
  assert.match(q, /filter trace_id = "6a832480d124b467bf30f56bfe5f8faa"/);
  assert.doesNotMatch(q, /@timestamp\s*[<>]/, "não pode filtrar por janela livre");
});

test("respeita o teto de linhas mesmo se pedirem mais", async () => {
  const client = clienteFalso([]);
  const auditoria = criarAuditoria({ ...cfgBase, maxLinhas: 10, client });

  await auditoria.linhasDoTrace("6a832480d124b467bf30f56bfe5f8faa", 9999);

  assert.equal(client.queries[0].limit, 10);
});

test("identificador com curinga é recusado antes de virar regex", () => {
  assert.throws(() => validarIdentificador(".*"), /Identificador inválido/);
  assert.throws(() => validarIdentificador("a b"), /Identificador inválido/);
  assert.throws(() => validarIdentificador("ab"), /Identificador inválido/);
  assert.equal(validarIdentificador(" ABC-123_x "), "ABC-123_x");
});

test("acha o trace pela linha âncora do pedido", async () => {
  const client = clienteFalso([
    [
      { field: "trace_id", value: "aaaa1111bbbb2222cccc3333dddd4444" },
      { field: "message", value: "Pedido criado | id_pedido=PED-9 | compra_id=uuid" },
    ],
  ]);
  const auditoria = criarAuditoria({ ...cfgBase, client });

  const trace = await auditoria.traceDoIdentificador("PED-9");

  assert.equal(trace, "aaaa1111bbbb2222cccc3333dddd4444");
  assert.match(client.queries[0].queryString, /filter message like \/PED-9\//);
});

test("consulta falha alto quando o CloudWatch falha", async () => {
  const client = {
    send: async (cmd) =>
      cmd.constructor.name === "StartQueryCommand"
        ? { queryId: "q-1" }
        : { status: "Failed" },
  };
  const auditoria = criarAuditoria({ ...cfgBase, client });

  await assert.rejects(
    () => auditoria.linhasDoTrace("6a832480d124b467bf30f56bfe5f8faa"),
    /terminou como Failed/,
  );
});
