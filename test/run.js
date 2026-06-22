'use strict';

// Zero-framework smoke test: convert examples/swagger.json and assert on the
// generated Markdown + MCP output. Exits non-zero on the first failure.

const assert = require('assert');
const path = require('path');
const { convertFile } = require('../src/convert');

const SPEC = path.join(__dirname, '..', 'examples', 'swagger.json');

let passed = 0;
function check(label, condition) {
  assert.ok(condition, label);
  passed++;
}

(async () => {
  const res = await convertFile(SPEC, { baseUrl: 'https://api.example.com' });

  // Structure ---------------------------------------------------------------
  check('7 endpoints collected', res.ops.length === 7);
  check('3 tags collected', res.tags.length === 3);

  // Markdown ----------------------------------------------------------------
  const md = res.markdown;
  check('markdown has the title', md.includes('# Shop API'));
  check('markdown lists the login endpoint', /POST \/auth\/login/.test(md));
  check('markdown marks bearer auth', md.includes('🔒 Auth required: bearer'));
  check('markdown has a typed field row', /\| `email` \| string <email> \| Yes \|/.test(md));
  check('markdown has a generated request example', md.includes('user@example.com'));

  // MCP ---------------------------------------------------------------------
  const mcp = res.mcp;
  check('mcp honors --base-url', mcp.includes('BASE_URL: https://api.example.com'));
  check('mcp lists the login endpoint', /### POST \/auth\/login/.test(mcp));
  check('mcp marks auth=bearer', /auth=bearer/.test(mcp));
  check('mcp inlines a $ref enum\'s values', /OrderStatus enum\("pending", "paid", "shipped", "cancelled"\)/.test(mcp));
  check('mcp shows a required typed body field', /email: string <email>!/.test(mcp));

  // Split -------------------------------------------------------------------
  const split = await convertFile(SPEC, { split: true });
  check('split produces index.mcp.md', split.split.some((f) => f.name === 'index.mcp.md'));
  check('split produces one file per tag', res.tags.every((t) => split.split.some((f) => f.name === `${t}.mcp.md`)));

  console.log(`All ${passed} assertions passed.`);
})().catch((err) => {
  console.error('Test failed:', err.message);
  process.exit(1);
});
