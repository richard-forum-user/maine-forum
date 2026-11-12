# Self-hosting with Docker

The default `docker-compose.yml` publishes **only on the host loopback**:

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

Your pod is not reachable from the LAN or the public internet unless **you** add a reverse proxy (Caddy, nginx, Cloudflare Tunnel).

## Run

```bash
docker compose up --build
open http://127.0.0.1:8787/pod
```

SQLite and DO state persist under `./pod-data` (mounted at `/data` in the container).

## Backup

```bash
tar -czf pod-backup.tgz pod-data/
```

## No cooperative sync

This deployment does not sync to a cooperative or a shared relay. There is no membership check and no `COOP_URL`.
