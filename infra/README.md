# Infra do servidor MCP

## Política da task (`task-policy.json`)

Permissões que a role de execução do servidor MCP precisa para a tool
`guedder_rastrear_compra`. Nenhuma outra tool toca a AWS — as demais falam com a API Guedder
usando o token do próprio usuário.

Ela é deliberadamente estreita, e o motivo está no ADR 0001 §9.7 do repo `auth`: essas tools
**não agem como o usuário**, usam a credencial da task. Nenhuma proteção do domínio
(`@Permissao`, evaluator, papéis) está no caminho, então o IAM é a única coisa que limita
*quais* log groups alguém alcança. `logs:*` na conta daria mais do que a face administrativa
inteira da Guedder.

Duas assimetrias da API do CloudWatch que explicam a forma do documento:

- `logs:StartQuery` aceita restrição por ARN de log group — é onde o recorte real acontece.
- `logs:GetQueryResults` e `logs:StopQuery` operam sobre um `queryId`, não sobre o log group,
  e por isso não aceitam `Resource` específico. Quem já não conseguiu iniciar a consulta não
  tem `queryId` para ler.

O IAM estreita quais log groups. Ele **não** estreita quais linhas — isso é responsabilidade do
servidor, pelo allowlist de campos e pela consulta sempre por identificador (`src/auditoria.ts`).

### Ao adicionar um log group

Acrescente o ARN em `RastrearCompraNosLogs` **e** o nome em `GUEDDER_MCP_LOG_GROUPS`. Os dois
precisam concordar: a variável sem a permissão gera erro de acesso em runtime; a permissão sem
a variável é privilégio concedido e não usado.

### Variáveis relacionadas

| Variável | Papel |
|---|---|
| `GUEDDER_MCP_LOG_GROUPS` | Log groups consultados, separados por vírgula |
| `GUEDDER_MCP_MAX_LINHAS` | Teto de linhas por resposta (padrão 100) |
| `GUEDDER_MCP_JANELA_DIAS` | Limite do scan da âncora, em dias (padrão 30). Não é filtro do usuário |
| `AWS_REGION` | Região dos log groups (padrão `us-west-2`) |
