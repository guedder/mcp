# ADR 0005 — Hospedagem em staging: imagem no ghcr, serviço no ECS, e ele dorme sem acordar sozinho

**Status**: Aceito — 2026-09-16
**Terraform**: repo `infra`, roots `guedder/mcp/staging`,
`guedder/identity/staging`, `guedder/platform/staging`

## Contexto

O serviço hospedado do MCP tinha sido **desligado de propósito** num PR
anterior, com o argumento de que sem serviço hospedado não havia OAuth para
manter: o MCP era ferramenta de suporte, rodava em stdio local, e o ECR
`guedder/mcp` foi destruído junto.

Essa premissa caiu quando o caso de uso mudou de suporte interno só-leitura
para atender usuário final com escrita. Um agente que a pessoa conecta pelo
plugin precisa de um endpoint público, com OAuth, que não seja a máquina de
ninguém.

## Decisão

**Imagem no ghcr, não no ECR.** O workflow `container.yml` deste repo
sobreviveu ao descomissionamento e já publica `ghcr.io/guedder/mcp` multi-arch
a cada push em `main` e em tags `v*`. O pacote é público (pull anônimo devolve
200), então a task não precisa de `repositoryCredentials`. Voltar ao ECR
exigiria três peças novas de uma vez — repo no root de registry, role de OIDC
para o GitHub Actions e um job de push — para entregar a mesma imagem que o
ghcr já serve.

**Serviço ECS Fargate** no cluster `guedder-staging` (us-east-1), atrás do ALB
compartilhado, com regra de listener por `host_header`
`mcp.dev.services.guedder.com` e registro Route 53 alias. Sem Service Connect:
o MCP é consumidor puro, ninguém o chama por dentro, e ele fala com a API pela
URL pública.

**Health check em `/.well-known/oauth-protected-resource`**, não num `/health`
dedicado. É melhor que um: esse endpoint só responde 200 quando o issuer do
Cognito está configurado, então health vermelho passa a significar "auth mal
configurada" e não apenas "processo morto".

**Cognito** (root `guedder/identity/staging`): resource server
`https://mcp.guedder.com/mcp` com **dois** escopos, `conta:read` e
`pedido:cancelar`. Mínimo deliberado — só o que tem consumidor hoje. Escopo
declarado sem consumidor é permissão concedida e esquecida, e remover depois só
marca o escopo inativo: token em circulação segue valendo até expirar. Somar é
barato, tirar é caro. App client `guedder-mcp-agent` público (PKCE, sem
secret), com TTL curto (access 1h, refresh 1d) porque o token vive no cliente
de IA de terceiro.

**O serviço dorme por inatividade junto com o resto do staging** (Lambda
`guedder-staging-power`, `IDLE_SECONDS=3600`) **e não acorda sozinho**. Isso é
decisão, não lacuna: o despertar existente é feito para navegador — a Lambda
serve uma página via CloudFront KeyValueStore — e um cliente MCP não é
navegador. Com o serviço em zero, uma chamada ao `/mcp` volta erro do ALB e o
cliente não tem como ver nem acionar a página. Em staging isso basta, porque
quem vai testar o agente abre o front antes, que é o mesmo gesto que acorda a
API de que o MCP depende.

## Consequências

- **Primeira chamada depois de uma hora parada falha**, e a mensagem é do ALB,
  não do MCP. Quem estiver depurando OAuth precisa saber disso antes de
  suspeitar do token.
- O deploy é por tag mutável `main` por padrão; tag imutável de release
  (`v0.2.0`) também serve, e é o que se usa para congelar.
- `GUEDDER_MCP_HOST=0.0.0.0` é obrigatório no contêiner. O padrão `127.0.0.1`
  em Fargate deixa o ALB sem alcance e o health check eternamente vermelho, sem
  nenhum erro no log da aplicação.
- `AWS_REGION` de staging é `us-east-1`, não o `us-west-2` do padrão do código:
  o log group `/ecs/guedder-staging` vive em us-east-1. Errar devolve
  "not authorized to perform StartQuery", que parece portão de admin fechado e
  não é.
- Dar caminho de despertar próprio ao MCP só se paga se ele passar a ser usado
  sem ninguém no front.
- **Produção não existe ainda.** O que já está fixado é a audiência
  (`https://mcp.guedder.com/mcp`), igual nos dois ambientes por ser endereço e
  não ambiente.
