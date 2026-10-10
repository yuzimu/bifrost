# Oracle deployment

Bifrost runs as ARM64 on Oracle. `api.mooo.si` is managed by the existing
1Panel OpenResty website and certificate. The application listens on
`127.0.0.1:8088`; container port 8080 is not exposed publicly.

## Persistent configuration

| Host path | Purpose |
| --- | --- |
| `/opt/bifrost/compose.yaml` | Application deployment |
| `/opt/bifrost/.env` | Last successfully deployed immutable image |
| `/opt/bifrost/data` | Application state and logs |
| `/etc/bifrost/config.json` | Provider and application configuration |
| `/etc/bifrost/bifrost.env` | Runtime secrets |
| `/opt/bifrost/deploy.sh` | Root-owned application deployment |
| `/usr/local/libexec/bifrost-ci-deploy` | Restricted SSH command |

The data directory is owned by UID/GID `1000:1000`. Configuration is mounted
read-only and readable by the application user. Keep all secrets outside Git.
The application joins `x2api-entry` for direct Grok2API/X2API access. Its SQLite
configuration and log databases persist in `/opt/bifrost/data`. The deployment
does not change provider configuration.

## CI/CD

The `Oracle ARM64 Release` workflow builds the repository's local Go modules and
frontend on `ubuntu-24.04-arm`. It publishes `ghcr.io/yuzimu/bifrost:sha-COMMIT`
and deploys the resulting `sha256` digest. Trigger it manually from GitHub
Actions, or push a tag such as `oracle-v1.0.0`.

Repository secrets: `ORACLE_HOST`, `ORACLE_PORT`, `ORACLE_USER`,
`ORACLE_DEPLOY_SSH_KEY`, `ORACLE_SSH_KNOWN_HOSTS`.

The dedicated SSH key uses a forced command and disables forwarding, agent
access, X11 and PTYs. It accepts only `deploy ghcr.io/yuzimu/bifrost@sha256:...`.
The workflow sends its short-lived `GITHUB_TOKEN` over SSH for that deployment's
registry pull. Temporary registry credentials are removed when deployment ends.

The server only pulls images and recreates Bifrost; it does not build source.
Deployment is serialized and succeeds only after container readiness and the
local health endpoint respond. Provider, credential and database files are
preserved. Image deployment does not automatically revert database migrations.

The initial release uses this same GitHub Actions workflow.
