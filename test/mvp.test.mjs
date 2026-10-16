/**
 * Tools de gestão de evento do MVP (GUE-550): duas leituras, duas escritas, e
 * a redação de dado pessoal valendo para TODAS as tools (GUE-484).
 *
 * As escritas seguem o protocolo de escrita.test.mjs, com uma amarra a mais:
 * o código vale para os ARGUMENTOS. Sem isso, a pessoa confirma "100 ingressos a
 * R$ 10" e o agente executa "10.000 a R$ 0" com o mesmo código.
 */
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EVENTO = "11111111-1111-1111-1111-111111111111";

async function comApiFalsa(roteador, fn) {
  const recebidos = [];
  const auditoria = [];
  const server = http.createServer((req, res) => {
    let corpo = "";
    req.on("data", (c) => (corpo += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://localhost");
      const pedido = { method: req.method, url, body: corpo ? JSON.parse(corpo) : undefined };
      recebidos.push(pedido);
      const resposta = roteador(pedido) ?? {};
      res.writeHead(resposta.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(resposta.body ?? {}));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...process.env,
      GUEDDER_MCP_TRANSPORT: "stdio",
      GUEDDER_API_BASE: `http://127.0.0.1:${port}`,
      GUEDDER_BEARER_TOKEN: "token-de-teste",
    },
    stderr: "pipe",
  });
  transport.stderr.on("data", (c) => {
    for (const linha of String(c).split("\n")) if (linha.startsWith('{"audit"')) auditoria.push(JSON.parse(linha));
  });
  const client = new Client({ name: "mvp-test", version: "0" });
  try {
    await client.connect(transport);
    await fn(client, recebidos, auditoria);
  } finally {
    await client.close();
    await new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
}

const posts = (recebidos) => recebidos.filter((r) => r.method === "POST");
const codigoDe = (r) => r.content[0].text.match(/confirmacao="([A-Z0-9]+)"/)?.[1];

/** Validação de schema pode voltar como isError ou como exceção, conforme a versão do SDK. */
async function chamar(client, name, args) {
  try {
    return await client.callTool({ name, arguments: args });
  } catch (e) {
    return { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] };
  }
}

const pagina = (content, totalPages = 1) => ({ body: { content, page: { size: 100, number: 0, totalPages } } });

// ── guedder_ingressos_vendidos_periodo ──────────────────────────────────────

test("vendidos no período soma por dia e põe 0 no dia sem linha", async () => {
  await comApiFalsa(
    () => ({
      body: {
        code: "C002",
        data: {
          nomeEvento: "Festa",
          vendasList: [
            { dataCompra: "2026-10-03", ingressosPagos: 5, visualizacoes: 1 },
            { dataCompra: "2026-10-01", ingressosPagos: 2, visualizacoes: 1 },
            { dataCompra: "2026-09-30", ingressosPagos: 9, visualizacoes: 1 },
          ],
        },
        page: { totalPages: 1 },
      },
    }),
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_ingressos_vendidos_periodo", {
        eventoId: EVENTO,
        de: "2026-10-01",
        ate: "2026-10-03",
      });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      const res = r.structuredContent.result;
      assert.equal(res.totalIngressosPagos, 7, "o 30/09 está fora do período");
      assert.deepEqual(res.porDia, [
        { data: "2026-10-01", ingressosPagos: 2 },
        { data: "2026-10-02", ingressosPagos: 0 },
        { data: "2026-10-03", ingressosPagos: 5 },
      ]);
      assert.equal(recebidos.length, 1);
      assert.equal(recebidos[0].url.pathname, `/api/v1/metrica/${EVENTO}/ultimas-vendas`);
      assert.equal(recebidos[0].url.searchParams.get("sort"), "viewId.dataCompra,desc");
    },
  );
});

test("período acima de 31 dias recusa sem chamar a API", async () => {
  await comApiFalsa(
    () => ({}),
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_ingressos_vendidos_periodo", {
        eventoId: EVENTO,
        de: "2026-09-01",
        ate: "2026-10-02",
      });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /31/);
      assert.equal(recebidos.length, 0);
    },
  );
});

// ── guedder_lotes_esgotados ─────────────────────────────────────────────────

test("esgotado ignora lote inativo e não confia em estoqueDisponivel", async () => {
  await comApiFalsa(
    ({ url }) =>
      url.searchParams.get("page") === "0"
        ? pagina(
            [
              { id: "a", nome: "Pista 1", enabled: true, estoqueInicial: 100, ingressosVendidos: 100, estoqueDisponivel: 0 },
              // Inativo: a API devolve estoqueDisponivel 0, mas não está esgotado.
              { id: "b", nome: "Antigo", enabled: false, estoqueInicial: 50, ingressosVendidos: 10, estoqueDisponivel: 0 },
            ],
            2,
          )
        : pagina([{ id: "c", nome: "Pista 2", enabled: true, estoqueInicial: 50, ingressosVendidos: 10, estoqueDisponivel: 40 }], 2),
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_lotes_esgotados", { eventoId: EVENTO });
      assert.notEqual(r.isError, true, r.content?.[0]?.text);
      const res = r.structuredContent.result;
      assert.equal(res.totalLotes, 3, "as duas páginas foram lidas");
      assert.deepEqual(res.esgotados.map((l) => l.id), ["a"]);
      assert.equal(recebidos.length, 2);
      assert.ok(recebidos.every((x) => x.method === "GET" && x.url.pathname === `/api/v1/lote/${EVENTO}`));
    },
  );
});

// ── guedder_criar_lote ──────────────────────────────────────────────────────

const LOTE = {
  eventoId: EVENTO,
  nome: "Retirada VIP",
  estoqueInicial: 100,
  inicioVendas: "2026-11-01T10:00:00-03:00",
  terminoVendas: "2026-11-20T23:59:00-03:00",
};

test("as escritas novas se anunciam como escrita, não destrutivas e não idempotentes", async () => {
  await comApiFalsa(
    () => ({}),
    async (client) => {
      const { tools } = await client.listTools();
      for (const nome of ["guedder_criar_lote", "guedder_criar_cupom"]) {
        const t = tools.find((x) => x.name === nome);
        assert.ok(t, `${nome} tem que existir`);
        assert.equal(t.annotations.readOnlyHint, false);
        assert.equal(t.annotations.destructiveHint, false);
        assert.equal(t.annotations.idempotentHint, false);
      }
    },
  );
});

test("criar lote: resumo não escreve, arg alterado invalida, código certo faz 1 POST", async () => {
  await comApiFalsa(
    ({ method }) => (method === "POST" ? { status: 201, body: { id: "novo", nome: LOTE.nome } } : {}),
    async (client, recebidos) => {
      const resumo = await chamar(client, "guedder_criar_lote", LOTE);
      assert.notEqual(resumo.isError, true, resumo.content[0].text);
      assert.match(resumo.content[0].text, /Retirada VIP/);
      assert.match(resumo.content[0].text, /100 ingressos/);
      assert.match(resumo.content[0].text, /gratuito/);
      const codigo = codigoDe(resumo);
      assert.ok(codigo, resumo.content[0].text);
      assert.equal(recebidos.length, 0, "a fase de resumo não toca na API");

      const trocado = await chamar(client, "guedder_criar_lote", { ...LOTE, estoqueInicial: 10000, confirmacao: codigo });
      assert.equal(trocado.isError, true);
      assert.match(trocado.content[0].text, /confirmaç/i);
      assert.equal(posts(recebidos).length, 0, "código do lote de 100 não cria o de 10.000");

      const r = await chamar(client, "guedder_criar_lote", { ...LOTE, confirmacao: codigo });
      assert.notEqual(r.isError, true, r.content[0].text);
      assert.equal(posts(recebidos).length, 1, "exatamente um POST");
      const [post] = posts(recebidos);
      assert.equal(post.url.pathname, `/api/v1/lote/${EVENTO}/adicionar`);
      assert.deepEqual(post.body, {
        nome: "Retirada VIP",
        estoqueInicial: 100,
        precoUnitario: 0,
        inicioVendas: LOTE.inicioVendas,
        terminoVendas: LOTE.terminoVendas,
        privado: false,
        enabled: true,
        ativo: true,
        compraMinima: 1,
        limitarPorCpf: false,
        aplicavelEmTodosOsSetores: true,
        usoDeCupomObrigatorio: false,
        ocultarValor: false,
        taxaAmortecidaPeloProdutor: false,
        selfCheckinHabilitado: false,
        setores: [],
        janelasCheckin: [],
      });
    },
  );
});

test("criar lote com data sem offset recusa e não escreve", async () => {
  await comApiFalsa(
    () => ({}),
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_criar_lote", { ...LOTE, inicioVendas: "2026-11-01T10:00:00" });
      assert.equal(r.isError, true);
      assert.equal(recebidos.length, 0);
    },
  );
});

test("criar lote com nome duplicado devolve mensagem clara", async () => {
  await comApiFalsa(
    ({ method }) =>
      method === "POST"
        ? { status: 400, body: { status: 400, detail: "Já existe um lote com este nome neste evento." } }
        : {},
    async (client) => {
      const codigo = codigoDe(await chamar(client, "guedder_criar_lote", LOTE));
      const r = await chamar(client, "guedder_criar_lote", { ...LOTE, confirmacao: codigo });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Já existe um lote chamado "Retirada VIP"/);
    },
  );
});

// ── guedder_criar_cupom ─────────────────────────────────────────────────────

const LOTES_DO_EVENTO = pagina([
  { id: "l-pista", nome: "Pista", enabled: true, estoqueInicial: 10, ingressosVendidos: 0 },
  { id: "l-camarote", nome: "Camarote", enabled: true, estoqueInicial: 10, ingressosVendidos: 0 },
]);

const CUPOM = { eventoId: EVENTO, nome: "AMIGOS10", tipoDesconto: "PERCENTUAL", valorDesconto: 10, limite: 50, lotes: [" pista "] };

test("criar cupom resolve nome de lote, e só o código certo com os mesmos args faz 1 POST", async () => {
  await comApiFalsa(
    ({ method }) => (method === "POST" ? { status: 201, body: { id: "c1", nome: "AMIGOS10" } } : LOTES_DO_EVENTO),
    async (client, recebidos) => {
      const resumo = await chamar(client, "guedder_criar_cupom", CUPOM);
      assert.notEqual(resumo.isError, true, resumo.content[0].text);
      assert.match(resumo.content[0].text, /"Pista"/, "o resumo mostra o lote resolvido");
      assert.match(resumo.content[0].text, /10%/);
      const codigo = codigoDe(resumo);
      assert.equal(posts(recebidos).length, 0);

      const trocado = await chamar(client, "guedder_criar_cupom", { ...CUPOM, valorDesconto: 90, confirmacao: codigo });
      assert.equal(trocado.isError, true);
      assert.equal(posts(recebidos).length, 0, "código de 10% não cria cupom de 90%");

      const r = await chamar(client, "guedder_criar_cupom", { ...CUPOM, confirmacao: codigo });
      assert.notEqual(r.isError, true, r.content[0].text);
      assert.equal(posts(recebidos).length, 1);
      const [post] = posts(recebidos);
      assert.equal(post.url.pathname, `/api/v1/cupom/${EVENTO}`);
      assert.deepEqual(post.body, {
        nome: "AMIGOS10",
        tipoDesconto: "PERCENTUAL",
        valorDesconto: 10,
        limite: 50,
        lotes: [{ id: "l-pista", nome: "Pista" }],
        aplicavelEmTodosOsLotes: false,
        ativo: true,
        limitarUmaCompraPorUsuario: true,
        limitarUmIngressoPorCompra: true,
      });
    },
  );
});

test("criar cupom com lote inexistente não escreve em nenhuma fase", async () => {
  await comApiFalsa(
    () => LOTES_DO_EVENTO,
    async (client, recebidos) => {
      const args = { ...CUPOM, lotes: ["Pista", "Backstage"] };
      const r = await chamar(client, "guedder_criar_cupom", args);
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /"Backstage"/);
      assert.match(r.content[0].text, /"Camarote"/, "lista os lotes que existem");
      const forcado = await chamar(client, "guedder_criar_cupom", { ...args, confirmacao: "AAAAAAAAAA" });
      assert.equal(forcado.isError, true);
      assert.equal(posts(recebidos).length, 0);
    },
  );
});

test("cupom sem lotes vale para todos, explicitamente", async () => {
  await comApiFalsa(
    ({ method }) => (method === "POST" ? { status: 201, body: { id: "c2" } } : LOTES_DO_EVENTO),
    async (client, recebidos) => {
      const args = { eventoId: EVENTO, nome: "GERAL", tipoDesconto: "VALOR", valorDesconto: 15 };
      const resumo = await chamar(client, "guedder_criar_cupom", args);
      assert.match(resumo.content[0].text, /todos os lotes/);
      assert.match(resumo.content[0].text, /sem limite de usos/);
      await chamar(client, "guedder_criar_cupom", { ...args, confirmacao: codigoDe(resumo) });
      assert.equal(recebidos.filter((x) => x.method === "GET").length, 0, "sem nomes, nem lista os lotes");
      const [post] = posts(recebidos);
      assert.equal(post.body.aplicavelEmTodosOsLotes, true);
      assert.deepEqual(post.body.lotes, []);
    },
  );
});

test("cupom percentual acima de 100 recusa sem escrever", async () => {
  await comApiFalsa(
    () => LOTES_DO_EVENTO,
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_criar_cupom", { ...CUPOM, valorDesconto: 150 });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /0 a 100/);
      assert.equal(posts(recebidos).length, 0);
    },
  );
});

test("cupom com nome duplicado (409) devolve mensagem clara", async () => {
  await comApiFalsa(
    ({ method }) => (method === "POST" ? { status: 409, body: { detail: "Já existe um cupom com este nome." } } : LOTES_DO_EVENTO),
    async (client) => {
      const codigo = codigoDe(await chamar(client, "guedder_criar_cupom", CUPOM));
      const r = await chamar(client, "guedder_criar_cupom", { ...CUPOM, confirmacao: codigo });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Já existe um cupom chamado "AMIGOS10"/);
    },
  );
});

test("429 da API vira instrução de esperar, não erro cru", async () => {
  await comApiFalsa(
    () => ({ status: 429, body: {} }),
    async (client) => {
      const r = await chamar(client, "guedder_lotes_esgotados", { eventoId: EVENTO });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /30 a cada 10 segundos/);
    },
  );
});

// ── Redação em todas as tools (GUE-484) ─────────────────────────────────────

// Resposta única que serve de forma a qualquer tool e carrega dado pessoal em
// todo lugar onde uma tool poderia repassá-lo.
const COM_PII = {
  cpf: "SEGREDO-cpf",
  email: "SEGREDO-email",
  telefone: "SEGREDO-tel",
  content: [
    {
      idPedido: "P1",
      codigo: "SEGREDO-ingresso",
      nomePortador: "SEGREDO-portador",
      status: "ATIVO",
      nomeEvento: "Show",
      id: "l1",
      nome: "Pista",
      enabled: true,
      estoqueInicial: 1,
      ingressosVendidos: 0,
      comprador: { cpf: "SEGREDO-cpf2", numeroCartao: "SEGREDO-cartao" },
    },
  ],
  data: { vendasList: [], comprador: { email: "SEGREDO-email2" } },
  page: { totalPages: 1 },
};

const ARGS_POR_TOOL = {
  guedder_detalhes_evento: { eventoId: EVENTO, incluir: ["atracoes", "lotes", "venda"] },
  guedder_status_da_compra: { identificador: "P1" },
  guedder_ingressos_vendidos_periodo: { eventoId: EVENTO },
  guedder_criar_lote: LOTE,
  guedder_criar_cupom: { eventoId: EVENTO, nome: "X", tipoDesconto: "VALOR", valorDesconto: 1 },
  guedder_cancelar_pedido: { pedidoId: "P1" },
};

function argsDeAmostra(schema) {
  const out = {};
  for (const [nome, prop] of Object.entries(schema.properties ?? {})) {
    if (nome === "confirmacao") continue;
    if (prop.type === "integer" || prop.type === "number") out[nome] = 1;
    else if (prop.format === "uuid") out[nome] = EVENTO;
    else if (prop.type === "array") out[nome] = ["amostra"];
    else out[nome] = "amostra";
  }
  return out;
}

test("nenhuma tool devolve dado pessoal", async () => {
  await comApiFalsa(
    () => ({ body: COM_PII }),
    async (client) => {
      const { tools } = await client.listTools();
      assert.ok(tools.length >= 20, `esperava todas as tools, vieram ${tools.length}`);
      for (const tool of tools) {
        const r = await chamar(client, tool.name, ARGS_POR_TOOL[tool.name] ?? argsDeAmostra(tool.inputSchema));
        assert.notEqual(r.isError, true, `${tool.name}: ${r.content?.[0]?.text}`);
        const saida = JSON.stringify([r.content, r.structuredContent]);
        assert.doesNotMatch(saida, /SEGREDO/, `${tool.name} vazou dado pessoal`);
      }
    },
  );
});

// ── Correções do review do PR #19 ───────────────────────────────────────────

test("confirmação não-ASCII é código inválido, auditado, e não escreve", async () => {
  await comApiFalsa(
    () => ({}),
    async (client, recebidos, auditoria) => {
      const r = await chamar(client, "guedder_cancelar_pedido", { pedidoId: "ped1", confirmacao: "ÁÁÁÁÁÁÁÁÁÁ" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Confirmação inválida/);
      assert.equal(recebidos.length, 0);
      await new Promise((ok) => setTimeout(ok, 50));
      assert.ok(auditoria.some((l) => l.fase === "codigo_invalido" && l.tool === "guedder_cancelar_pedido"), JSON.stringify(auditoria));
    },
  );
});

test("id com '..' não vira segmento de path", async () => {
  await comApiFalsa(
    () => ({}),
    async (client, recebidos) => {
      const chamadas = [
        ["guedder_lotes_esgotados", { eventoId: ".." }],
        ["guedder_criar_lote", { ...LOTE, eventoId: ".." }],
        ["guedder_criar_cupom", { ...CUPOM, eventoId: "../../v3/pedidos" }],
        ["guedder_cancelar_pedido", { pedidoId: ".." }],
        ["guedder_detalhes_evento", { eventoId: ".." }],
        ["guedder_get_lote", { codigoOrEventoId: "..", codigoOrLoteId: "x" }],
      ];
      for (const [nome, args] of chamadas) {
        const r = await chamar(client, nome, args);
        assert.equal(r.isError, true, `${nome} aceitou ${JSON.stringify(args)}`);
      }
      assert.equal(recebidos.length, 0);
    },
  );
});

test("corpo de erro da API passa pela redação antes de chegar ao modelo", async () => {
  await comApiFalsa(
    ({ method }) =>
      method === "POST"
        ? { status: 400, body: { detail: "Falhou para fulano@x.com", comprador: { cpf: "SEGREDO-cpf", email: "SEGREDO-mail" } } }
        : {},
    async (client) => {
      const codigo = codigoDe(await chamar(client, "guedder_criar_lote", LOTE));
      const r = await chamar(client, "guedder_criar_lote", { ...LOTE, confirmacao: codigo });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /-> 400/);
      assert.doesNotMatch(r.content[0].text, /SEGREDO|fulano@x\.com/);
    },
  );
});

test("cupom: lote recriado ou renomeado entre as fases não executa", async () => {
  let lotes = [{ id: "l-pista", nome: "Pista", enabled: true, estoqueInicial: 10, ingressosVendidos: 0 }];
  await comApiFalsa(
    ({ method }) => (method === "POST" ? { status: 201, body: {} } : pagina(lotes)),
    async (client, recebidos) => {
      const resumo = await chamar(client, "guedder_criar_cupom", CUPOM);
      assert.match(resumo.content[0].text, /l-pista/, "o resumo mostra o id que vai ser usado");
      const codigo = codigoDe(resumo);

      // Recriado: mesmo nome, outro id.
      lotes = [{ ...lotes[0], id: "l-pista-novo" }];
      const recriado = await chamar(client, "guedder_criar_cupom", { ...CUPOM, confirmacao: codigo });
      assert.equal(recriado.isError, true);
      assert.match(recriado.content[0].text, /Confirmação inválida/);

      // Renomeado: o nome pedido deixa de existir.
      lotes = [{ ...lotes[0], id: "l-pista", nome: "Pista VIP" }];
      const renomeado = await chamar(client, "guedder_criar_cupom", { ...CUPOM, confirmacao: codigo });
      assert.equal(renomeado.isError, true);

      assert.equal(posts(recebidos).length, 0);
    },
  );
});

test("lote sem estoqueInicial não conta como esgotado", async () => {
  await comApiFalsa(
    () => pagina([{ id: "x", nome: "Sem estoque", enabled: true, ingressosVendidos: 0 }]),
    async (client) => {
      const r = await chamar(client, "guedder_lotes_esgotados", { eventoId: EVENTO });
      assert.deepEqual(r.structuredContent.result.esgotados, []);
    },
  );
});

test("recusa na fase de preparo é auditada", async () => {
  await comApiFalsa(
    () => LOTES_DO_EVENTO,
    async (client, recebidos, auditoria) => {
      const r = await chamar(client, "guedder_criar_cupom", { ...CUPOM, lotes: ["Backstage"] });
      assert.equal(r.isError, true);
      await new Promise((ok) => setTimeout(ok, 50));
      const linha = auditoria.find((l) => l.fase === "recusado");
      assert.ok(linha, JSON.stringify(auditoria));
      assert.equal(linha.tool, "guedder_criar_cupom");
      assert.equal(linha.eventoId, EVENTO);
      assert.equal(posts(recebidos).length, 0);
    },
  );
});

test("dia inexistente no calendário é recusado, não rola para outro dia", async () => {
  await comApiFalsa(
    () => ({}),
    async (client, recebidos) => {
      const periodo = await chamar(client, "guedder_ingressos_vendidos_periodo", { eventoId: EVENTO, de: "2026-02-30", ate: "2026-03-01" });
      assert.equal(periodo.isError, true);
      const lote = await chamar(client, "guedder_criar_lote", { ...LOTE, inicioVendas: "2026-02-30T10:00:00-03:00" });
      assert.equal(lote.isError, true);
      const hora = await chamar(client, "guedder_criar_lote", { ...LOTE, inicioVendas: "2026-11-01T25:00:00-03:00" });
      assert.equal(hora.isError, true);
      assert.equal(recebidos.length, 0);
    },
  );
});

test("histórico longo demais para no teto de páginas com mensagem clara", async () => {
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date());
  await comApiFalsa(
    () => ({ body: { data: { vendasList: [{ dataCompra: hoje, ingressosPagos: 1 }] }, page: { totalPages: 999 } } }),
    async (client, recebidos) => {
      const r = await chamar(client, "guedder_ingressos_vendidos_periodo", { eventoId: EVENTO, de: "2020-01-01", ate: "2020-01-02" });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /20 páginas/);
      assert.equal(recebidos.length, 20);
    },
  );
});
