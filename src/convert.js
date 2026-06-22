'use strict';

/**
 * spec2md conversion engine.
 *
 * Loads an OpenAPI/Swagger spec (file or live URL), builds a normalized model
 * of its endpoints, and renders two deliverables:
 *   - a human-readable Markdown API reference (renderMarkdown)
 *   - a compact, token-efficient MCP context file (renderMcp / renderMcpSplit)
 *
 * The only runtime dependency is @apidevtools/swagger-parser. When it is not
 * installed we fall back to parsing local JSON / single-file YAML by hand.
 */

const fs = require('fs');
const path = require('path');

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'];
const DEPTH_CAP = 6;
const URL_RE = /^https?:\/\//i;

function isUrl(input) {
  return URL_RE.test(String(input));
}

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

async function loadSpec(input) {
  let SwaggerParser = null;
  try {
    SwaggerParser = require('@apidevtools/swagger-parser');
  } catch (_) {
    SwaggerParser = null;
  }

  if (SwaggerParser) {
    // Validate first, but only warn: a slightly non-compliant spec is still
    // worth documenting, and 3.1 specs may trip older validators.
    try {
      await SwaggerParser.validate(input);
    } catch (err) {
      process.stderr.write(`spec2md: warning: spec validation reported issues: ${err.message}\n`);
    }
    // bundle() resolves external/multi-file refs but keeps internal
    // #/components/schemas refs intact, so type names survive in the output.
    return SwaggerParser.bundle(input);
  }

  // Fallback path: the dependency is missing.
  if (isUrl(input)) {
    throw new Error(
      'Fetching a URL requires @apidevtools/swagger-parser. Run "npm i @apidevtools/swagger-parser".'
    );
  }
  const raw = fs.readFileSync(input, 'utf8');
  return parseJsonOrYaml(raw);
}

function parseJsonOrYaml(raw) {
  const text = raw.replace(/^﻿/, '');
  try {
    return JSON.parse(text);
  } catch (_) {
    return parseYaml(text);
  }
}

// ---------------------------------------------------------------------------
// $ref resolution (cached, cycle-guarded by callers)
// ---------------------------------------------------------------------------

function refName(ref) {
  const parts = String(ref).split('/');
  return decodePointer(parts[parts.length - 1]);
}

function decodePointer(token) {
  return decodeURIComponent(String(token).replace(/~1/g, '/').replace(/~0/g, '~'));
}

function makeResolve(root) {
  const cache = new Map();
  return function resolve(ref) {
    if (cache.has(ref)) return cache.get(ref);
    const tokens = String(ref).replace(/^#\//, '').split('/').map(decodePointer);
    let cur = root;
    for (const t of tokens) {
      if (cur == null) break;
      cur = cur[t];
    }
    const value = cur == null ? null : cur;
    cache.set(ref, value);
    return value;
  };
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

// OpenAPI 3.1 allows `type` to be an array such as ["string","null"]. We take
// the first non-null entry so the rest of the renderer can treat it as scalar.
function normalizeType(t) {
  if (Array.isArray(t)) {
    const nonNull = t.filter((x) => x !== 'null');
    return nonNull[0] !== undefined ? nonNull[0] : t[0];
  }
  return t;
}

// Merge an `allOf` composite into a single schema (properties + required).
function mergeAllOf(schema, resolve, seen) {
  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.allOf)) return schema;
  const merged = {};
  const props = {};
  const required = [];
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'allOf') continue;
    if (k === 'properties') Object.assign(props, v);
    else if (k === 'required') required.push(...v);
    else merged[k] = v;
  }
  for (let sub of schema.allOf) {
    if (sub && sub.$ref) {
      if (seen && seen.has(sub.$ref)) continue;
      sub = resolve(sub.$ref) || {};
    }
    sub = mergeAllOf(sub, resolve, seen) || sub;
    if (sub.properties) Object.assign(props, sub.properties);
    if (sub.required) required.push(...sub.required);
    for (const [k, v] of Object.entries(sub)) {
      if (k === 'properties' || k === 'required' || k === 'allOf') continue;
      if (!(k in merged)) merged[k] = v;
    }
  }
  if (Object.keys(props).length) merged.properties = props;
  if (required.length) merged.required = [...new Set(required)];
  if (!merged.type && merged.properties) merged.type = 'object';
  return merged;
}

// Follow a `$ref` one level (cycle-guarded) and merge any allOf. Returns the
// resolved schema, the updated seen-set, and a cycle flag.
function follow(raw, resolve, seen) {
  if (raw && raw.$ref) {
    if (seen.has(raw.$ref)) return { schema: {}, seen, cyc: true };
    const seen2 = new Set(seen);
    seen2.add(raw.$ref);
    let s = resolve(raw.$ref) || {};
    s = mergeAllOf(s, resolve, seen2) || s;
    return { schema: s, seen: seen2, cyc: false };
  }
  const s = mergeAllOf(raw || {}, resolve, seen) || raw || {};
  return { schema: s, seen, cyc: false };
}

function enumValues(list) {
  return list.map((v) => (typeof v === 'string' ? `"${v}"` : String(v))).join(', ');
}

// Compact, single-token type label used in the .mcp.md (and the .api.md
// type columns). Examples: `Type[]`, `enum("a","b")`, `Name enum(...)`,
// `string <email>`.
function typeLabel(schema, resolve) {
  if (!schema || typeof schema !== 'object') return 'any';
  if (schema.$ref) {
    const name = refName(schema.$ref);
    const target = resolve(schema.$ref);
    if (target && Array.isArray(target.enum)) {
      return `${name} enum(${enumValues(target.enum)})`;
    }
    return name;
  }
  if (Array.isArray(schema.enum)) {
    return `enum(${enumValues(schema.enum)})`;
  }
  const type = normalizeType(schema.type);
  if (type === 'array') {
    const items = schema.items || {};
    return `${typeLabel(items, resolve)}[]`;
  }
  if (schema.format && (type === 'string' || type === undefined)) {
    return `string <${schema.format}>`;
  }
  if (type) return type;
  if (schema.properties) return 'object';
  return 'any';
}

// ---------------------------------------------------------------------------
// Body field flattening (shared by .mcp.md and .api.md)
// ---------------------------------------------------------------------------

// Returns a flat list of { path, type, required, description }. Nested objects
// become dotted paths; arrays of objects use `field[].child`.
function flattenBodyFields(schema, resolve) {
  const fields = [];
  const { schema: top } = follow(schema, resolve, new Set());
  if (!top) return fields;
  const t = normalizeType(top.type);
  if (t === 'object' || (top.properties && Object.keys(top.properties).length)) {
    walkObject(top, '', fields, resolve, new Set(), 0);
  } else if (t === 'array' || top.items) {
    // Top-level array body: walk its item shape under an empty prefix.
    walkProp('', { type: 'array', items: top.items }, '', false, fields, resolve, new Set(), 0);
  }
  return fields;
}

function walkObject(obj, prefix, fields, resolve, seen, depth) {
  if (depth > DEPTH_CAP) return;
  const props = obj.properties || {};
  const required = new Set(obj.required || []);
  for (const [name, raw] of Object.entries(props)) {
    walkProp(name, raw, prefix, required.has(name), fields, resolve, seen, depth);
  }
}

function walkProp(name, raw, prefix, isRequired, fields, resolve, seen, depth) {
  const pathKey = prefix ? (name ? `${prefix}.${name}` : prefix) : name;

  // A $ref pointing straight at a named enum is inlined so callers see the
  // allowed values rather than an opaque type name.
  if (raw && raw.$ref) {
    const target = resolve(raw.$ref);
    if (target && Array.isArray(target.enum)) {
      push(fields, pathKey, `${refName(raw.$ref)} enum(${enumValues(target.enum)})`, isRequired, raw.description || target.description);
      return;
    }
  }

  const { schema, seen: seen2, cyc } = follow(raw, resolve, seen);
  if (cyc) {
    push(fields, pathKey, raw.$ref ? refName(raw.$ref) : 'object', isRequired, raw && raw.description);
    return;
  }

  const type = normalizeType(schema.type);

  if (type === 'array' || (!type && schema.items)) {
    handleArray(pathKey, schema, isRequired, raw, fields, resolve, seen2, depth);
    return;
  }

  if ((type === 'object' || schema.properties) && schema.properties && Object.keys(schema.properties).length) {
    // Recurse into the resolved target (not the {$ref} wrapper) so nested
    // fields expand instead of tripping the cycle guard on the first hop.
    walkObject(schema, pathKey, fields, resolve, seen2, depth + 1);
    return;
  }

  const label = Array.isArray(schema.enum) ? `enum(${enumValues(schema.enum)})` : typeLabel(schema, resolve);
  push(fields, pathKey, label, isRequired, (raw && raw.description) || schema.description);
}

function handleArray(pathKey, schema, isRequired, raw, fields, resolve, seen, depth) {
  const itemsRaw = schema.items || {};

  if (itemsRaw.$ref) {
    const target = resolve(itemsRaw.$ref);
    if (target && Array.isArray(target.enum)) {
      push(fields, pathKey, `${refName(itemsRaw.$ref)} enum(${enumValues(target.enum)})[]`, isRequired, schema.description);
      return;
    }
  }

  const { schema: itemSchema, seen: seen2, cyc } = follow(itemsRaw, resolve, seen);
  if (cyc) {
    push(fields, pathKey, `${refName(itemsRaw.$ref)}[]`, isRequired, schema.description);
    return;
  }

  const itemType = normalizeType(itemSchema.type);
  if ((itemType === 'object' || itemSchema.properties) && itemSchema.properties && Object.keys(itemSchema.properties).length) {
    walkObject(itemSchema, `${pathKey}[]`, fields, resolve, seen2, depth + 1);
  } else {
    const label = Array.isArray(itemSchema.enum)
      ? `enum(${enumValues(itemSchema.enum)})`
      : typeLabel(itemsRaw.$ref ? itemsRaw : itemSchema, resolve);
    push(fields, pathKey, `${label}[]`, isRequired, schema.description);
  }
}

function push(fields, pathKey, type, required, description) {
  fields.push({ path: pathKey, type, required: !!required, description: description || '' });
}

// ---------------------------------------------------------------------------
// Example generation
// ---------------------------------------------------------------------------

function genExample(schema, resolve, seen, depth) {
  if (depth > DEPTH_CAP || !schema || typeof schema !== 'object') return undefined;

  if (schema.$ref) {
    if (seen.has(schema.$ref)) return undefined;
    const next = new Set(seen);
    next.add(schema.$ref);
    return genExample(resolve(schema.$ref) || {}, resolve, next, depth);
  }

  if (Array.isArray(schema.allOf)) schema = mergeAllOf(schema, resolve, seen);

  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return genExample(schema.oneOf[0], resolve, seen, depth);
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return genExample(schema.anyOf[0], resolve, seen, depth);

  const type = normalizeType(schema.type);

  if (type === 'object' || (!type && schema.properties)) {
    const obj = {};
    for (const [k, v] of Object.entries(schema.properties || {})) {
      const val = genExample(v, resolve, seen, depth + 1);
      if (val !== undefined) obj[k] = val;
    }
    return obj;
  }

  if (type === 'array' || (!type && schema.items)) {
    const item = genExample(schema.items || {}, resolve, seen, depth + 1);
    return item === undefined ? [] : [item];
  }

  return scalarExample(type, schema.format);
}

function scalarExample(type, format) {
  if (type === 'string' || type === undefined) {
    switch (format) {
      case 'date-time': return '2024-01-01T00:00:00.000Z';
      case 'date': return '2024-01-01';
      case 'email': return 'user@example.com';
      case 'uuid': return '00000000-0000-0000-0000-000000000000';
      default: return 'string';
    }
  }
  if (type === 'integer' || type === 'number') return 0;
  if (type === 'boolean') return true;
  return null;
}

// ---------------------------------------------------------------------------
// Model building (collectOps)
// ---------------------------------------------------------------------------

function collectOps(api, options = {}) {
  const isV2 = !!api.swagger && /^2/.test(String(api.swagger));
  const resolve = makeResolve(api);
  const info = api.info || {};
  const title = options.title || info.title || 'API';
  const version = info.version || '';
  const baseUrl = options.baseUrl || deriveBaseUrl(api, isV2) || '{BASE_URL}';
  const security = parseSecuritySchemes(api, isV2);
  const rootSecurity = api.security;

  const ops = [];
  const paths = api.paths || {};
  for (const [route, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const pathParams = pathItem.parameters || [];
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op || typeof op !== 'object') continue;
      ops.push(buildOp(method, route, op, pathParams, { resolve, isV2, rootSecurity }));
    }
  }

  // Group endpoints by their first tag (untagged -> "default"), preserving the
  // order tags first appear in.
  const tagOrder = [];
  const byTag = new Map();
  for (const op of ops) {
    const tag = (op.tags && op.tags[0]) || 'default';
    if (!byTag.has(tag)) {
      byTag.set(tag, []);
      tagOrder.push(tag);
    }
    byTag.get(tag).push(op);
  }

  return { isV2, resolve, info, title, version, baseUrl, security, ops, tagOrder, byTag };
}

function buildOp(method, route, op, pathParams, ctx) {
  const { resolve, isV2, rootSecurity } = ctx;
  const merged = mergeParams(pathParams, op.parameters || []);

  let bodySchema = null;
  const params = [];
  for (const raw of merged) {
    const param = raw && raw.$ref ? resolve(raw.$ref) : raw;
    if (!param) continue;
    if (isV2 && param.in === 'body') bodySchema = param.schema || null;
    else params.push(param);
  }

  if (!isV2 && op.requestBody) {
    const rb = op.requestBody.$ref ? resolve(op.requestBody.$ref) : op.requestBody;
    bodySchema = pickJsonSchema(rb);
  }

  const sec = op.security !== undefined ? op.security : rootSecurity || [];
  const schemes = [];
  for (const req of sec || []) {
    for (const name of Object.keys(req || {})) {
      if (!schemes.includes(name)) schemes.push(name);
    }
  }

  return {
    method: method.toUpperCase(),
    route,
    summary: op.summary || '',
    description: op.description || '',
    operationId: op.operationId || '',
    deprecated: !!op.deprecated,
    tags: op.tags || [],
    params,
    bodySchema,
    responses: op.responses || {},
    schemes,
  };
}

function mergeParams(pathLevel, opLevel) {
  const map = new Map();
  const keyOf = (p) => (p && p.$ref ? `ref:${p.$ref}` : `${p && p.in}:${p && p.name}`);
  for (const p of pathLevel) map.set(keyOf(p), p);
  for (const p of opLevel) map.set(keyOf(p), p);
  return [...map.values()];
}

function pickJsonSchema(requestBody) {
  if (!requestBody || !requestBody.content) return null;
  const content = requestBody.content;
  if (content['application/json'] && content['application/json'].schema) {
    return content['application/json'].schema;
  }
  for (const c of Object.values(content)) {
    if (c && c.schema) return c.schema;
  }
  return null;
}

function deriveBaseUrl(api, isV2) {
  if (isV2) {
    if (!api.host) return null;
    const scheme = (api.schemes && api.schemes[0]) || 'https';
    return `${scheme}://${api.host}${api.basePath || ''}`;
  }
  if (Array.isArray(api.servers) && api.servers[0] && api.servers[0].url) {
    return api.servers[0].url;
  }
  return null;
}

function parseSecuritySchemes(api, isV2) {
  const defs = isV2
    ? api.securityDefinitions || {}
    : (api.components && api.components.securitySchemes) || {};
  const out = [];
  for (const [schemeKey, def] of Object.entries(defs)) {
    out.push(Object.assign({ schemeKey }, def));
  }
  return out;
}

function paramTypeLabel(param, resolve) {
  if (param.schema) return typeLabel(param.schema, resolve);
  // Swagger 2.0 style: type/format/items live directly on the parameter.
  return typeLabel({ type: param.type, format: param.format, items: param.items, enum: param.enum }, resolve);
}

function pickSuccess(responses) {
  const keys = Object.keys(responses || {});
  const twoxx = keys.filter((k) => /^2\d\d$/.test(k)).sort();
  if (twoxx.length) return [twoxx[0], responses[twoxx[0]]];
  if (responses && responses.default) return ['default', responses.default];
  if (keys.length) return [keys[0], responses[keys[0]]];
  return null;
}

function responseSchema(resp, isV2) {
  if (!resp) return null;
  if (isV2) return resp.schema || null;
  if (!resp.content) return null;
  if (resp.content['application/json'] && resp.content['application/json'].schema) {
    return resp.content['application/json'].schema;
  }
  for (const c of Object.values(resp.content)) {
    if (c && c.schema) return c.schema;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function mdCell(s) {
  return s ? oneLine(s).replace(/\|/g, '\\|') : '';
}

function escPipe(s) {
  return String(s).replace(/\|/g, '\\|');
}

// GitHub-flavored heading anchor (lower-case, punctuation stripped, spaces -> -).
function anchor(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function slug(s) {
  return (
    String(s)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'api'
  );
}

// ---------------------------------------------------------------------------
// .mcp.md rendering
// ---------------------------------------------------------------------------

function mcpHeader(title, baseUrl, version) {
  return [
    `# ${title} — API Integration Context`,
    '',
    'Machine-readable API contract for integrating a client (mobile / web / agent).',
    'Each endpoint lists method, path, auth, inputs and the shape of the JSON response.',
    '',
    `BASE_URL: ${baseUrl}`,
    `VERSION: ${version}`,
  ];
}

function authLine(s) {
  let label = s.type || '';
  if (s.scheme) label += `/${s.scheme}`;
  let str = `- ${s.schemeKey}: ${label}`;
  if (s.in) {
    str += ` in ${s.in}`;
    if (s.name) str += ` (${s.name})`;
  }
  if (s.bearerFormat) str += ` [${s.bearerFormat}]`;
  return str;
}

function renderOpBlock(op, model) {
  const { resolve, isV2 } = model;
  const out = [`### ${op.method} ${op.route}`];

  const meta = [];
  if (op.summary) meta.push(op.summary);
  if (op.operationId) meta.push(`id=${op.operationId}`);
  if (op.schemes.length) meta.push(`auth=${op.schemes.join(',')}`);
  if (op.deprecated) meta.push('DEPRECATED');
  if (meta.length) out.push(meta.join(' | '));

  if (op.params.length) {
    const parts = op.params.map((p) => {
      const mark = p.required ? '!' : '?';
      return `${p.name}:${p.in}:${paramTypeLabel(p, resolve)}${mark}`;
    });
    out.push(`params: ${parts.join(', ')}`);
  }

  if (op.bodySchema) {
    const fields = flattenBodyFields(op.bodySchema, resolve);
    if (fields.length) {
      out.push('body: {');
      for (const f of fields) {
        let line = `  ${f.path}: ${f.type}${f.required ? '!' : '?'}`;
        if (f.description) line += ` // ${oneLine(f.description)}`;
        out.push(line);
      }
      out.push('}');
      const ex = genExample(op.bodySchema, resolve, new Set(), 0);
      if (ex !== undefined && ex !== null) out.push(`body_example: ${JSON.stringify(ex)}`);
    }
  }

  const success = pickSuccess(op.responses);
  if (success) {
    const [code, rawResp] = success;
    const resp = rawResp && rawResp.$ref ? resolve(rawResp.$ref) : rawResp;
    const desc = (resp && resp.description) || '';
    out.push(`returns ${code}${desc ? ' ' + oneLine(desc) : ''}`);
    const rs = responseSchema(resp, isV2);
    if (rs) {
      const ex = genExample(rs, resolve, new Set(), 0);
      if (ex !== undefined && ex !== null) out.push(`response_example: ${JSON.stringify(ex)}`);
    }
  }

  return out.join('\n');
}

function renderMcp(model) {
  const out = mcpHeader(model.title, model.baseUrl, model.version);
  if (model.security.length) {
    out.push('', '## Auth');
    for (const s of model.security) out.push(authLine(s));
  }
  for (const tag of model.tagOrder) {
    out.push('', `## ${tag}`);
    for (const op of model.byTag.get(tag)) {
      out.push('', renderOpBlock(op, model));
    }
  }
  return out.join('\n') + '\n';
}

function renderMcpSplit(model) {
  const files = [];
  const tagFile = (tag) => `${slug(tag)}.mcp.md`;

  // index.mcp.md — header + Auth + a list of tag files and their endpoints.
  const idx = mcpHeader(model.title, model.baseUrl, model.version);
  if (model.security.length) {
    idx.push('', '## Auth');
    for (const s of model.security) idx.push(authLine(s));
  }
  idx.push('', '## Endpoint files');
  for (const tag of model.tagOrder) {
    idx.push('', `### [${tag}](${tagFile(tag)})`);
    for (const op of model.byTag.get(tag)) {
      idx.push(`- ${op.method} ${op.route}${op.summary ? ' — ' + oneLine(op.summary) : ''}`);
    }
  }
  files.push({ name: 'index.mcp.md', content: idx.join('\n') + '\n' });

  // One self-contained file per tag.
  for (const tag of model.tagOrder) {
    const out = [
      `# ${model.title} — ${tag} — API Integration Context`,
      '',
      `BASE_URL: ${model.baseUrl}`,
      `VERSION: ${model.version}`,
      '',
      `## ${tag}`,
    ];
    for (const op of model.byTag.get(tag)) {
      out.push('', renderOpBlock(op, model));
    }
    files.push({ name: tagFile(tag), content: out.join('\n') + '\n' });
  }

  return files;
}

// ---------------------------------------------------------------------------
// .api.md rendering
// ---------------------------------------------------------------------------

function renderMarkdown(model) {
  const out = [`# ${model.title}`, ''];
  if (model.version) out.push(`**Version:** ${model.version}`, '');
  if (model.info.description) out.push(model.info.description, '');
  out.push(`**Base URL:** \`${model.baseUrl}\``, '');

  // Table of contents grouped by tag.
  out.push('## Endpoints', '');
  for (const tag of model.tagOrder) {
    out.push(`**${tag}**`, '');
    for (const op of model.byTag.get(tag)) {
      const text = `${op.method} ${op.route}`;
      const link = `- [\`${text}\`](#${anchor(text)})`;
      out.push(op.summary ? `${link} — ${oneLine(op.summary)}` : link);
    }
    out.push('');
  }

  for (const tag of model.tagOrder) {
    out.push(`## ${tag}`, '');
    for (const op of model.byTag.get(tag)) renderOpMarkdown(op, model, out);
  }

  return out.join('\n') + '\n';
}

function renderOpMarkdown(op, model, out) {
  const { resolve, isV2 } = model;
  out.push(`### \`${op.method} ${op.route}\``, '');
  if (op.deprecated) out.push('> **Deprecated**', '');
  if (op.summary) out.push(op.summary, '');
  if (op.description && op.description !== op.summary) out.push(op.description, '');
  if (op.operationId) out.push(`**operationId:** \`${op.operationId}\``, '');
  if (op.schemes.length) out.push(`🔒 Auth required: ${op.schemes.join(', ')}`, '');

  const groups = { path: [], query: [], header: [] };
  for (const p of op.params) {
    if (groups[p.in]) groups[p.in].push(p);
  }
  for (const [loc, heading] of [['path', 'Path Parameters'], ['query', 'Query Parameters'], ['header', 'Header Parameters']]) {
    if (!groups[loc].length) continue;
    out.push(`**${heading}**`, '', '| Name | Type | Required | Description |', '| --- | --- | --- | --- |');
    for (const p of groups[loc]) {
      out.push(`| \`${p.name}\` | ${escPipe(paramTypeLabel(p, resolve))} | ${p.required ? 'Yes' : 'No'} | ${mdCell(p.description)} |`);
    }
    out.push('');
  }

  if (op.bodySchema) {
    const fields = flattenBodyFields(op.bodySchema, resolve);
    if (fields.length) {
      out.push('**Request Body**', '', '| Field | Type | Required | Description |', '| --- | --- | --- | --- |');
      for (const f of fields) {
        out.push(`| \`${f.path}\` | ${escPipe(f.type)} | ${f.required ? 'Yes' : 'No'} | ${mdCell(f.description)} |`);
      }
      out.push('');
      const ex = genExample(op.bodySchema, resolve, new Set(), 0);
      if (ex !== undefined && ex !== null) {
        out.push('Example request body:', '', '```json', JSON.stringify(ex, null, 2), '```', '');
      }
    }
  }

  const respKeys = Object.keys(op.responses || {});
  if (respKeys.length) {
    out.push('**Responses**', '');
    for (const code of respKeys) {
      const r = op.responses[code] && op.responses[code].$ref ? resolve(op.responses[code].$ref) : op.responses[code];
      out.push(`- \`${code}\` — ${mdCell((r && r.description) || '')}`);
    }
    out.push('');
    const success = pickSuccess(op.responses);
    if (success) {
      const resp = success[1] && success[1].$ref ? resolve(success[1].$ref) : success[1];
      const rs = responseSchema(resp, isV2);
      if (rs) {
        const ex = genExample(rs, resolve, new Set(), 0);
        if (ex !== undefined && ex !== null) {
          out.push(`Example response (\`${success[0]}\`):`, '', '```json', JSON.stringify(ex, null, 2), '```', '');
        }
      }
    }
  }

  out.push('---', '');
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function deriveName(input, model) {
  if (isUrl(input)) return slug(model.title);
  const base = path.basename(String(input)).replace(/\.(json|ya?ml)$/i, '');
  return base || 'api';
}

async function convertFile(input, options = {}) {
  const api = await loadSpec(input);
  const model = collectOps(api, options);
  const result = {
    name: options.name || deriveName(input, model),
    title: model.title,
    baseUrl: model.baseUrl,
    version: model.version,
    ops: model.ops,
    tags: model.tagOrder,
    markdown: renderMarkdown(model),
    mcp: renderMcp(model),
    model,
  };
  if (options.split) result.split = renderMcpSplit(model);
  return result;
}

// ---------------------------------------------------------------------------
// Minimal YAML fallback (used only when the dependency is missing)
// ---------------------------------------------------------------------------

function parseYaml(text) {
  const lines = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripYamlComment(rawLine);
    if (line.trim() === '') continue;
    lines.push({ indent: line.length - line.replace(/^\s+/, '').length, content: line.trim() });
  }

  let pos = 0;

  function parseBlock(minIndent) {
    if (pos >= lines.length || lines[pos].indent < minIndent) return null;
    const c = lines[pos].content;
    if (c === '-' || c.startsWith('- ')) return parseSeq(lines[pos].indent);
    return parseMap(lines[pos].indent);
  }

  function parseSeq(indent) {
    const arr = [];
    while (pos < lines.length && lines[pos].indent === indent && (lines[pos].content === '-' || lines[pos].content.startsWith('- '))) {
      const ln = lines[pos];
      const rest = ln.content === '-' ? '' : ln.content.slice(2);
      if (rest === '') {
        pos++;
        arr.push(parseBlock(indent + 1));
      } else if (/^[^:\s].*?:(\s|$)/.test(rest)) {
        // Map item whose first key shares the dash line. Re-seat it indented.
        lines[pos] = { indent: indent + 2, content: rest };
        arr.push(parseMap(indent + 2));
      } else {
        pos++;
        arr.push(parseScalar(rest));
      }
    }
    return arr;
  }

  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length && lines[pos].indent === indent && lines[pos].content !== '-' && !lines[pos].content.startsWith('- ')) {
      const m = lines[pos].content.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[^:]+?)\s*:(.*)$/);
      if (!m) { pos++; continue; }
      const key = String(parseScalar(m[1].trim()));
      const valuePart = m[2].trim();
      pos++;
      if (valuePart === '') {
        const child = parseBlock(indent + 1);
        obj[key] = child === null ? null : child;
      } else {
        obj[key] = parseScalar(valuePart);
      }
    }
    return obj;
  }

  return parseBlock(0) || {};
}

function stripYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseScalar(s) {
  if (s === '') return null;
  if ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('{') && s.endsWith('}'))) {
    try {
      return JSON.parse(yamlFlowToJson(s));
    } catch (_) {
      /* fall through to string */
    }
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  return s;
}

// Best-effort conversion of YAML flow style (e.g. [a, b] / {k: v}) to JSON by
// quoting bare words. Good enough for the simple cases that appear in specs.
function yamlFlowToJson(s) {
  return s.replace(/([{[,]\s*)([A-Za-z_][\w-]*)(\s*[:,\]}])/g, '$1"$2"$3')
    .replace(/([{[,]\s*)([A-Za-z_][\w-]*)(\s*:)/g, '$1"$2"$3');
}

module.exports = {
  convertFile,
  loadSpec,
  collectOps,
  renderMarkdown,
  renderMcp,
  renderMcpSplit,
  isUrl,
  deriveName,
  slug,
};
