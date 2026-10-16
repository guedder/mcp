/**
 * As peças puras de src/escrita.ts: código de confirmação e redação.
 * Os fluxos de ponta a ponta estão em escrita.test.mjs e mvp.test.mjs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { codigoDeConfirmacao, confirmacaoConfere, hmacDeConsent, jsonCanonico, redigir } from "../dist/escrita.js";

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
      checkin: [{ nomeParticipante: "Beltrano", fotoComprador: "https://s3/foto.jpg" }],
      pagamento: { numeroCartao: "4111", cvv: "123" },
    },
    nulo: { cpf: null },
  });
  const texto = JSON.stringify(r);
  for (const segredo of ["111", "x@y.z", "Fulano", "Beltrano", "s3/foto", "4111", "123"]) {
    assert.doesNotMatch(texto, new RegExp(segredo.replace(".", "\\.")), `${segredo} vazou`);
  }
  assert.equal(r.nulo.cpf, null, "null continua null: redigido sugeriria que havia valor");
});

test("codigo é redigido por padrão e só fica visível em lote ou evento", () => {
  const r = redigir({
    lote: { id: "l1", codigo: "pista-1", estoqueInicial: 10 },
    evento: { codigo: "festa-x", dataInicio: "2026-11-01T20:00:00-03:00" },
    ingresso: { idPedido: "p1", codigo: "ING-SECRETO" },
    // Formato novo de ingresso, sem nenhum marcador conhecido: não pode vazar.
    semMarcador: { codigo: "ING-SEM-MARCADOR", status: "ATIVO" },
    // Ingresso que carrega a data do evento: marcador de ingresso vence.
    ingressoComData: { ingressoId: "i1", codigo: "ING-COM-DATA", dataInicio: "2026-11-01" },
  });
  assert.equal(r.lote.codigo, "pista-1");
  assert.equal(r.evento.codigo, "festa-x");
  assert.equal(r.ingresso.codigo, "[redigido]");
  assert.equal(r.ingresso.idPedido, "p1");
  assert.equal(r.semMarcador.codigo, "[redigido]");
  assert.equal(r.ingressoComData.codigo, "[redigido]");
});

test("redigir mascara e-mail e CPF em texto livre", () => {
  const r = redigir({ message: "compra de fulano@x.com.br, cpf 123.456.789-09, pedido 12345678901" });
  assert.equal(r.message, "compra de [redigido], cpf [redigido], pedido 12345678901");
});

test("confirmação com caracteres não-ASCII é recusada, não lança", () => {
  // 10 caracteres, 20 bytes: com a comparação por .length o timingSafeEqual lançava.
  assert.doesNotThrow(() => confirmacaoConfere("ÁÁÁÁÁÁÁÁÁÁ", "op", "e-1", ARGS, PESSOA));
  assert.equal(confirmacaoConfere("ÁÁÁÁÁÁÁÁÁÁ", "op", "e-1", ARGS, PESSOA), false);
  assert.equal(confirmacaoConfere("abcdefghij", "op", "e-1", ARGS, PESSOA), false);
});

// Review do #19 (Codex): com a mesma chave, a tela de consent pública devolvia
// em `consentido` o HMAC que a escrita espera. Réplica do ataque: o cliente põe
// op/alvo/args/usuário nos quatro campos da prova e transforma o digest.
test("a prova de consent não serve de código de confirmação", () => {
  const comoCodigo = (d) => d.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 10);
  const forjado = comoCodigo(hmacDeConsent(["op", "e-1", jsonCanonico(ARGS), "u-1"]));
  assert.equal(confirmacaoConfere(forjado, "op", "e-1", ARGS, PESSOA), false);
  assert.notEqual(forjado, codigoDeConfirmacao("op", "e-1", ARGS, PESSOA));
});

test("nome de pessoa em ingresso é redigido; nome de lote e de evento, não", () => {
  const r = redigir({
    // Forma documentada de IngressoAssentoVO (guedder_meus_ingressos).
    ingresso: { ingressoId: "i1", nome: "Fulana de Tal", nomeLote: "Pista", nomeEvento: "Show", codigo: "ING-1" },
    lote: { id: "l1", nome: "Pista", estoqueInicial: 10 },
    evento: { id: "e1", nome: "Show", dataInicio: "2026-11-01" },
  });
  assert.equal(r.ingresso.nome, "[redigido]");
  assert.equal(r.ingresso.codigo, "[redigido]");
  assert.equal(r.ingresso.nomeLote, "Pista");
  assert.equal(r.ingresso.nomeEvento, "Show");
  assert.equal(r.lote.nome, "Pista");
  assert.equal(r.evento.nome, "Show");
});

test("repasse sai sem chave PIX nem titular", () => {
  // Forma documentada de EventoResumoRepasse (guedder_listar_resumo_repasses_eventos).
  const r = redigir({ eventoId: "e1", nome: "Show", totalVendido: 10, chavePix: "f@x.com", favorecido: "Fulana de Tal" });
  assert.equal(r.chavePix, "[redigido]");
  assert.equal(r.favorecido, "[redigido]");
  assert.equal(r.nome, "Show");
  assert.equal(r.totalVendido, 10);
});

test("perfil do usuário logado sai sem dado pessoal; atração mantém nome e foto", () => {
  // Forma documentada de UsuarioEntity (guedder_usuario_logado).
  const r = redigir({
    perfil: {
      id: "u1", nome: "Fulana", sobrenome: "de Tal", email: "f@x.com", cpf: "1", telefone: "2",
      fotoUrl: "https://x/f.jpg", dataNascimento: "1990-01-01", nacionalidade: "BR",
      identidadeGenero: "F", endereco: { rua: "R" }, role: "PRODUTOR", canManageEvents: true,
    },
    atracao: { id: "a1", nome: "Banda X", fotoUrl: "https://x/banda.jpg" },
  });
  for (const k of ["nome", "sobrenome", "email", "cpf", "telefone", "fotoUrl", "dataNascimento", "nacionalidade", "identidadeGenero", "endereco"]) {
    assert.equal(r.perfil[k], "[redigido]", `${k} vazou`);
  }
  assert.equal(r.perfil.role, "PRODUTOR");
  assert.equal(r.perfil.canManageEvents, true);
  assert.equal(r.atracao.nome, "Banda X");
  assert.equal(r.atracao.fotoUrl, "https://x/banda.jpg");
});
