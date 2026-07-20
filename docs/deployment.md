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
