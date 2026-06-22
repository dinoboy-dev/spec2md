'use strict';

/**
 * `spec2md init` installs small adapter files that teach an AI coding agent to
 * call the spec2md CLI. The CLI stays the single engine; adapters are just
 * instructions pointing at it.
 */

const fs = require('fs');
const path = require('path');

const ALL = ['claude', 'codex', 'cursor', 'windsurf'];

// Shared usage block embedded in every adapter so each is self-contained.
const USAGE = `spec2md converts an OpenAPI/Swagger spec (a local file **or** a live http(s) URL) into:
- \`<name>.api.md\` — a human-readable Markdown API reference.
- \`<name>.mcp.md\` — a compact, token-efficient contract optimized for an AI agent.

Run it with npx (no install needed):

- \`npx spec2md <spec|url>\` — convert a local file or an http(s) URL.
- \`npx spec2md <spec|url> --split\` — one MCP file per tag plus \`index.mcp.md\` in \`<name>-context/\`.
- \`npx spec2md <spec|url> --base-url <url>\` — override the API base URL.
- \`npx spec2md update [dir]\` — re-fetch the saved source and regenerate the same outputs.

When integrating an API:
1. Run spec2md against the backend's spec file or Swagger URL.
2. Read the generated \`<name>.mcp.md\` (or the \`<name>-context/\` folder) as the contract.
3. Generate client code that matches each endpoint's method, path, params, auth and JSON shapes.
4. Re-run \`spec2md update\` whenever the backend changes.

Tip: a NestJS backend usually exposes its spec as JSON. Export it with
\`curl http://localhost:3000/api-json > swagger.json\`, or point spec2md straight at that URL.`;

function claudeSkill() {
  return `---
name: spec2md
description: Convert an OpenAPI/Swagger spec (local file or live URL) into Markdown API docs and a compact MCP context file, then use that contract to write correct API-integration code.
---

# spec2md

${USAGE}
`;
}

function cursorRule() {
  return `---
description: Use the spec2md CLI to turn an OpenAPI/Swagger spec into a Markdown + MCP contract before writing API-integration code.
globs:
alwaysApply: false
---

# spec2md

${USAGE}
`;
}

function windsurfRule() {
  return `---
trigger: model_decision
description: Use the spec2md CLI to turn an OpenAPI/Swagger spec into a Markdown + MCP contract before writing API-integration code.
---

# spec2md

${USAGE}
`;
}

const AGENTS_MARKER = '## spec2md';

function agentsSection() {
  return `${AGENTS_MARKER}

${USAGE}
`;
}

// Aliases collapse onto the four real targets; "all" expands to every target.
function normalizeAgents(list) {
  const out = [];
  const add = (v) => {
    if (!out.includes(v)) out.push(v);
  };
  for (let agent of list) {
    agent = String(agent || '').toLowerCase();
    if (!agent) continue;
    if (agent === 'all') {
      ALL.forEach(add);
      continue;
    }
    if (agent === 'antigravity' || agent === 'agents') agent = 'codex';
    add(agent);
  }
  return out.length ? out : ['claude'];
}

function install(agents, cwd) {
  const root = cwd || process.cwd();
  const results = [];
  for (const agent of normalizeAgents(agents)) {
    switch (agent) {
      case 'claude':
        results.push(writeFile(path.join(root, '.claude', 'skills', 'spec2md', 'SKILL.md'), claudeSkill()));
        break;
      case 'codex':
        results.push(appendAgentsFile(path.join(root, 'AGENTS.md')));
        break;
      case 'cursor':
        results.push(writeFile(path.join(root, '.cursor', 'rules', 'spec2md.mdc'), cursorRule()));
        break;
      case 'windsurf':
        results.push(writeFile(path.join(root, '.windsurf', 'rules', 'spec2md.md'), windsurfRule()));
        break;
      default:
        results.push({ action: 'skipped', reason: `unknown agent "${agent}"`, file: agent });
    }
  }
  return results;
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = fs.existsSync(file);
  fs.writeFileSync(file, content);
  return { action: existed ? 'updated' : 'created', file };
}

// AGENTS.md is shared, so append idempotently: skip if our marker is present.
function appendAgentsFile(file) {
  let existing = '';
  if (fs.existsSync(file)) existing = fs.readFileSync(file, 'utf8');
  if (existing.includes(AGENTS_MARKER)) {
    return { action: 'skipped', reason: 'already present', file };
  }
  const section = agentsSection();
  const next = existing.trim()
    ? `${existing.replace(/\s*$/, '')}\n\n${section}`
    : `# AGENTS\n\n${section}`;
  fs.writeFileSync(file, next);
  return { action: existing ? 'updated' : 'created', file };
}

module.exports = { install, normalizeAgents, AGENTS: ALL };
