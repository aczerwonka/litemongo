# LiteMongo — user documentation

LiteMongo is a lightweight, web-based MongoDB client (an alternative to Compass / Studio 3T). A single Node.js process serves the API (`/api`), the MCP server (`/mcp`) and the compiled React frontend (PWA) on one port.

> Polish version: [docs/DOKUMENTACJA.md](docs/DOKUMENTACJA.md)
>
> **Illustrated tutorial** (queries, links, nested table, columns, saved views, fetch recipes, installing the desktop app): see [docs/tutorial/README.md](docs/tutorial/README.md).

**Important:** the server is stateless. Connection strings and passwords live only in the browser (localStorage) and are sent with each request in the `X-Mongo-URI` header. The server never writes anything to disk.

## Table of contents

1. [Requirements](#1-requirements)
2. [Quick start (local development mode)](#2-quick-start-local-development-mode)
3. [Local MongoDB with sample data](#3-local-mongodb-with-sample-data)
4. [Production run without Docker](#4-production-run-without-docker)
5. [Docker: building and running the image](#5-docker-building-and-running-the-image)
6. [Deploying on a jump host (AWS EC2)](#6-deploying-on-a-jump-host-aws-ec2)
7. [Environment variables](#7-environment-variables)
8. [First steps in the UI](#8-first-steps-in-the-ui)
9. [Portable configuration `litemongo.config.json`](#9-portable-configuration-litemongoconfigjson)
10. [MCP server (`/mcp`)](#10-mcp-server-mcp)
11. [Installing as an app (PWA)](#11-installing-as-an-app-pwa)
12. [Desktop app (Electron)](#12-desktop-app-electron)
13. [Tests and type checking](#13-tests-and-type-checking)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Requirements

| Scenario | Needed |
|---|---|
| Development mode / manual build | Node.js **22+**, npm |
| Docker | Docker 24+ (with Buildx for multi-arch images) |
| Local test database | Docker + Docker Compose |
| Working with data | Access to MongoDB (v8/v9), local or remote |

Check versions:

```bash
node -v    # >= 22
npm -v
docker -v
```

## 2. Quick start (local development mode)

The project is an npm monorepo (workspaces `server` and `client`).

```bash
cd limemongo
npm install          # installs dependencies of both workspaces
npm run dev          # starts the server (3001) and the Vite client (5173) in parallel
```

Open **http://localhost:5173**. Vite proxies `/api` and `/mcp` to Fastify on port 3001, so the browser sees a single origin — exactly as in production.

Separately:

```bash
npm run dev:server   # backend only (tsx watch, port 3001)
npm run dev:client   # frontend only (Vite, port 5173)
```

## 3. Local MongoDB with sample data

`docker-compose.yml` starts MongoDB 8 and loads sample data (insurance domain):

- `mongo-seed.js` — `policies`, `claims`, `claim_items`
- `mongo-seed-rich.js` — `persons`, `contractors`, `policies2`, `claims2` (dynamic attributes)

```bash
docker compose up -d          # start the database
docker compose ps             # check health
docker compose down           # stop (data stays in the volume)
docker compose down -v        # stop and DELETE data (re-seed on next start)
```

Connection string to enter in LiteMongo:

```
mongodb://admin:localpassword@localhost:27017/insurance_dev?authSource=admin
```

> The seed scripts only run on the **first** start with an empty volume. To load them again: `docker compose down -v && docker compose up -d`.

## 4. Production run without Docker

```bash
npm install
npm run build        # builds the client (client/dist) and compiles the server (server/dist)
npm start            # server + static frontend at http://localhost:3001
```

Change port / interface:

```bash
PORT=8080 HOST=127.0.0.1 npm start
```

Read-only mode for the whole instance:

```bash
FORCE_READ_ONLY=true npm start
```

## 5. Docker: building and running the image

The `Dockerfile` is multi-stage: stage 1 builds the client and server, stage 2 is a minimal `node:22-alpine` (no native add-ons, runs as the `node` user).

### Build for the current architecture

```bash
docker build -t litemongo:latest .
```

### Run

```bash
docker run -d --name litemongo \
  -p 3001:3001 \
  --read-only \
  litemongo:latest
```

Open **http://localhost:3001**. Health check: `curl http://localhost:3001/api/health`.

Force read-only mode (recommended on a jump host):

```bash
docker run -d --name litemongo -p 3001:3001 --read-only \
  -e FORCE_READ_ONLY=true \
  litemongo:latest
```

Connecting to a database on the host (Docker Desktop): use `host.docker.internal` instead of `localhost` in the connection string.

### Multi-arch image (amd64 + arm64 / AWS Graviton)

Create a builder once:

```bash
docker buildx create --name litemongo-builder --use
```

Build and push to a registry:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <registry>/litemongo:latest --push .
```

Local build without push (single platform, loaded into local Docker):

```bash
docker buildx build --platform linux/arm64 -t litemongo:arm64 --load .
```

The build stage runs natively on the build machine (no QEMU emulation); only the small runtime stage is per architecture.

### Exporting an image without a registry

```bash
docker save litemongo:latest | gzip > litemongo.tar.gz
# on the target server:
gunzip -c litemongo.tar.gz | docker load
```

## 6. Deploying on a jump host (AWS EC2)

Recommended security model:

1. **MongoDB user with the `read` role** — hard protection at the database level.
2. **`FORCE_READ_ONLY=true`** on the container — the server blocks all mutating operations (`/api/transfer/paste` and script-mode writes via `/api/shell/op`) and returns `403 READ_ONLY`.
3. **Do not expose the port publicly.** Bind to loopback and connect through an SSH tunnel:

```bash
# on the jump host
docker run -d --name litemongo --restart unless-stopped --read-only \
  -p 127.0.0.1:3001:3001 \
  -e FORCE_READ_ONLY=true \
  <registry>/litemongo:latest

# on your computer
ssh -L 3001:127.0.0.1:3001 ec2-user@<jump-host>
# then open http://localhost:3001
```

4. Optionally mount your own config file to feed `/mcp`:

```bash
docker run -d --name litemongo -p 127.0.0.1:3001:3001 --read-only \
  -e FORCE_READ_ONLY=true \
  -e LITEMONGO_CONFIG=/config/litemongo.config.json \
  -v $PWD/litemongo.config.json:/config/litemongo.config.json:ro \
  <registry>/litemongo:latest
```

> The application has no authentication of its own. Control access at the network level (SSH tunnel, security groups, VPN). Never expose it directly to the internet.

## 7. Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Listen port |
| `HOST` | `0.0.0.0` | Listen interface (`127.0.0.1` = local only) |
| `FORCE_READ_ONLY` | `false` | `true` blocks all write operations regardless of UI settings |
| `LOG_LEVEL` | `info` | Fastify log level |
| `LITEMONGO_CONFIG` | — | Path to `litemongo.config.json` for the MCP server |
| `CLIENT_DIST` | `client/dist` | Alternative path to the built frontend |
| `MONGO_CLIENT_IDLE_TTL_MS` | `300000` | Idle time after which a connection pool is closed (5 min) |
| `MONGO_MAX_CLIENTS` | `32` | Max number of simultaneously cached MongoDB clients |
| `LITEMONGO_DESKTOP_PORT` | `38017` | Port of the embedded server in the desktop (Electron) app |

`X-Mongo-URI` headers are never logged.

## 8. First steps in the UI

1. **Add a connection** — name, URI, environment (tier) and the read-only flag. Profiles are stored only in the browser.
2. **Environments:**
   - **PROD / CLIENT** (red) — always read-only, the lock cannot be released,
   - **TEST** (orange),
   - **DEV / LOCAL** (green).
3. **Tabs** — independent queries against different collections / databases / connections at the same time.
4. **Query editor** — visual mode synced with the Monaco editor (JSON/MQL), with autocomplete driven by declared schemas.
5. **Data views:** Tree, Flat table, and Nested table (table-in-table) with `code` badges.
6. **Relation Blueprints** — e.g. `policies._id → claims.policyId → claim_items.claimId`; fetched with two or three `$in` queries instead of `$lookup`.
7. **Copy / paste between environments** — data travels as Extended JSON (BSON types preserved). The **Renumber / Remap IDs** option renumbers IDs while keeping references and domain codes intact; a dry-run preview is available before inserting.
8. **Inspectors:** distinct values of a field (click a column header), collection index list.
9. **Script (free-query) mode** — mongosh-style scripts run in a Web Worker in the browser; the server only executes single operations (`/api/shell/op`) and never evaluates user code.

## 9. Portable configuration `litemongo.config.json`

One JSON file holds: collection schemas (`idPaths`, `{ code, value }` dictionaries), relations, display rules for `code` badges, saved queries and ID renumbering rules.

- Example: `litemongo.config.example.json`
- Export/import and sync (clipboard or file) from the UI (Import/Export).
- Typical flow: configure on the jump host → copy the config → paste it locally.

## 10. MCP server (`/mcp`)

A built-in, **read-only** Model Context Protocol server for AI assistants. Tools:

- `list_schemas` — documented schemas and code dictionaries,
- `list_relations` — saved master-detail relations,
- `query_master_detail` — safe query along a relation, returns the stitched 2–3 level hierarchy.

Endpoint: `http://localhost:3001/mcp`. For the server to know your schemas and relations, start it with `LITEMONGO_CONFIG` pointing to your config file (see section 6).

## 11. Installing as an app (PWA)

LiteMongo is a Progressive Web App. In Chrome/Edge (on a running instance) click the "Install" icon in the address bar → the app opens in its own window, with cached assets (including Monaco) that work offline.

Want an app with nothing to install? See [section 12](#12-desktop-app-electron).

Note: a PWA still **needs a running server** (container or `npm start`), because the server is what talks to MongoDB. A browser cannot speak the MongoDB protocol.

## 12. Desktop app (Electron)

The `desktop/` directory contains an Electron wrapper: the Fastify server is embedded in the app, so the end user **installs nothing extra** (no Node.js, no Docker). The app starts the server on `127.0.0.1:38017` and opens it in its own window.

### Development mode

```bash
npm install                 # root dependencies (needed to build client/server)
npm run desktop:install     # Electron dependencies (a separate package in desktop/)
npm run desktop:dev         # builds the client + starts the Electron window
```

### Building an installer

```bash
npm run desktop:dist                      # for the current OS
npm --prefix desktop run dist:mac         # macOS: .dmg + .zip
npm --prefix desktop run dist:win         # Windows (x64): NSIS installer + portable
npm --prefix desktop run dist:linux       # Linux (x64): AppImage + .deb
```

Output goes to `desktop/release/`. The installer is about 115 MB.

### Building for Windows (x64)

Yes, the Windows installer (`LiteMongo Setup 0.1.0.exe` and the portable `LiteMongo 0.1.0.exe`) can be built **directly on a Mac** — tested, with no Wine or extra software. The `dist:win` script forces the x64 architecture (by default electron-builder would use the host architecture, e.g. arm64 on Apple Silicon).

```bash
npm install && npm run desktop:install
npm run build                           # once: client + server
npm --prefix desktop run dist:win       # → desktop/release/*.exe
```

For Windows ARM, add your own target (`--arm64`) in `desktop/package.json`.

Cross-platform build limitations:

- The `.exe` was not run on a real Windows machine — verify on the target machine.
- Code signing (Authenticode certificate) needs extra configuration; without it Windows shows SmartScreen.
- The macOS `.dmg` target can only be built on macOS; Linux targets (`AppImage`, `.deb`) can usually be built from a Mac or Linux. The most reliable way to cover every platform is CI with an OS matrix (GitHub Actions).

### Good to know

- **Fixed port (38017).** Connection profiles live in the window's localStorage, which is scoped to the origin (address). A fixed port keeps them between launches. Change it with `LITEMONGO_DESKTOP_PORT=40000`. If the port is busy, the app picks a random one, but profiles saved under the previous port won't be visible.
- **Single instance** — launching again focuses the existing window.
- **No code signing.** Signing is configured in `desktop/package.json` → `build` (see the electron-builder docs). Until then, the first launch needs one extra step per OS:
  - **Windows:** SmartScreen shows “Windows protected your PC” → **More info** → **Run anyway**.
  - **macOS:** after copying the app to Applications, remove the quarantine flag once: `xattr -dr com.apple.quarantine /Applications/LiteMongo.app` (otherwise macOS reports the app as “damaged”). Alternatively System Settings → Privacy & Security → **Open Anyway**.
  - **Linux:** prefer the `.deb` (`sudo apt install ./litemongo-desktop_<version>_amd64.deb`). For the AppImage: `chmod +x LiteMongo-<version>.AppImage`; it needs FUSE 2 (`sudo apt install libfuse2`, on Ubuntu 24.04 `libfuse2t64`); if Chromium's sandbox is blocked by AppArmor (Ubuntu 23.10+), start it with `--no-sandbox`.
- External links open in the system browser; the window only loads its own local server.
- The desktop app keeps the same guarantees as the container: stateless server, passwords only in localStorage. `FORCE_READ_ONLY=true` also works when launched from a terminal.

## 13. Tests and type checking

```bash
npm run typecheck    # tsc for server and client
npm test             # server tests (node:test)
```

> Integration tests may require a running MongoDB (see section 3).

## 14. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Unsupported engine` on `npm install` | Install Node.js ≥ 22 |
| UI does not load on port 3001 | The client was not built — run `npm run build` (the server serves the frontend only when `client/dist/index.html` exists) |
| Container cannot reach the local database | Use `host.docker.internal` instead of `localhost` in the URI |
| Authentication error on the local database | Add `?authSource=admin` to the URI |
| Write blocked (403) | The connection is marked read-only, the tier is PROD/CLIENT, or `FORCE_READ_ONLY=true` is set |
| Old UI version after a deployment | The service worker updates on the next load — refresh twice |
| Server health | `curl http://localhost:3001/api/health` |
