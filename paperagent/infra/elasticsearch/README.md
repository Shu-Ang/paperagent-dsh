# PaperAgent local Elasticsearch

This is a single-node Elasticsearch deployment for local Windows Docker Desktop development. It is not a shared or production cluster.

## Start

1. Copy or edit `.env` and replace `ELASTIC_PASSWORD` before the first start.
2. In an elevated PowerShell, set the Docker Desktop WSL kernel limit once:

   ```powershell
   wsl -d docker-desktop -u root sysctl -w vm.max_map_count=262144
   ```

3. Start the service from this directory:

   ```powershell
   docker compose up -d
   docker compose ps
   docker compose logs -f elasticsearch
   ```

The HTTP endpoint is `http://127.0.0.1:9200`. It has password authentication and is intentionally bound to the local machine only.

## Stop

```powershell
docker compose stop
```

Do not use `docker compose down -v` for normal shutdown: it deletes the named volume and therefore the local Elasticsearch indexes.
