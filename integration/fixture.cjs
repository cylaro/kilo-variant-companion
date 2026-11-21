const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

// Two distinct synthetic saved keys; neither goes in profile settings or process.env.
exports.key = (root, unselected = false) => 'fixture-only-' + createHash('sha256').update(unselected ? root + ':unselected' : root).digest('hex');

exports.config = port => ({
  enabled_providers: ['fixture', 'unselected'], model: 'fixture/sample-reasoner', small_model: 'fixture/no-efforts', share: 'disabled',
  provider: {
    fixture: { name: 'Selected provider', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: {
      'sample-reasoner': { name: 'Sample Reasoner', reasoning: true, variants: { xhigh: { disabled: true } } }, 'no-efforts': { name: 'No efforts' },
    } },
    unselected: { name: 'Unselected provider', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${port}/never/v1` }, models: {
      'sample-reasoner': { name: 'Other Reasoner', reasoning: true, variants: { medium: { disabled: true } } },
    } },
  },
});

exports.handle = async (root, req, res, requests) => {
  const at = Date.now();
  assert.equal(req.socket.remoteAddress, '127.0.0.1');
  assert.equal(req.headers.host, `127.0.0.1:${req.socket.localPort}`);
  assert.equal(req.method, 'GET', 'Metadata checks must not run inference');
  const id = ['sample-reasoner', 'no-efforts'].find(id => req.url === '/v1/models/' + id);
  assert(id, 'Request outside the selected provider and model set');
  assert(req.headers.authorization === 'Bearer ' + exports.key(root), 'Wrong synthetic credential');
  assert.equal(await fs.readFile(path.join(root, 'phase'), 'utf8'), 'checking', 'Request outside the selected check');
  requests.push({ at, id });
  const row = { id, object: 'model', supported_endpoints: ['/chat/completions'] };
  if (id === 'sample-reasoner') row.capabilities = { supports: { reasoning_effort: ['xhigh', 'ultra'] } };
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(row));
};

exports.audit = async root => {
  const secrets = [exports.key(root), exports.key(root, true)];
  const slot = path.join(root, 'data/kilo/auth.json');
  const count = { config: 0, logs: 0, state: 0 };
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (file === slot || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      const parts = path.relative(root, file).split(path.sep);
      const kind = parts.some(s => /^(?:logs?|output_logging.*)$/i.test(s)) || /\.log$/i.test(entry.name) ? 'logs'
        : /\.(jsonc?|ya?ml|toml)$/i.test(entry.name) ? 'config' : parts.includes('globalStorage') ? 'state' : undefined;
      if (!kind) continue;
      const bytes = await fs.readFile(file);
      for (const secret of secrets) assert(!bytes.includes(secret) && !bytes.includes(Buffer.from(secret, 'utf16le')), `Fixture key in ${parts.join('/')}`);
      count[kind]++;
    }
  }
  for (const dir of ['home', 'profile', 'data', 'state', 'workspace', 'cache', 'roaming', 'local', 'tmp']) await walk(path.join(root, dir));
  assert(count.config && count.logs, 'Expected config and log files in disposable profile');
  return count;
};
