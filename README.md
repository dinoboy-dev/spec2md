# spec2md

[![npm version](https://img.shields.io/npm/v/spec2md.svg)](https://www.npmjs.com/package/spec2md)
[![node](https://img.shields.io/node/v/spec2md.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/spec2md.svg)](LICENSE)

**Turn any OpenAPI/Swagger spec — a local file *or* a live URL — into a clean Markdown API reference and a compact, token‑efficient contract that an AI coding agent can read to write correct integration code.**

```bash
npx spec2md https://api.example.com/api-json --split
```

---

## Who is this for?

spec2md is **client‑dev first**. If you build a **mobile, web, or frontend** app against a backend that already exposes Swagger, you point spec2md at that backend's spec URL and generate a contract **inside your own repo, on your own schedule** — no backend changes required.

- **Client devs (primary)** — generate a versioned contract you can read, diff, and hand to your AI agent.
- **AI coding agents (secondary)** — consume the `.mcp.md` file: every endpoint's method, path, auth, inputs, and JSON response shape in a compact form.
- **Backend devs (optional)** — ship the generated contract alongside your API so consumers don't have to.

## What it produces

| File | Audience | Purpose |
| --- | --- | --- |
| `<name>.api.md` | Humans | A readable API reference: TOC, parameter tables, request/response examples. |
| `<name>.mcp.md` | AI agents | A compact, machine‑readable contract optimized to fit in an agent's context. |

## End‑to‑end workflow

```
┌─────────────────────┐     spec URL / file      ┌─────────────────────┐
│   Backend (Swagger) │ ───────────────────────▶ │   Your client repo  │
│  /api-json, /v3/... │                          │   runs `spec2md`    │
└─────────────────────┘                          └──────────┬──────────┘
                                                            │
                              generates a contract you own  │
                                                            ▼
                                          ┌──────────────────────────────┐
                                          │  <name>.api.md   (you read)   │
                                          │  <name>.mcp.md   (agent reads)│
                                          └──────────────┬───────────────┘
                                                         │
                  integrate by hand  ◀───────────────────┼──────────────▶  let your agent
                  using the .api.md                       │                 generate code from
                                                          ▼                 the .mcp.md
                                          ┌──────────────────────────────┐
                                          │ backend ships a new version  │
                                          │   →  `spec2md update`        │
                                          └──────────────────────────────┘
```

## Install

No install required — run it with `npx`:

```bash
npx spec2md <spec|url> [options]
```

Or add it to a project:

```bash
npm i -D spec2md
```

Requires **Node.js ≥ 18**. The only runtime dependency is [`@apidevtools/swagger-parser`](https://www.npmjs.com/package/@apidevtools/swagger-parser).

## Usage

```
spec2md <spec|url> [options]     Convert a local file or a live http(s) URL
spec2md update [dir]             Re-fetch the saved source and regenerate
spec2md init [--agent <name>]    Install agent adapters into the project
spec2md --help
```

| Option | Description |
| --- | --- |
| `--split` | Split the MCP context into one file per tag + an `index.mcp.md`. |
| `--out-md <file>` | Markdown output path (default `<name>.api.md`). |
| `--out-mcp <file>` | MCP output path (default `<name>.mcp.md`). |
| `--out <dir>` | Split output directory (default `<name>-context/`). |
| `--md-only` | Write only the Markdown reference. |
| `--mcp-only` | Write only the MCP context. |
| `--base-url <url>` | Override the API base URL. |
| `--title <text>` | Override the document title. |

`<name>` is the spec file's basename, or a slug of `info.title` when the input is a URL. Default outputs are written **next to the spec file** (or in the current directory for URL input).

### Examples

Convert a local file:

```bash
npx spec2md ./swagger.json
# → swagger.api.md, swagger.mcp.md
```

Convert a live URL and split the context per tag:

```bash
npx spec2md https://api.example.com/api-json --split
# → my-api-context/index.mcp.md
#   my-api-context/auth.mcp.md
#   my-api-context/products.mcp.md
#   my-api-context/.spec2md.json
```

Override the base URL (handy when the spec omits `servers`):

```bash
npx spec2md ./swagger.json --base-url https://api.example.com
```

Refresh later when the backend ships a new version:

```bash
npx spec2md update ./my-api-context
# spec2md: My API version 1.2.0 → 1.3.0
```

> **NestJS tip:** a NestJS backend exposes its spec as JSON. Export it with
> `curl http://localhost:3000/api-json > swagger.json`, or point spec2md straight at that URL.

## Agent adapters (`spec2md init`)

`spec2md init` scaffolds small adapter files that teach an AI agent to call the CLI (the CLI stays the single engine). Each adapter documents file/URL input, the outputs, `--split`, `--base-url`, `update`, and the NestJS export hint.

```bash
npx spec2md init --agent all
```

| Agent | File written | Notes |
| --- | --- | --- |
| `claude` | `.claude/skills/spec2md/SKILL.md` | YAML frontmatter (`name`, `description`). **Default.** |
| `codex` | appends a section to `AGENTS.md` | Idempotent — skips if already present. Aliases: `agents`, `antigravity`. |
| `cursor` | `.cursor/rules/spec2md.mdc` | Frontmatter (`description`, `globs`, `alwaysApply`). |
| `windsurf` | `.windsurf/rules/spec2md.md` | Frontmatter (`trigger`, `description`). |
| `all` | claude + codex + cursor + windsurf | |

```bash
npx spec2md init                      # claude (default)
npx spec2md init --agent cursor       # one agent
npx spec2md init --agent claude --agent codex
```

## Output formats

### `.mcp.md` — compact contract for agents

```
# Shop API — API Integration Context

Machine-readable API contract for integrating a client (mobile / web / agent).
Each endpoint lists method, path, auth, inputs and the shape of the JSON response.

BASE_URL: https://api.example.com
VERSION: 1.2.0

## Auth
- bearer: http/bearer [JWT]
- apiKey: apiKey in header (X-API-Key)

## orders

### POST /orders
Place an order | id=createOrder | auth=bearer
body: {
  items[].productId: string <uuid>!
  items[].quantity: integer! // How many units
  shippingAddress.street: string!
  shippingAddress.country: string! // ISO 3166-1 alpha-2 code
  status: OrderStatus enum("pending", "paid", "shipped", "cancelled")?
}
body_example: {"items":[{"productId":"00000000-0000-0000-0000-000000000000","quantity":0}],...}
returns 201 Order placed
response_example: {"id":"00000000-0000-0000-0000-000000000000","status":"pending",...}
```

Type notation: `!` = required, `?` = optional; arrays `Type[]`; inline enum `enum("a", "b")`; a `$ref` to a named enum becomes `Name enum(...)`; formatted strings show their format, e.g. `string <email>`. Only non‑empty parts are printed.

### `.api.md` — human reference

````markdown
### `POST /auth/login`

Log in with email and password

**operationId:** `authLogin`

**Request Body**

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string <email> | Yes | Account email |
| `password` | string | Yes | Account password |

Example request body:

```json
{
  "email": "user@example.com",
  "password": "string"
}
```
````

## How it works

1. **Load** the spec with `@apidevtools/swagger-parser`: `validate()` first (warnings only — a slightly off spec is still worth documenting), then `bundle()`. Bundling resolves external/multi‑file `$ref`s but **keeps internal `#/components/schemas` refs**, so type names survive in the output. swagger‑parser also fetches `http(s)` URLs and parses YAML directly.
2. **Normalize** across dialects: **OpenAPI 3.x** (including 3.1, where `type` can be an array like `["string","null"]` — the first non‑null wins) and basic **Swagger 2.0** (`definitions`, `in: body` params, `host`/`basePath`/`schemes`).
3. **Resolve `$ref`s** with a cache and a cycle guard. Nested object/array fields recurse into the **resolved target**, so deep shapes expand instead of stopping at the first hop. A `$ref` to a plain enum is inlined as `Name enum(...)`.
4. **Generate examples** from each schema: honoring `example`/`default`/`enum[0]`, mapping formats (`date-time`, `date`, `email`, `uuid`) to realistic values, merging `allOf`, taking the first of `oneOf`/`anyOf`, with a depth cap.
5. **Group** endpoints by their first tag (untagged → `default`) and **render** both files.
6. **Record** a `.spec2md.json` manifest next to the outputs so `spec2md update` can re‑run against the same source with the same options.

Zero TypeScript, zero build step, CommonJS, one runtime dependency.

## Demo: a real client built from the output

[`examples/weather-ui/index.html`](examples/weather-ui/index.html) is a single‑file web app that calls the public [Open‑Meteo](https://open-meteo.com/) Forecast API (`GET /v1/forecast`, no API key, CORS‑enabled). The integration code was written by reading a spec2md‑generated `.mcp.md` contract.

```bash
# Generate the contract the demo was written from:
npx spec2md https://raw.githubusercontent.com/open-meteo/open-meteo/main/openapi.yml --mcp-only

# Then just open the demo in a browser — no server needed:
open examples/weather-ui/index.html
```

## Develop

```bash
npm install
npm test      # zero-framework smoke test over examples/swagger.json
npm run example
```

## License

[MIT](LICENSE)
