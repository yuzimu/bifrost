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

## CPA and unified model routing

CPA runs separately from Bifrost with `cpa-compose.yaml`. Its listener is bound
to `127.0.0.1:8317`, and Bifrost reaches it at `http://cpa:8317` through the
existing `x2api-entry` Docker network. Install the Compose file under `/opt/cpa`
and the runtime configuration under `/opt/cpa/data/config.yaml`.

Use `cpa-config.example.yaml` as the credential-free template. Replace its API
key placeholder with the runtime key and set the same value as
`BIFROST_CPA_KEY` in `/etc/bifrost/bifrost.env`. Keep OAuth JSON files in
`/opt/cpa/data/auths` with mode `0600`. Credentials use `proxy_url: direct`;
keep renewable `refresh_token` values when converting imported OAuth accounts.
Runtime credentials, passwords, account pools and backup files stay outside Git.

Clients can send bare model names to Bifrost. The virtual key assigns provider
weights, and the adaptive-routing plugin selects eligible providers and keys
using observed errors and latency. The upstream catalog continues to expose
provider-prefixed IDs for explicit selection.

The bare `gpt-image-2.5` entry uses the native routing plugin: x2api's
`gpt-image-2.5` is primary, and CPA's `gpt-image-2` is the fallback. The rule
applies to `oracle-openai`; explicit provider-prefixed requests remain pinned.
The x2api ChatGPT image entry is `gpt-image-2.5`; the example configuration also
lists the native `flow/` and `aistudio/` model namespaces and three canonical
Google image families. Both provider-key and virtual-key allowlists must match.
These entries grant routing permission; they do not establish account readiness
or successful inference. Select `x2api/flow/<model>` or
`x2api/aistudio/<model>` explicitly when checking an individual channel.
Claude models are excluded from CPA. CPA Gemini images use the chat-completions endpoint, with
provider-specific `image_config` in `extra_params` and the
`x-bf-passthrough-extra-params: true` header. Their image payload is available in
`extra_fields.raw_response.choices[0].message.images`.

Native error-triggered image fallbacks cannot determine whether a timed-out
upstream already accepted generation, so ambiguous failures can create another
image. No fault-injection verification of this fallback has been performed.

For native X2API Google models, keep the channel fallback policy inside X2API,
which tracks upstream acceptance and parameter qualification. Do not attach the
ChatGPT/CPA fallback rule to Google media requests. Flow video extension and
recovery use X2API's own `mode` and `source_video_id` contract; the standard
Bifrost `/videos/extensions` contract is different and must not be substituted.
Use `response_format=b64_json` for X2API images through `api.mooo.si`: the current
URL response retains the upstream internal media origin. Native video generation,
content retrieval and extension are available through `x2api.mooo.si` using the
X2API key. The Bifrost virtual key and upstream X2API key are separate credentials.
