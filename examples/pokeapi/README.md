# End-to-end example: PokeAPI → spec2md → a Pokédex

This folder shows the **whole spec2md workflow** in one place — from an OpenAPI
spec, to the generated contract, to a working app written from that contract.

```
examples/pokeapi/
├── pokeapi.yaml      # 1. INPUT  — an OpenAPI 3.0 spec for the PokeAPI subset we use
├── pokeapi.api.md    # 2. OUTPUT — human-readable reference   (generated, committed)
├── pokeapi.mcp.md    # 2. OUTPUT — compact agent contract     (generated, committed)
└── app/index.html    # 3. RESULT — a single-file Pokédex built from pokeapi.mcp.md
```

## 1. The input spec

[`pokeapi.yaml`](pokeapi.yaml) is a hand-written OpenAPI contract for the slice of
the public [PokeAPI](https://pokeapi.co) the demo needs: `GET /pokemon`,
`GET /pokemon/{name}`, and `GET /type/{name}`. It exercises the features spec2md
cares about — `$ref`s, arrays of objects (`types[]`, `stats[]`), nested objects
(`sprites`), pagination params, and nullable fields.

> Many real backends expose their spec at a URL (NestJS: `http://localhost:3000/api-json`).
> When they do, you skip this step and point spec2md straight at the URL.

## 2. Generate the contract

From the repository root:

```bash
npx spec2md examples/pokeapi/pokeapi.yaml
# → wrote examples/pokeapi/pokeapi.api.md
#   wrote examples/pokeapi/pokeapi.mcp.md
```

The two `.md` files in this folder are exactly what that command produces (checked
in so you can read them without running anything). Here is the endpoint the app
was built from, as it appears in [`pokeapi.mcp.md`](pokeapi.mcp.md):

```
BASE_URL: https://pokeapi.co/api/v2

### GET /pokemon/{name}
Get a Pokemon by name or id | id=getPokemon
params: name:path:string!
returns 200 The Pokemon
response_example: {"id":0,"name":"string","height":0,"weight":0,
  "sprites":{"front_default":"string", ...},
  "types":[{"slot":0,"type":{"name":"string","url":"string"}}],
  "stats":[{"base_stat":0,"stat":{"name":"string", ...}}], ...}
```

That single block tells an integrator (human or AI agent) everything needed: the
method, the path, that `name` is a required path param, and the exact JSON shape
to expect back — including the nested `sprites`, `types[]`, and `stats[]`.

## 3. The app

[`app/index.html`](app/index.html) is a self-contained Pokédex written from that
contract: search a Pokémon, see its sprite, types, base stats and abilities. It
reads the same fields the `response_example` advertises, so the code and the
contract stay in lock-step.

Open it directly — no build, no server, no API key:

```bash
open examples/pokeapi/app/index.html      # macOS
# or just double-click the file
```

## 4. Keeping it fresh

Every convert drops a `.spec2md.json` manifest next to the outputs (git-ignored
here because it stores an absolute path). With it, refreshing after the spec
changes is one command:

```bash
npx spec2md update examples/pokeapi
# spec2md: PokeAPI (subset) version 2.0.0 → 2.1.0   (or "unchanged")
```

That is the full loop: **spec → `spec2md` → contract → integrate → `update`.**
