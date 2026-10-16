/**
 * As peças puras de src/escrita.ts: código de confirmação e redação.
 * Os fluxos de ponta a ponta estão em escrita.test.mjs e mvp.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { codigoDeConfirmacao, confirmacaoConfere, redigir } from "../dist/escrita.js";

const PESSOA = { token: "t", email: "a@b.c", usuarioId: "u-1", isAdmin: false, scopes: [] };
const ARGS = { eventoId: "e-1", nome: "Pista", estoqueInicial: 100 };

test("o código amarra operação, alvo, argumentos e pessoa", () => {
  const base = codigoDeConfirmacao("op", "e-1", ARGS, PESSOA);
  assert.match(base, /^[A-Z0-9]{10}$/);
  assert.notEqual(codigoDeConfirmacao("outra-op", "e-1", ARGS, PESSOA), base);
  assert.notEqual(codigoDeConfirmacao("op", "e-2", ARGS, PESSOA), base);
  assert.notEqual(codigoDeConfirmacao("op", "e-1", { ...ARGS, estoqueInicial: 10000 }, PESSOA), base);
  assert.notEqual(codigoDeConfirmacao("op", "e-1", ARGS, { ...PESSOA, usuarioId: "u-2" }), base);
});

test("a ordem das chaves não muda o código", () => {
  const invertido = { estoqueInicial: 100, nome: "Pista", eventoId: "e-1" };
  assert.equal(codigoDeConfirmacao("op", "e-1", invertido, PESSOA), codigoDeConfirmacao("op", "e-1", ARGS, PESSOA));
});

test("vale o bloco de 10 min atual e o anterior, não o de antes", () => {
  const anterior = codigoDeConfirmacao("op", "e-1", ARGS, PESSOA, 1);
  const velho = codigoDeConfirmacao("op", "e-1", ARGS, PESSOA, 2);
  assert.equal(confirmacaoConfere(codigoDeConfirmacao("op", "e-1", ARGS, PESSOA), "op", "e-1", ARGS, PESSOA), true);
  assert.equal(confirmacaoConfere(anterior, "op", "e-1", ARGS, PESSOA), true);
  assert.equal(confirmacaoConfere(velho, "op", "e-1", ARGS, PESSOA), false);
  assert.equal(confirmacaoConfere(undefined, "op", "e-1", ARGS, PESSOA), false);
  assert.equal(confirmacaoConfere("curto", "op", "e-1", ARGS, PESSOA), false);
});

test("redigir mascara dado pessoal em qualquer profundidade", () => {
  const r = redigir({
    data: {
      vendas: [{ comprador: { cpf: "111", Email: "x@y.z", telefone: "11", nomePortador: "Fulano" } }],
      pagamento: { numeroCartao: "4111", cvv: "123" },
    },
    nulo: { cpf: null },
  });
  const texto = JSON.stringify(r);
  for (const segredo of ["111", "x@y.z", "Fulano", "4111", "123"]) {
    assert.doesNotMatch(texto, new RegExp(segredo.replace(".", "\\.")), `${segredo} vazou`);
  }
  assert.equal(r.nulo.cpf, null, "null continua null: redigido sugeriria que havia valor");
});

test("codigo só é mascarado em objeto com cara de ingresso", () => {
  const r = redigir({
    lote: { id: "l1", codigo: "pista-1" },
    evento: { codigo: "festa-x" },
    ingresso: { idPedido: "p1", codigo: "ING-SECRETO" },
  });
  assert.equal(r.lote.codigo, "pista-1");
  assert.equal(r.evento.codigo, "festa-x");
  assert.equal(r.ingresso.codigo, "[redigido]");
  assert.equal(r.ingresso.idPedido, "p1");
});
