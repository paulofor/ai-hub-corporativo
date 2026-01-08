# Manual para preparar o novo servidor (163.245.203.201)

Este passo a passo descreve como preparar a nova VPS Linux em `163.245.203.201` para continuar recebendo os deploys automáticos do repositório.

## 1) Garantir acesso SSH do pipeline

1. Use a mesma chave privada configurada no secret `VPS_SSH_KEY` do GitHub Actions. A contrapartida pública dela precisa estar no `~/.ssh/authorized_keys` do **root** do novo servidor.
2. Caso já tenha o arquivo `ai_hub_deploy.pub` gerado pelo `infra/setup_vps.sh` anterior, copie o conteúdo para o novo servidor e rode:
   ```sh
   sudo mkdir -p /root/.ssh
   echo "<conteúdo-da-chave-pública>" | sudo tee -a /root/.ssh/authorized_keys
   sudo chmod 600 /root/.ssh/authorized_keys
   ```
3. Teste o acesso a partir da sua máquina: `ssh root@163.245.203.201`.

## 2) Clonar o projeto no servidor

```sh
sudo apt-get update && sudo apt-get install -y git
sudo mkdir -p /root/ai-hub-corporativo
sudo git clone https://github.com/<SEU_USUARIO>/ai-hub-corporativo /root/ai-hub-corporativo
cd /root/ai-hub-corporativo
```

> Se o repositório for privado, faça o clone usando uma chave ou token com permissão de leitura.

## 3) Rodar o bootstrap da VPS

No diretório do projeto, execute o script que instala Docker/Compose, cria a network `public-net` e prepara o `.env`:

```sh
sudo ./infra/setup_vps.sh
```

Durante o wizard:
- Mantenha as portas padrão (backend 8081, frontend 8082, sandbox 8083) ou ajuste conforme necessidade.
- O banco padrão continua em `jdbc:mysql://d555d.vps-kinghost.net:3306/aihubcorpdb` com `aihubcorp_usr` / `S3nh@Fort3`.
- Informe `GHCR_USERNAME`/`GHCR_TOKEN` se for baixar imagens privadas do GHCR.
- Preencha as credenciais da GitHub App e demais variáveis conforme seu ambiente.

## 4) Colocar segredos locais necessários

- **OpenAI**: grave a chave em `/root/infra/openai-token/openai_api_key` (ou ajuste `OPENAI_TOKEN_HOST_DIR` no `.env`).
- **Certificados TLS**: se já possui certificados válidos do servidor antigo, copie o conteúdo de `infra/nginx/letsencrypt` e `infra/nginx/certbot-www` para o mesmo caminho no novo host antes de subir os contêineres. Sem eles, será gerado um certificado autoassinado temporário.

## 5) Autenticar no registry e subir os contêineres

Ainda em `/root/ai-hub-corporativo`:

```sh
./infra/bin/ensure-ghcr-login.sh
docker compose pull
docker compose up -d
```

Isso vai baixar as imagens, criar a network externa `public-net` (se ainda não existir) e publicar:
- Frontend em `http://163.245.203.201` (ou pelo domínio apontado para o IP)
- Backend em `http://163.245.203.201:8081`
- Sandbox orchestrator em `http://163.245.203.201:8083`

## 6) Validar

- Verifique se os serviços estão de pé: `docker ps`.
- Acompanhe logs iniciais: `docker compose logs -f reverse-proxy backend frontend`.
- Se usar HTTPS, siga `docs/https.md` para emitir/renovar os certificados via Certbot.

## 7) Garantir deploy automático pela pipeline

- O workflow já aponta o `DEPLOY_HOST` para `163.245.203.201`.
- Confirme que os secrets `VPS_SSH_KEY`, `GHCR_USERNAME` e `GHCR_TOKEN` estão preenchidos no repositório.
- No próximo push para `main`, o GitHub Actions fará o `rsync` para `/root/ai-hub-corporativo` nesse novo servidor e rodará `docker compose pull && docker compose up -d` automaticamente.

Pronto! Após concluir os passos acima, a nova VPS estará preparada para receber deploys e servir o ambiente em produção.
