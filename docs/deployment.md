# Kubernetes Deployment

The container runs Node.js 24 as UID/GID `10001`. Application state must be mounted at `/var/lib/mimo2api`.

## Required state paths

```yaml
env:
  - name: MIMO2API_DATA_DIR
    value: /var/lib/mimo2api
  - name: MIMO2API_DATABASE_FILE
    value: /var/lib/mimo2api/mimo2api.sqlite
  - name: MIMO2API_CONFIG_FILE
    value: /var/lib/mimo2api/config.json
```

At first startup, the process imports the existing JSON configuration into SQLite. Keep the old `config.json` on the PVC for the first rollout. The JSON file is retained as a rollback source and is not mutated.

SQLite uses WAL mode. The database, `-wal` and `-shm` files must stay on the same writable volume. Run one replica unless a shared-volume SQLite topology has been explicitly validated.

## Secrets

Inject secrets through the existing Kubernetes Secret:

```yaml
env:
  - name: MIMO2API_API_KEYS
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: api-keys } }
  - name: MIMO2API_ADMIN_PASSWORD
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: admin-password } }
  - name: MIMO2API_COMPACTION_KEY
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: compaction-key } }
  - name: MIMO2API_TEMP_MAIL_API_BASE
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: temp-mail-api-base } }
  - name: MIMO2API_TEMP_MAIL_ADMIN_PASSWORD
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: temp-mail-admin } }
  - name: MIMO2API_PROXY_SUB_URL
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: proxy-sub-url } }
```

## Streaming ingress

The service sends an immediate SSE comment and 10-second heartbeats. The ingress must disable response buffering and allow long-lived responses. The application sets `X-Accel-Buffering: no`, `Cache-Control: no-cache, no-transform` and aborts upstream MiMo when clients disconnect.

## Health and rollout

Use `/healthz` for readiness and liveness. A successful response confirms the Node process, SQLite connection and scheduler state.

Before promoting an image:

```bash
npm ci
npm run check
npm run build
docker build -t mimo2api:local .
```

After rollout, verify:

```bash
curl -fsS https://mimo2api.mnnu.eu.org/healthz
curl -N https://mimo2api.mnnu.eu.org/v1/responses \
  -H "Authorization: Bearer $MIMO2API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mimo-v2.5-pro","input":"reply with ok","stream":true}'
```
