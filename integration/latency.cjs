// node integration/latency.cjs (after the normal build). No VS Code, profile,
// credential store, external network service or spend ledger is needed by this benchmark.
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { discover, probe } = require('../dist/src/metadata.js');
const { scheduleLevels } = require('../dist/src/schedule.js');
const { performance } = require('node:perf_hooks');

async function benchmark() {
  const latency = 100, levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none'];
  const ids = Array.from({ length: 16 }, (_, n) => `fixture${n}`);
  let active = 0, peak = 0, requests = 0, failure;
  const server = http.createServer(async (req, res) => {
    requests++;
    peak = Math.max(peak, ++active);
    res.once('close', () => { active--; });
    try {
      assert.equal(req.headers.authorization, 'Bearer loopback-only');
      let reply;
      if (req.method === 'GET') {
        const id = req.url.slice('/v1/models/'.length);
        assert(ids.includes(id) && req.url === `/v1/models/${id}`);
        reply = { id, object: 'model', supported_endpoints: ['/chat/completions'], capabilities: { supports: { reasoning_effort: ['low'] } } };
      } else {
        assert.equal(req.method, 'POST');
        assert.equal(req.url, '/v1/chat/completions');
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks));
        assert.equal(body.model, ids[0]);
        assert.deepEqual(body.messages, [{ role: 'user', content: 'Reply OK' }]);
        assert(levels.includes(body.reasoning_effort));
        reply = { id: 'fake', object: 'chat.completion', model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] };
      }
      await delay(latency);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    } catch (e) { failure = e; res.writeHead(400).end(); }
  });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const provider = { name: 'Fixture', npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'loopback-only' },
      models: Object.fromEntries(ids.map(id => [id, { name: id }])) };
    const results = {};
    for (const [method, width] of [['GET', 1], ['GET', 16], ['POST', 1], ['POST', 4], ['POST', 8]]) {
      assert.equal(active, 0, 'Overlapping benchmark cases');
      peak = requests = 0;
      const start = performance.now();
      const signal = AbortSignal.timeout(12_000);
      if (method === 'GET') {
        const result = await discover(provider, ids, signal, undefined, true, width);
        assert.equal(result.size, ids.length);
      } else {
        // The scheduler and HTTP client are real; no grant or reservation is needed on loopback.
        const result = await scheduleLevels(levels, width, signal, { current: async () => true, reserve: async () => 'reserved',
          send: level => probe(provider, ids[0], level, signal) });
        assert.deepEqual(result.accepted, levels);
      }
      if (failure) throw failure;
      assert.equal(requests, method === 'GET' ? ids.length : levels.length);
      assert.equal(peak, width);
      results[method + width] = { requests, peak, elapsedMs: Math.round(performance.now() - start) };
    }
    console.log('Observed loopback traffic; injected response latency', latency, 'ms:', results);
    assert(results.GET16.elapsedMs < results.GET1.elapsedMs);
    assert(results.POST8.elapsedMs < results.POST1.elapsedMs);
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}

benchmark().catch(e => { console.error(e); process.exitCode = 1; });
