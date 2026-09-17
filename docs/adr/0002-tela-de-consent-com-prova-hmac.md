# ADR 0002 — A tela de consent é servida pelo MCP, e a autorização do redirect é uma prova HMAC

**Status**: Aceito — 2026-09-16
**Depende de**: ADR 0001 deste repo (o MCP é o front door do `/authorize`)
**Contexto maior**: ADR 0001 §9.11 do repo `auth`

## Contexto

Enquanto o público do MCP era o time, autorização era institucional: a pessoa
logava e o servidor decidia o que ela alcançava. Quando o agente passou a
atender usuário final **e a agir na conta da pessoa** (cancelar pedido), essa
premissa caiu. A pessoa precisa ver e escolher o que entrega ao agente.

O Cognito **não tem tela de consent por escopo**. Conferido na doc da AWS: se o
escopo está no `allowed_oauth_scopes` do app client e o cliente pede, ele emite
sem perguntar nada; `prompt=consent` só é repassado a IdP externo. O app client
autoriza uma vez, para todos os usuários.

## Decisão

**A tela vive neste servidor**, em `GET /authorize`, antes do redirect ao
Cognito. Ela não é enfeite: o que ela produz é o `scope` que segue para o
Cognito, calculado como **interseção** entre o que a pessoa marcou e o que este
servidor anuncia (`GUEDDER_MCP_SCOPES`).

Regras da implementação que são parte da decisão:

- **Todo parâmetro do pedido original atravessa a tela como `hidden`** (PKCE,
  `state`, `redirect_uri`): perder qualquer um quebra o retorno do OAuth.
- **Escopos de identidade** (`openid`, `email`, `profile`, `phone`) não são
  marcáveis — vão como `hidden`. Desmarcá-los não daria uma conexão mais
  restrita, daria uma conexão que não funciona.
- **`openid` é garantido em código**, não só no formulário. `GUEDDER_MCP_SCOPES`
  espelha o Terraform, e listar ali só os escopos customizados é erro plausível;
  sem `openid` não vem `email`, e o verifier recusa todo token com "Token sem
  email" — falha que só aparece no login real.
- **O valor do checkbox é o nome completo** (prefixado pelo resource server, que
  é o que o Cognito entende) e o rótulo é o nome curto com uma frase em
  português. Escopo sem frase aparece pelo nome cru, de propósito: escopo novo
  sem explicação é permissão concedida sem entendimento.
- **`resource=` (RFC 8707)** é acrescentado no redirect. É o que faz o access
  token sair com `aud`.

### O parâmetro que autoriza o redirect é uma prova, não um literal

`consentido` é um **HMAC-SHA256** de
`client_id | redirect_uri | state | code_challenge | bloco de 10 minutos`,
emitido só ao renderizar a tela, comparado com `timingSafeEqual`, aceitando o
bloco atual e o anterior (a pessoa está lendo a tela nesse meio tempo, e
expirar no meio da leitura é pior que aceitar uma prova de dez minutos).

**Lição, não só solução.** A primeira versão usava o literal `consentido=1`.
Quem monta a URL do `/authorize` é o cliente MCP: bastava acrescentar o
parâmetro para o servidor conceder sem nunca renderizar a tela, e a pessoa
veria só o login do Cognito, que não exibe escopo nenhum. A tela inteira ficava
pulável por uma linha, e o bug foi pego numa revisão de código, não por teste
ou por incidente. Generalizando: **em qualquer gate cujo input é montado por
quem está sendo gateado, um literal não é gate.** O parâmetro precisa ser algo
que o cliente não consiga escrever sozinho.

## Alternativas consideradas

- **Nonce de uso único em banco/cache.** Não compra o que parece comprar: a
  tela é pública, então o cliente pode buscá-la para obter um nonce fresco. Em
  troca somaria estado a um servidor stateless.
- **Confiar no consent do Cognito.** Não existe (ver Contexto).
- **Gravar o consent no domínio** (`ConcessaoPermissaoIndividual` com
  `origem=OAUTH_CONSENT`). O seam existe no `guedder-api` e continua sem
  writer. Só passa a fazer falta quando o consent precisar conceder permissão
  que a pessoa **ainda não tem** num evento — que é soma, não recorte.
  Enquanto o agente só pode fazer menos do que a pessoa já podia, o token
  basta.

## Consequências

- Escopo forjado na query não vira concessão; há teste para isso.
- **Teto conhecido, e é preciso dizê-lo com todas as letras**: a tela é camada
  de autorização, não barreira criptográfica. (1) Sendo pública, um cliente
  determinado pode buscá-la, extrair a prova e repeti-la sem mostrá-la a
  ninguém. (2) O app client é público (PKCE, sem secret), então o `client_id`
  não é segredo e dá para ir direto ao `/authorize` do Cognito, contornando
  este servidor. O HMAC eleva a barra de "somar um parâmetro" para "buscar e
  repetir", e fecha o caso do cliente que pula por descuido — não o do cliente
  deliberado.
- O que limita o estrago continua sendo a lista de escopos do app client e a de
  `callback_urls`.
- **O que fecharia os dois tetos**: tornar o app client confidencial, com o
  secret só neste servidor, e o MCP passar a emitir a própria sessão. O molde
  já existe na casa: `CheckinSessionTokenService` no `guedder-api` (JWT RS256,
  escopos calculados na emissão e congelados, `aud` amarrado ao serviço, TTL
  curto, sem revogação como tradeoff assumido). É o passo para quando aparecer
  cliente de terceiro de fato não confiável, e não se paga enquanto o cliente é
  o plugin da própria Guedder.
- O segredo do HMAC é por processo. Com mais de uma réplica, a prova emitida
  numa não vale na outra e a pessoa reabre a tela.
