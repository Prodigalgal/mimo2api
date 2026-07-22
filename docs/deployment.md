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

The production GitOps overlay uses the `speedproxy/mimo2api` image and keeps
application state in the `mimo2api-state` PVC. Its init container copies the
bootstrap configuration only when the PVC has no configuration, so an image
rollout does not overwrite accounts or runtime settings.

The expected runtime contract is:

- public endpoint: `https://mimo2api.mnnu.eu.org`
- namespace: `mimo2api`
- one replica with a `Recreate` rollout
- read-only root filesystem with the state volume mounted at `/var/lib/mimo2api`

For a release, update the GitOps image tag to the full SHA tag emitted by the
workflow, then verify the Argo CD application, Deployment, PVC, HTTPRoute, and
`/v1/models` endpoint.
