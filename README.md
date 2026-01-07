# AI Hub

AI Hub é um monorepo full-stack que centraliza a criação e governança de sistemas via interface web. O projeto combina um backend Spring Boot com um frontend React/Vite, infraestrutura pronta para Docker e AWS Lightsail, além de automações GitHub Actions.

## Visão geral

- **UI-first**: nenhuma ação destrutiva é executada sem confirmação explícita na UI.
- **Integrações GitHub**: criação de repositórios, disparo de workflows, análise de logs, comentários e PRs de correção.
- **Upload ZIP**: envie o código-fonte direto pela UI em formato .zip para ser analisado no sandbox, sem precisar clonar do Git.
- **OpenAI Responses API**: integração mediada pelo sandbox-orchestrator para gerar correções e relatórios `CiFix` a partir de falhas em pipelines.
- **Persistência**: MySQL 5.7 (produção) com Flyway para auditoria, projetos, prompts e respostas.

## Estrutura de pastas

```
apps/
  backend/
  frontend/
  sandbox-orchestrator/
infra/
  nginx/
  lightsail/
.github/
  workflows/
```

## Desenvolvimento local

1. Ajuste as variáveis em `.env` na raiz (já versionado com valores padrão compatíveis com a VPS) e, se necessário, personalize também `apps/backend/.env.example` e `apps/frontend/.env.example`. O campo `DB_PASS` já está configurado com a senha atual (`S3nh@Fort3`) e os padrões de `DB_URL`/`DB_USER` apontam para o MySQL `jdbc:mysql://d555d.vps-kinghost.net:3306/aihubcorpdb` com usuário `aihubcorp_usr`; se a senha for rotacionada, atualize o valor nesses arquivos antes de reiniciar os contêineres.
2. Crie a rede compartilhada `public-net` (usada pelo nginx e pelos serviços expostos) uma única vez com `docker network create public-net`.
3. Garanta que você tenha um MySQL acessível (pode reutilizar o mesmo da produção ou apontar para outro ambiente) e então execute `docker compose pull && docker compose up -d` para subir backend, frontend, sandbox-orchestrator e o reverse-proxy (nginx).
4. Instale o Maven localmente para executar comandos do backend (`mvn test`, `mvn clean package`). A imagem do sandbox já vem com Maven e JDK pré-instalados; se precisar configurar a sua máquina, siga [este passo a passo](docs/maven-setup.md).
5. A UI estará disponível em `http://localhost:8082`, a API em `http://localhost:8081` e o sandbox-orchestrator em `http://localhost:8083`.

> 💡 Para compilar as imagens localmente (sem depender das builds do GitHub Actions), use `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d`. O arquivo `docker-compose.build.yml` adiciona de volta as diretivas de `build` para cada serviço.

### Armazenamento do token da OpenAI na VPS

- Para guardar o token da OpenAI em um arquivo físico na VPS, use o caminho `/root/infra/openai-token/openai_api_key` (já esperado pelos contêineres por padrão). Esse diretório é montado como volume somente leitura no `sandbox-orchestrator` e, se o arquivo existir, o conteúdo é exportado como `OPENAI_API_KEY` antes de iniciar o serviço.
- Caso prefira armazenar o arquivo em outro diretório, defina `OPENAI_TOKEN_HOST_DIR` no `.env` apontando para a pasta que contém o `openai_api_key` antes de executar `docker compose up`.
- Caso o arquivo não esteja presente, o comportamento permanece igual ao anterior: as variáveis de ambiente definidas em `.env` continuam sendo usadas.

### Autenticação no GHCR para `docker compose pull`

- As imagens do backend, frontend e sandbox ficam publicadas no GitHub Container Registry (GHCR). Se o repositório estiver privado, o `docker compose pull` retornará `denied` até que você esteja autenticado.
- Preencha `GHCR_USERNAME` e `GHCR_TOKEN` (ou `GHCR_TOKEN_FILE`) no `.env`. O script `infra/setup_vps.sh` já pergunta esses valores e pode persistir o PAT em um arquivo seguro (permissão `600`) para reaproveitar o login automaticamente.
- Execute `./infra/bin/ensure-ghcr-login.sh` (ou simplesmente deixe o próprio `infra/setup_vps.sh` chamá-lo). Ele lê as variáveis do `.env`, roda `docker login ghcr.io` para você e grava as credenciais no `~/.docker/config.json`, permitindo que futuros `docker compose pull && docker compose up -d` funcionem sem intervenção humana.
- Se preferir não deixar o token exposto no `.env`, salve-o em um arquivo e aponte `GHCR_TOKEN_FILE=/caminho/do/token`. O helper cuidará da leitura do arquivo antes de autenticar.
- Caso não tenha acesso ao GHCR, use o fallback local: `docker compose -f docker-compose.yml -f docker-compose.build.yml up --build -d` para montar as imagens na sua máquina sem precisar baixá-las do registry.

## Testes

- Backend: `mvn -f apps/backend test`
- Frontend: `npm --prefix apps/frontend run lint`
- Sandbox Orchestrator: `npm --prefix apps/sandbox-orchestrator test`

## Deploy em produção

- Consulte `docs/https.md` para habilitar HTTPS no domínio iahubcorp.online via nginx + Let's Encrypt (frontend em https://iahubcorp.online e backend em https://iahubcorp.online/api).

- As imagens publicadas na pipeline ficam disponíveis em `ghcr.io/<seu-usuário>/ai-hub-corporativo-backend`, `ghcr.io/<seu-usuário>/ai-hub-corporativo-frontend` e `ghcr.io/<seu-usuário>/ai-hub-corporativo-sandbox`.
- Para que o deploy automático funcione, crie os secrets `GHCR_USERNAME` e `GHCR_TOKEN` (um PAT com escopo `read:packages`) no repositório — eles serão usados para executar `docker login` na VPS antes de `docker compose pull`.
- Utilize o exemplo `infra/lightsail/containers.example.json` para provisionar o serviço no AWS Lightsail Container Service.
- Em uma VPS genérica (como Locaweb), execute `sudo ./infra/setup_vps.sh` para instalar dependências, gerar `.env` com as credenciais do MySQL 5.7 hospedado em `d555d.vps-kinghost.net` (schema `aihubcorpdb`, usuário `aihubcorp_usr`) e subir os contêineres via Docker Compose.

## CI/CD

O workflow `ci.yml` executa testes do backend, lint do frontend e validação de Dockerfiles a cada push ou pull request.

## Licença

MIT
