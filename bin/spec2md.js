#!/usr/bin/env node
'use strict';

/**
 * spec2md CLI: argument parsing + routing (convert / update / init) + the
 * actual file writing. All conversion logic lives in src/convert.js so the
 * CLI is the single engine that agent adapters drive.
 */

const fs = require('fs');
const path = require('path');
const { convertFile, isUrl } = require('../src/convert');
const { install } = require('../src/init');
const PKG = require('../package.json');

async function main(argv) {
  const args = argv.slice(2);

  if (!args.length || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    return;
  }
  if (args[0] === '--version' || args[0] === '-v') {
    console.log(PKG.version);
    return;
  }

  if (args[0] === 'init') return cmdInit(args.slice(1));
  if (args[0] === 'update') return cmdUpdate(args.slice(1));
  return cmdConvert(args);
}

// ---------------------------------------------------------------------------
// convert
// ---------------------------------------------------------------------------

function parseConvertArgs(args) {
  const opts = {};
  let input = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--split': opts.split = true; break;
      case '--md-only': opts.mdOnly = true; break;
      case '--mcp-only': opts.mcpOnly = true; break;
      case '--out-md': opts.outMd = args[++i]; break;
      case '--out-mcp': opts.outMcp = args[++i]; break;
      case '--out': opts.out = args[++i]; break;
      case '--base-url': opts.baseUrl = args[++i]; break;
      case '--title': opts.title = args[++i]; break;
      default:
        if (a.startsWith('-')) throw new Error(`Unknown option: ${a}`);
        if (!input) input = a;
    }
  }
  return { input, opts };
}

async function cmdConvert(args) {
  const { input, opts } = parseConvertArgs(args);
  if (!input) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  const url = isUrl(input);
  if (!url && !fs.existsSync(input)) {
    throw new Error(`Spec file not found: ${input}`);
  }

  const result = await convertFile(input, { split: opts.split, baseUrl: opts.baseUrl, title: opts.title });
  const baseDir = url ? process.cwd() : path.dirname(path.resolve(input));
  const name = result.name;

  let manifestDir;
  const outputs = [];

  if (opts.split) {
    manifestDir = path.resolve(baseDir, opts.out || `${name}-context`);
    fs.mkdirSync(manifestDir, { recursive: true });
    for (const f of result.split) {
      fs.writeFileSync(path.join(manifestDir, f.name), f.content);
      outputs.push(f.name);
    }
  } else {
    manifestDir = baseDir;
    if (!opts.mcpOnly) {
      const p = path.resolve(baseDir, opts.outMd || `${name}.api.md`);
      fs.writeFileSync(p, result.markdown);
      outputs.push(path.relative(manifestDir, p));
    }
    if (!opts.mdOnly) {
      const p = path.resolve(baseDir, opts.outMcp || `${name}.mcp.md`);
      fs.writeFileSync(p, result.mcp);
      outputs.push(path.relative(manifestDir, p));
    }
  }

  writeManifest(manifestDir, {
    tool: `spec2md@${PKG.version}`,
    source: url ? input : path.resolve(input),
    version: result.version,
    options: {
      split: !!opts.split,
      baseUrl: opts.baseUrl || null,
      title: opts.title || null,
      mdOnly: !!opts.mdOnly,
      mcpOnly: !!opts.mcpOnly,
      outMd: opts.outMd || null,
      outMcp: opts.outMcp || null,
      out: opts.out || null,
    },
    outputs,
    generatedAt: new Date().toISOString(),
  });

  console.log(`spec2md: ${result.title} v${result.version || '?'} — ${result.ops.length} endpoints, ${result.tags.length} tags`);
  const dirLabel = path.relative(process.cwd(), manifestDir) || '.';
  for (const o of outputs) console.log(`  wrote ${path.join(dirLabel, o)}`);
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

async function cmdUpdate(args) {
  const target = path.resolve(args[0] || '.');
  const manifestPath = findManifest(target);
  if (!manifestPath) {
    throw new Error(`No .spec2md.json manifest found in ${target}. Run a convert there first.`);
  }

  const manifestDir = path.dirname(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const o = manifest.options || {};

  const result = await convertFile(manifest.source, {
    split: o.split,
    baseUrl: o.baseUrl || undefined,
    title: o.title || undefined,
  });

  const oldVersion = manifest.version;

  if (o.split) {
    const newOutputs = [];
    for (const f of result.split) {
      fs.writeFileSync(path.join(manifestDir, f.name), f.content);
      newOutputs.push(f.name);
    }
    manifest.outputs = newOutputs;
  } else {
    for (const out of manifest.outputs || []) {
      const p = path.resolve(manifestDir, out);
      if (/\.api\.md$/.test(out)) fs.writeFileSync(p, result.markdown);
      else if (/\.mcp\.md$/.test(out)) fs.writeFileSync(p, result.mcp);
    }
  }

  manifest.version = result.version;
  manifest.generatedAt = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  if (oldVersion === result.version) {
    console.log(`spec2md: ${result.title} unchanged (version ${result.version || '?'})`);
  } else {
    console.log(`spec2md: ${result.title} version ${oldVersion || '?'} → ${result.version || '?'}`);
  }
}

// Look for a manifest in the directory, then in any immediate *-context child.
function findManifest(target) {
  let dir = target;
  if (fs.existsSync(target) && fs.statSync(target).isFile()) dir = path.dirname(target);

  const direct = path.join(dir, '.spec2md.json');
  if (fs.existsSync(direct)) return direct;

  if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    for (const entry of fs.readdirSync(dir)) {
      const candidate = path.join(dir, entry, '.spec2md.json');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function writeManifest(dir, manifest) {
  fs.writeFileSync(path.join(dir, '.spec2md.json'), JSON.stringify(manifest, null, 2) + '\n');
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

function cmdInit(args) {
  const agents = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--agent') agents.push(args[++i]);
    else if (a.startsWith('--agent=')) agents.push(a.slice('--agent='.length));
    else if (!a.startsWith('-')) agents.push(a);
  }

  const results = install(agents.length ? agents : ['claude'], process.cwd());
  for (const r of results) {
    const where = path.relative(process.cwd(), r.file) || r.file;
    const note = r.reason ? ` (${r.reason})` : '';
    console.log(`spec2md: ${r.action} ${where}${note}`);
  }
}

// ---------------------------------------------------------------------------
// help
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`spec2md — turn an OpenAPI/Swagger spec into Markdown + MCP context.

Usage:
  spec2md <spec|url> [options]   Convert a local file or a live http(s) URL
  spec2md update [dir]           Re-fetch the saved source and regenerate
  spec2md init [--agent <name>]  Install agent adapters into the project
  spec2md --help

Convert options:
  --split              One MCP file per tag + index.mcp.md (in <name>-context/)
  --out-md <file>      Markdown output path (default <name>.api.md)
  --out-mcp <file>     MCP output path (default <name>.mcp.md)
  --out <dir>          Split output directory (default <name>-context/)
  --md-only            Write only the Markdown reference
  --mcp-only           Write only the MCP context
  --base-url <url>     Override the API base URL
  --title <text>       Override the document title

init agents:
  claude   .claude/skills/spec2md/SKILL.md
  codex    appends a section to AGENTS.md  (aliases: agents, antigravity)
  cursor   .cursor/rules/spec2md.mdc
  windsurf .windsurf/rules/spec2md.md
  all      claude + codex + cursor + windsurf

Examples:
  npx spec2md ./swagger.json
  npx spec2md https://api.example.com/api-json --split
  npx spec2md https://api.example.com/api-json --base-url https://api.example.com
  npx spec2md update ./my-api-context
  npx spec2md init --agent all`);
}

main(process.argv).catch((err) => {
  process.stderr.write(`spec2md: error: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
});
