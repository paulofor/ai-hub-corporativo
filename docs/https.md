# Ativando HTTPS em iahubcorp.online

Configuração para atender frontend e backend via HTTPS usando **nginx + Let's Encrypt**.

## Pré-requisitos

- Domínio `iahubcorp.online` já apontado para o IP público da VPS.
- Portas 80 e 443 liberadas no firewall e sem outro processo escutando.
- Repositório clonado na VPS e Docker/Compose instalados (use `sudo ./infra/setup_vps.sh` se ainda não fez).

As chaves emitidas ficam persistidas em `infra/nginx/letsencrypt` e são montadas pelo nginx.

## 1) Emitir o primeiro certificado

Como o nginx ainda não está rodando, use o modo standalone do Certbot (o serviço `certbot` já está descrito no `docker-compose.yml`).

```bash
# na raiz do repositório
# pare qualquer serviço que use 80/443 (ex.: nginx antigo)
docker compose run --rm --service-ports certbot \
  certonly --standalone \
  -d iahubcorp.online \
  --email seu-email@dominio.com \
  --agree-tos --no-eff-email \
  --rsa-key-size 4096
```

Isso criará os arquivos em `infra/nginx/letsencrypt/live/iahubcorp.online/`.

## 2) Subir o proxy HTTPS

Com o certificado emitido, basta subir o nginx reverse proxy e os demais serviços:

```bash
docker compose up -d reverse-proxy frontend backend sandbox-orchestrator
```

- Frontend: https://iahubcorp.online
- API/Backend: https://iahubcorp.online/api (ex.: health em `/api/actuator/health`)

Garanta que no `.env` o `HUB_PUBLIC_URL` esteja como `https://iahubcorp.online/api` e o `VITE_API_BASE_URL` como `/api` (já é o padrão).

## 3) Renovação

O certificado dura 90 dias. Para renovar com o mesmo método (standalone), faça:

```bash
docker compose stop reverse-proxy

# usa as mesmas portas 80/443 para o desafio
docker compose run --rm --service-ports certbot renew

# sobe de volta e recarrega o nginx
docker compose up -d reverse-proxy
```

Dica: após a primeira emissão você pode alternar o método para **webroot** (evita parar o nginx) executando uma nova emissão:

```bash
docker compose run --rm certbot \
  certonly --webroot -w /var/www/certbot \
  -d iahubcorp.online \
  --email seu-email@dominio.com \
  --agree-tos --no-eff-email

docker compose exec reverse-proxy nginx -s reload
```

Depois disso, a renovação pode ser apenas:

```bash
docker compose run --rm certbot renew

docker compose exec reverse-proxy nginx -s reload
```

Considere agendar um cron mensal com esse comando de renovação + reload.
