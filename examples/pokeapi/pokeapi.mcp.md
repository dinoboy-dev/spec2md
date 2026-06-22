# PokeAPI (subset) — API Integration Context

Machine-readable API contract for integrating a client (mobile / web / agent).
Each endpoint lists method, path, auth, inputs and the shape of the JSON response.

BASE_URL: https://pokeapi.co/api/v2
VERSION: 2.0.0

## pokemon

### GET /pokemon
List Pokemon (paginated) | id=listPokemon
params: limit:query:integer?, offset:query:integer?
returns 200 A page of named resources
response_example: {"count":0,"next":"string","previous":"string","results":[{"name":"string","url":"string"}]}

### GET /pokemon/{name}
Get a Pokemon by name or id | id=getPokemon
params: name:path:string!
returns 200 The Pokemon
response_example: {"id":0,"name":"string","base_experience":0,"height":0,"weight":0,"sprites":{"front_default":"string","front_shiny":"string"},"types":[{"slot":0,"type":{"name":"string","url":"string"}}],"stats":[{"base_stat":0,"effort":0,"stat":{"name":"string","url":"string"}}],"abilities":[{"is_hidden":true,"slot":0,"ability":{"name":"string","url":"string"}}]}

## types

### GET /type/{name}
Get a damage type by name | id=getType
params: name:path:string!
returns 200 The type and its damage relations
response_example: {"id":0,"name":"string","damage_relations":{"double_damage_from":[{"name":"string","url":"string"}],"double_damage_to":[{"name":"string","url":"string"}]}}
