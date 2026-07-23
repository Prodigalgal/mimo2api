# Changelog

## 3.0.0

- Rebuilt the runtime in TypeScript, Node.js and Fastify.
- Migrated configuration, accounts, response state, usage and renewal scheduling to SQLite.
- Added complete Chat Completions and Responses protocol families with a shared streaming state machine.
- Preserved image/file upload and removed audio, Anthropic and legacy batch implementations.
- Added staggered account renewal with SQLite leases, jitter and exponential backoff.
