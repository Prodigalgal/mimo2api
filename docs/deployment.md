# MiMo2API Deployment

This repository is the canonical deployment source for the local MiMo2API
enhancements. It builds `speedproxy/mimo2api` for both `linux/amd64` and
`linux/arm64` from the checked-in source tree.

## Container image

GitHub Actions publishes an immutable long-SHA tag and `latest` on pushes to
`main`. The workflow expects these repository secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN`

The image runs as UID/GID `10001` and is intended to use a writable state
volume. The following environment variables select persistent file locations:

- `MIMO2API_CONFIG_FILE`
- `MIMO2API_SESSIONS_FILE`
- `MIMO2API_USAGE_FILE`
- `MIMO2API_RESPONSES_FILE`
- `MIMO2API_BATCH_DIR`
- `MIMO2API_RENEW_INTERVAL_SECONDS` (default: `21600`)
- `MIMO2API_DATA_DIR` (writable dir for sing-box binary/config; defaults to `/tmp/mimo2api` when root is read-only)

### Secret / feature injection (env overrides config.json)

Environment variables **override** values loaded from `config.json` at process start:

| Env | Purpose |
|-----|---------|
| `MIMO2API_API_KEYS` | Comma-separated API keys |
| `MIMO2API_ADMIN_PASSWORD` | Admin UI password |
| `MIMO2API_TEMP_MAIL_API_BASE` | Temp-mail API base URL |
| `MIMO2API_TEMP_MAIL_ADMIN_PASSWORD` | Temp-mail admin password (`x-admin-auth`) |
| `MIMO2API_TEMP_MAIL_SITE_PASSWORD` | Optional site password |
| `MIMO2API_TEMP_MAIL_DOMAIN` | Optional preferred domain (usually leave empty for auto) |
| `MIMO2API_PROXY_ENABLED` | `true` / `false` |
| `MIMO2API_PROXY_SUB_URL` | VLESS subscription URL |
| `MIMO2API_PROXY_LISTEN_PORT` | Local sing-box mixed port |
| `MIMO2API_PROXY_CONNECT_RETRIES` | Failover node attempts per register |
| `MIMO2API_PROXY_FETCH_SUB_EACH_TIME` | Re-fetch sub each register |
| `MIMO2API_CAPTCHA_AI_ENABLED` | `true` / `false` |
| `MIMO2API_CAPTCHA_AI_API_BASE` | OpenAI-compatible vision API base |
| `MIMO2API_CAPTCHA_AI_API_KEY` | Vision API key |
| `MIMO2API_CAPTCHA_AI_MODEL` | Model id (e.g. `grok`) |
| `MIMO2API_CAPTCHA_AI_TIMEOUT` | Seconds |

Example (production):

```yaml
env:
  - name: MIMO2API_TEMP_MAIL_API_BASE
    value: "https://apimail.omnnu.xyz"
  - name: MIMO2API_TEMP_MAIL_ADMIN_PASSWORD
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: temp-mail-admin } }
  - name: MIMO2API_PROXY_ENABLED
    value: "true"
  - name: MIMO2API_PROXY_SUB_URL
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: proxy-sub-url } }
  - name: MIMO2API_CAPTCHA_AI_ENABLED
    value: "true"
  - name: MIMO2API_CAPTCHA_AI_API_BASE
    value: "https://sub2api.mnnu.eu.org"
  - name: MIMO2API_CAPTCHA_AI_API_KEY
    valueFrom: { secretKeyRef: { name: mimo2api-secrets, key: captcha-ai-key } }
  - name: MIMO2API_CAPTCHA_AI_MODEL
    value: "grok"
```

Never commit `config.json`, account tokens, login captures, or mail credentials.

## Oracle Kubernetes deployment

The production GitOps overlay lives in **`Prodigalgal/ircs-prod-config`**
under `mimo2api/`:

| Path | Role |
|------|------|
| `mimo2api/base/deployment.yaml` | Pod env (paths + `secretKeyRef`) |
| `mimo2api/base/secret-app-env.yaml` | Secret with URLs/keys (stringData) |
| `mimo2api/base/kustomization.yaml` | Base resources |
| `mimo2api/oracle/` | Image pin + HTTPRoute |

Application state stays on PVC `mimo2api-state`. Init only bootstraps empty
`config.json`; **secrets come from env** (`mimo2api-app-secrets`) and override
the file via `app/env_config.py`.

Runtime contract:

- public endpoint: `https://mimo2api.mnnu.eu.org`
- namespace: `mimo2api`
- one replica, `Recreate`
- read-only root FS; state at `/var/lib/mimo2api`; scratch at `/tmp` (`MIMO2API_DATA_DIR=/tmp/mimo2api`)

After changing secrets:

```bash
kubectl -n mimo2api apply -f mimo2api/base/secret-app-env.yaml
kubectl -n mimo2api rollout restart deploy/mimo2api
```

CI updates the oracle image tag after each successful image build.
