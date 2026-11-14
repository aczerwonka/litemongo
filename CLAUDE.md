# Project: LiteMongo - Lightweight MongoDB Dev & Jump-Host Client

## 1. Project Overview & Goals

LiteMongo is a fast, lightweight, web-based MongoDB client and developer workbench designed as an open-source, zero-seat-cost alternative to heavy/paid tools like Studio 3T and MongoDB Compass.

### Core Objectives
* **Jump-Host Ready:** Packaged as a single, stateless, multi-arch (`linux/amd64`, `linux/arm64`) Docker container to run on AWS EC2 jump hosts and expose a web UI.
* **Zero-State Security:** The server never persists credentials on disk or in memory across sessions; connection profiles live exclusively in the developer's browser, with Read-Only guardrails enforced on jump hosts.
* **PWA & Future Desktop Ready:** Built as a Progressive Web App (PWA) so developers can install it locally in a standalone window, with a clean architecture ready to wrap in Neutralino.js or Electron later.
* **Modern MongoDB Support:** Full compatibility with MongoDB v8 and v9 wire protocols using official drivers.
* **Zero-Lag Relational Browsing:** Native support for 2-to-3 level Master-Detail views using application-level batched `$in` queries rather than heavy database-side `$lookup` aggregations.
* **Intelligent Cascading ID Remapping:** Copy a relational graph (Master + Children + Grandchildren + Nested Arrays) via Extended JSON (`EJSON`) and paste locally with a two-pass deterministic ID renumbering engine that preserves BSON types and updates foreign keys without corrupting domain codes.
* **Portable Workspace Configuration (`litemongo.config.json`):** Single exportable/importable JSON file storing static domain schemas (essential for MongoDB 8), saved Relation Blueprints, Nested View `code` badge mappings, Query Presets, and ID renumbering rules.
* **MCP Server Ready:** Built-in Model Context Protocol (MCP) server endpoint (`/mcp`) exposing user-documented schemas, relation blueprints, and read-only master-detail query tools to AI coding assistants.

---

## 2. Technical Stack

### Backend (Stateless Proxy, API, Static Server & MCP Endpoint)
* **Runtime:** Node.js (v22 LTS) with TypeScript
* **Web Framework:** Fastify (minimal overhead, high throughput)
* **Database Driver:** Official `mongodb` Node.js driver (`bson` / `EJSON` support)
* **MCP Integration:** `@modelcontextprotocol/sdk` (SSE / Streamable HTTP transport mounted on `/mcp`)
* **Architecture:** Serves `/api/*`, `/mcp`, and the compiled static React frontend from a single process/port.

### Frontend (UI & PWA)
* **Framework:** React 19 + TypeScript
* **Build Tool:** Vite + `vite-plugin-pwa` (standalone app-like windowing and offline asset caching)
* **Styling & Components:** Tailwind CSS + Shadcn UI (Radix primitives)
* **Data Grid:** `@tanstack/react-table` (flat tables, expandable JSON trees, and nested sub-tables with configurable `code` badges)
* **State & Caching:** `@tanstack/react-query` (query caching) + `zustand` (multi-tab workspace state, browser-scoped connection profiles, and portable config state)
* **Code/Query Editor:** `@monaco-editor/react` (raw JSON/MQL editing with custom schema & `$elemMatch` autocomplete)

### Deployment & Infrastructure
* **Containerization:** Multi-stage `Dockerfile` (Stage 1: Build React & Compile TS; Stage 2: Minimal `node:22-alpine` production image).
* **Multi-Platform:** Built via Docker Buildx targeting `linux/amd64` and `linux/arm64` (AWS Graviton).

---

## 3. Security & Stateless Connection Architecture

* **Zero Server-Side Persistence:** The Fastify backend must **never** store MongoDB connection strings, passwords, or TLS credentials on disk, in environment variables, or in a shared server store. On an AWS jump host, the container acts strictly as a stateless proxy.
* **Browser-Scoped Credential Storage:** Connection profiles (name, URI, environment color tag, `readOnly` flag) are stored exclusively in the developer's browser (`localStorage` with optional WebCrypto passphrase encryption, or scoped session cookies) and transmitted per API request via headers (`X-Mongo-URI`, `X-Read-Only`).
* **Short-Lived Connection Pooling:** Backend caches `MongoClient` instances keyed by a cryptographic hash of the incoming URI with a short idle TTL (e.g., 5 minutes), automatically closing idle sockets.
* **Jump-Host Read-Only Guardrails:**
  * Jump-host connections should authenticate using MongoDB read-only users (`read` role) at the database layer.
  * Any connection marked `readOnly: true` (or when global `FORCE_READ_ONLY=true` is set on the container) enforces a hard server-side middleware block (`server/src/middleware/readOnly.ts`) on all mutating endpoints (`/api/transfer/paste`, `/api/document/update`, `/api/document/delete`).

---

## 4. Core Architectural Patterns & Features

### A. Multi-Tab Workspace & Environment Safety Guards
* **Color-Coded Environment Headers:** Each connection profile has a color tag (e.g., Red for `AWS Jump Host Prod`, Green for `Local Docker Dev`) rendered prominently in the active tab header alongside a one-click **Read-Only Lock** toggle.
* **Multi-Tab Interface:** Browser-like tab bar allowing developers to run independent queries across different collections, databases, or connections simultaneously without losing state.

### A2. Environments & Free-Query Mode
* **Environment tiers:** PROD / CLIENT (red, always read-only, lock cannot be opened), TEST (orange), DEV / LOCAL (green).
* **Free-query (script) mode:** mongosh-style scripts run in a Web Worker in the browser (`client/src/lib/shell/worker.ts`, sync XHR); the server never evaluates user code, it only executes single operations via `/api/shell/op`.

### B. Multi-Mode Data Visualization & Configurable `code` Badges
Each query tab toggles seamlessly between three view modes on the same dataset:
1. **Tree View:** Collapsible, syntax-highlighted JSON/BSON node tree for inspecting deeply nested structures.
2. **Flat Table View:** Standard tabular grid with dynamic columns derived from top-level fields.
3. **Nested Tabular View (Table-in-Table):** Master-detail grid where expanding a master row renders embedded sub-tables for child collections or nested arrays (up to 3 levels deep).
   * **Configurable Display Key / `code` Attribute:** Users configure a primary badge attribute per collection/nested path (defaulting to `code` when present, e.g., rendering `[COVER_FIRE]`, `[LOAD_AGE]` badges on collapsed or nested array items) so domain objects are readable at a glance.

### C. Simple Graph Relation Blueprints & Batched `$in` Engine
* **Saved Relation Blueprints:** Users define simple, visual graph-like links between collections (e.g., `policies._id -> claims.policyId -> claim_items.claimId`) and save them in `litemongo.config.json`.
* **Application-Level `$in` Batching (`server/src/db/batcher.ts`):** Avoids expensive `$lookup` aggregations on production jump hosts:
  1. **Level 1 (Master):** Fetch `N` documents (default limit: 100) from the primary collection.
  2. **Level 2 (Detail):** Extract unique keys in memory and execute **one** query: `db.child.find({ [foreignKey]: { $in: extractedIds } })`.
  3. **Level 3 (Sub-Detail):** Extract Level 2 keys and execute **one** `$in` query against the grandchild collection.

### D. Intelligent Cascading ID Remapping & EJSON Pipeline (`server/src/db/importer.ts`)
When copying documents across environments (e.g., Jump Host -> Local) and pasting with **Renumber / Remap IDs** enabled, the backend executes a **Two-Pass Deterministic Graph Remapper** using `bson` (`EJSON.parse` / `EJSON.stringify`):
1. **Strict BSON Type Preservation:** All serialization over the browser clipboard uses Extended JSON (`EJSON`) so `ObjectId`, `Decimal128`, `ISODate`, `Long`, and `UUID` survive round-trips without degrading into strings.
2. **Pass 1 — Graph Indexing & New ID Generation:**
   * Scans all selected Master documents, batched Detail/Sub-Detail collections, and nested sub-documents containing ID fields (configured via `RelationBlueprint` and schema `idPaths`, e.g., `_id`, `covers[].coverId`).
   * Builds a `Map<SerializedOldId, NewTypedId>` matching the exact original BSON type (`new ObjectId()` for `ObjectId`, new UUIDv4 for `UUID`, or user-defined pattern/prefix rule for custom string/numeric business IDs like `POL-2026-XXXX`).
3. **Pass 2 — Context-Aware Reference Rewriting:**
   * Walks every document and nested array in the bundle.
   * Rewrites soft foreign keys (`policyId`, `parentCoverId`, etc.) **only** when the value matches an entry in the `OldId -> NewId` translation map.
   * **Domain Code Protection:** Fields marked as domain enums/codes (e.g., `loading.code`, `coverType`) are explicitly excluded from remapping so shared reference codes remain intact.
   * **Pre-Paste Dry-Run Preview:** Returns a summary of remapped root IDs, nested array IDs, and updated foreign-key links before committing the insert locally.

### E. Portable JSON Configuration (`litemongo.config.json`)
* Stores user-defined **Collection Schemas** (documenting core/non-changing structural elements, `idPaths`, and `{ code, value }` dictionaries for MongoDB 8 & 9), **Relation Blueprints**, **Nested View Display Rules** (`code` attribute mappings), **Saved Query Presets**, and **ID Renumbering Rules**.
* **1-Click Sync:** Copy to clipboard or download `litemongo.config.json` from the Jump Host instance and paste/import it into the Local environment.

### F. Hybrid Query Builder, App-Level Schema & Quick Inspectors
* **Visual + Raw Dual Mode:** Simple visual filter/projection helper synced two-way with raw **Monaco Editor**.
* **Application-Level Schema Registry:** Drives Monaco autocomplete (`$elemMatch`, nested paths, enum values) and MCP AI context even on MongoDB 8 where DB-level schema descriptions are absent.
* **Distinct Values & Index Viewer:**
  * **Quick Distinct Inspector:** Click any column/field header to view distinct values and frequency counts across the active result set (e.g., all unique `loadings.code` values).
  * **Collection Index Viewer:** Lightweight drawer listing existing indexes (`keys`, `unique`, `sparse`) on the active collection.

### G. Embedded MCP Server (`/mcp`)
* Lightweight MCP server mounted on `/mcp` (SSE/HTTP, strictly read-only) exposing:
  * `list_schemas`: Returns documented JSON schemas (core fields & code/value dictionaries).
  * `list_relations`: Returns configured Master-Detail relation blueprints.
  * `query_master_detail`: Executes a safe read-only query using a saved Relation Blueprint and returns the stitched 2-to-3 level hierarchy.

### H. Phased Roadmap (Post-MVP)
Keep clean module boundaries in Phase 1 so these can be added later without refactoring:
1. **Inline Document Diffing (Low Priority / Phase 2):** Side-by-side EJSON diff viewer comparing two documents or Jump Host vs. Local by ID.
2. **Sensitive Data Masking on Copy/Export (Phase 2):** Configurable PII anonymization rules (`iban`, `ssn`, `email`) applied when copying from Jump Host environments.
3. **In-App LLM Query Assistant (Phase 2+):** Internal `QueryAssistantProvider` interface in `QueryWorkspace.tsx` for natural-language-to-MQL generation.

---

## 5. Directory Structure

```text
litemongo/
├── Dockerfile                      # Multi-stage build for amd64 & arm64
├── docker-compose.yml              # Local dev setup with MongoDB 8 & seed script
├── mongo-seed.js                   # Insurance domain sample data (policies, claims, claim_items)
├── mongo-seed-rich.js              # Rich data: persons, contractors, policies2, claims2 (dynamic attributes)
├── litemongo.config.example.json   # Sample portable workspace config
├── package.json                    # Root workspace scripts
├── server/                         # Fastify Stateless Proxy + MCP Server
│   ├── src/
│   │   ├── index.ts                # Entry point, static UI serving & /mcp mount
│   │   ├── db/
│   │   │   ├── connection.ts       # Stateless TTL-cached MongoClient pool
│   │   │   ├── batcher.ts          # Master-Detail $in query & stitching engine
│   │   │   └── importer.ts         # Two-Pass EJSON graph remapper & paste engine
│   │   ├── mcp/
│   │   │   └── mcpServer.ts        # MCP tools (list_schemas, list_relations, query_master_detail)
│   │   ├── routes/
│   │   │   ├── query.ts            # Find, projection, distinct values & index list endpoints
│   │   │   ├── transfer.ts         # EJSON clipboard bundle export, dry-run & paste endpoints
│   │   │   └── shell.ts            # Script-mode ops (/api/shell/op): one driver call per db.coll.method(); writes RO-guarded
│   │   └── middleware/
│   │       └── readOnly.ts         # Blocks mutations when X-Read-Only or FORCE_READ_ONLY is active
│   └── tsconfig.json
└── client/                         # React + Vite + PWA Frontend
    ├── public/                     # PWA icons and manifest assets
    ├── src/
    │   ├── store/
    │   │   ├── useConnectionStore.ts  # Browser-only connection profiles, safety colors & RO locks
    │   │   ├── useWorkspaceStore.ts   # Portable config (schemas, relation blueprints, presets)
    │   │   └── useTabStore.ts         # Multi-tab query states & view modes
    │   ├── components/
    │   │   ├── TabBar.tsx             # Multi-tab management + color-coded Env Safety Banner
    │   │   ├── QueryWorkspace.tsx     # Hybrid Visual + Monaco Editor + Saved Presets dropdown
    │   │   ├── DataViewer.tsx         # Switcher: Tree vs Flat Table vs Table-in-Table (`code` badges)
    │   │   ├── DistinctPopover.tsx    # Quick distinct value & count inspector for any field
    │   │   ├── IndexDrawer.tsx        # Lightweight collection index viewer
    │   │   ├── RelationBuilder.tsx    # Simple visual graph editor for Master-Detail blueprints
    │   │   ├── ImportExportModal.tsx  # Data clipboard transfer + ID remapper & Config JSON sync
    │   │   └── SchemaManager.tsx      # Document core/non-changing fields & enum dictionaries
    │   ├── hooks/
    │   │   └── useSchemaAutocomplete.ts # Monaco completion provider ($elemMatch, enums)
    │   └── App.tsx
    ├── vite.config.ts              # Includes vite-plugin-pwa config
    └── tsconfig.json
```

---

## 6. Coding Standards & Scope Discipline

* **Build Scope Discipline:** Prioritize a rock-solid **Day-1 Alpha** first (Stateless Proxy + Read-Only Lock + Multi-Tab Query Editor + Tree & Flat Table Views + 2-level Batched `$in` Join + EJSON Copy/Paste with Two-Pass ID Remapping + `litemongo.config.json` loader), then layer on Nested Table-in-Table with `code` badges, Distinct/Index inspectors, and the `/mcp` endpoint.
* **Strict TypeScript:** No `any` types unless wrapping raw dynamic BSON documents (use `Record<string, unknown>` or `Document` from `mongodb`).
* **EJSON Fidelity:** Always serialize/deserialize BSON types (`ObjectId`, `Date`, `Decimal128`, `Long`, `UUID`) using `bson` `EJSON` across API boundaries and clipboard payloads.
* **Zero Credential Leakage:** Never log `X-Mongo-URI` headers or store connection strings on the server filesystem.