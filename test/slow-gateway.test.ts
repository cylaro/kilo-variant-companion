import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import test from 'node:test'
import { probe } from '../src/metadata.js'
import { bodyTimeoutGuard, scheduleLevels, scheduleModels } from '../src/schedule.js'

test('a gateway that sends headers then stalls on successive models stops without losing the first result', async t => {
  const sent: string[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    sent.push(body.model)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (body.model !== 'good') { res.flushHeaders(); return }
    res.end(JSON.stringify({ model: 'good', id: 'chatcmpl-1', object: 'chat.completion',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const addr = server.address()
  assert(addr && typeof addr !== 'string')
  const ids = ['good', 'slow1', 'slow2', 'unreached']
  const provider = { npm: '@ai-sdk/openai-compatible', models: Object.fromEntries(ids.map(id => [id, {}])),
    options: { baseURL: `http://127.0.0.1:${addr.port}/v1`, apiKey: 'fixture', timeout: 250 } }
  const guard = bodyTimeoutGuard(), signal = new AbortController().signal, kept: string[] = [], scopes: string[] = []
  const result = await scheduleModels(ids, async id => guard.settle(await scheduleLevels(['high'], guard.width(4), signal, {
    current: async () => true, reserve: async () => 'reserved', send: level => probe(provider, id, level, signal),
  })), async (id, batch) => {
    kept.push(...batch.accepted.map(level => id + '/' + level))
    if (batch.unknown) scopes.push(`${batch.unknown.scope}/${batch.unknown.status}/${batch.unknown.reason}`)
    return true
  })
  assert.equal(result, 'provider-stop')
  assert.deepEqual(sent, ['good', 'slow1', 'slow2'])
  assert.deepEqual(kept, ['good/high'])
  assert.deepEqual(scopes, ['model/200/timeout', 'provider/200/timeout'])
})
