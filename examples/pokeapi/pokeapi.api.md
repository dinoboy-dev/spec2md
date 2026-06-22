# PokeAPI (subset)

**Version:** 2.0.0

A hand-written OpenAPI contract for the slice of the public PokeAPI (https://pokeapi.co) used by the demo Pokedex app. PokeAPI needs no API key and sends permissive CORS headers, so a browser can call it directly.
This file is the *input* to spec2md. Run `npx spec2md examples/pokeapi/pokeapi.yaml` to regenerate the committed pokeapi.api.md / pokeapi.mcp.md next to it.


**Base URL:** `https://pokeapi.co/api/v2`

## Endpoints

**pokemon**

- [`GET /pokemon`](#get-pokemon) — List Pokemon (paginated)
- [`GET /pokemon/{name}`](#get-pokemonname) — Get a Pokemon by name or id

**types**

- [`GET /type/{name}`](#get-typename) — Get a damage type by name

## pokemon

### `GET /pokemon`

List Pokemon (paginated)

**operationId:** `listPokemon`

**Query Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `limit` | integer | No | How many results per page |
| `offset` | integer | No | Offset into the full list |

**Responses**

- `200` — A page of named resources

Example response (`200`):

```json
{
  "count": 0,
  "next": "string",
  "previous": "string",
  "results": [
    {
      "name": "string",
      "url": "string"
    }
  ]
}
```

---

### `GET /pokemon/{name}`

Get a Pokemon by name or id

**operationId:** `getPokemon`

**Path Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Pokemon name (e.g. "pikachu") or numeric id |

**Responses**

- `200` — The Pokemon
- `404` — Not found

Example response (`200`):

```json
{
  "id": 0,
  "name": "string",
  "base_experience": 0,
  "height": 0,
  "weight": 0,
  "sprites": {
    "front_default": "string",
    "front_shiny": "string"
  },
  "types": [
    {
      "slot": 0,
      "type": {
        "name": "string",
        "url": "string"
      }
    }
  ],
  "stats": [
    {
      "base_stat": 0,
      "effort": 0,
      "stat": {
        "name": "string",
        "url": "string"
      }
    }
  ],
  "abilities": [
    {
      "is_hidden": true,
      "slot": 0,
      "ability": {
        "name": "string",
        "url": "string"
      }
    }
  ]
}
```

---

## types

### `GET /type/{name}`

Get a damage type by name

**operationId:** `getType`

**Path Parameters**

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| `name` | string | Yes | Type name (e.g. "fire") |

**Responses**

- `200` — The type and its damage relations

Example response (`200`):

```json
{
  "id": 0,
  "name": "string",
  "damage_relations": {
    "double_damage_from": [
      {
        "name": "string",
        "url": "string"
      }
    ],
    "double_damage_to": [
      {
        "name": "string",
        "url": "string"
      }
    ]
  }
}
```

---

