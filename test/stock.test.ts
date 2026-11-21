import assert from 'node:assert/strict'
import { channel } from 'node:diagnostics_channel'
import type { ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { analyzeConfig, type Candidate } from '../src/config.js'
import { parseStockOutput, readStock } from '../src/stock.js'

// Opt in with an unpacked official extension. Never search an editor profile or PATH.
const official = process.env.KVC_TEST_KILO_EXTENSION ?? ''
const skipNative = !official && 'Set KVC_TEST_KILO_EXTENSION to the official Windows x64 extension directory'
const npm = '@ai-sdk/openai-compatible'
const efforts = (...names: string[]) => Object.fromEntries(names.map(name => [name, { reasoningEffort: name }]))

function batch(models: Record<string, Record<string, unknown>>, providerID = 'fixture'): Candidate[] {
  const provider = { npm, options: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'fixture-only' }, models }
  return Object.entries(models).map(([modelID, model]) => ({ modelID, providerID, provider, model, context: '' }))
}

const signal = () => new AbortController().signal

test('official compatible SDK resolves stock low/medium/high for synthetic models in one offline child', { skip: skipNative }, async t => {
  let hits = 0
  const trap = createServer((_req, res) => { hits++; res.writeHead(500).end() })
  trap.listen(0, '127.0.0.1'); await once(trap, 'listening')
  t.after(() => trap.close())
  const addr = trap.address(); assert(addr && typeof addr === 'object')
  const baseURL = `http://127.0.0.1:${addr.port}/secret-route`
  assert(!Object.hasOwn(process.env, 'KILO_CONFIG_CONTENT'), 'Run this optional test without a KILO_CONFIG_CONTENT override')
  process.env.KILO_CONFIG_CONTENT = JSON.stringify({ disabled_providers: ['variant-companion-offline'] })
  t.after(() => { delete process.env.KILO_CONFIG_CONTENT })
  let count = 0
  const children = channel('child_process'), observe = () => { count++ }
  children.subscribe(observe); t.after(() => children.unsubscribe(observe))
  const [fixture] = batch({
    'sample-alias': { id: 'sample-remote', reasoning: true, variants: { override: { temperature: 99 } } },
    'sample-reasoner': { name: 'Sample Reasoner', reasoning: true, temperature: false, tool_call: true, attachment: true,
      variants: { manual: { reasoningEffort: 'xhigh' }, medium: { disabled: true } },
      limit: { context: 16000, output: 1024 }, modalities: { input: ['text', 'image'], output: ['text'] } },
  })
  fixture.provider.options = { baseURL } // Saved-key configuration: the stock resolver does not need an API key.
  const config = JSON.stringify({ enabled_providers: ['fixture'], model: 'fixture/sample-reasoner', provider: { fixture: fixture.provider } })
  const models = analyzeConfig(config, analyzeConfig('{}')!.snapshot)!.candidates
  const stock = await readStock(official, models, signal())
  assert.deepEqual(stock, new Map<string, Record<string, unknown>>([
    ['["fixture","sample-alias"]', efforts('low', 'medium', 'high')],
    ['["fixture","sample-reasoner"]', efforts('low', 'medium', 'high')],
  ]))
  assert.equal(count, 1)
  assert.equal(hits, 0)
})

test('explicit empty CLI result is known; ambiguous frames or injectable option objects supply no result', () => {
  const id = 'alias', p = 'variant-companion-offline', models = new Map([[id, { id: 'remote' }]])
  const api = { id: 'remote', url: 'http://127.0.0.1:1', npm }
  const row = { id, providerID: p, api, capabilities: { reasoning: true }, variants: {} }
  const frame = (data: unknown, header = `${p}/${id}`) => `${header}\r\n${JSON.stringify(data, null, 2)}\r\n`
  assert.deepEqual(parseStockOutput(frame(row), models), new Map([[id, {}]]))
  for (const text of [frame(row, `original/${id}`), frame({ ...row, id: 'remote' }), frame({ ...row, providerID: 'other' }),
    frame({ ...row, api: { ...api, id: 'other' } }), frame({ ...row, api: { ...api, npm: '@ai-sdk/openai' } }),
    frame({ ...row, variants: undefined }), frame({ ...row, variants: { high: { reasoningEffort: 'low' } } }),
    frame({ ...row, variants: { high: { reasoningEffort: 'high', headers: { x: 'bad' } } } }),
    frame({ ...row, variants: JSON.parse('{"__proto__":{"reasoningEffort":"high"}}') }),
    frame(row) + frame(row), frame(row).replace('"variants": {}', '"variants": null,\n  "variants": {}'), frame(row).slice(0, -4)]) {
    assert.equal(parseStockOutput(text, models), undefined)
  }
})

test('catalog, inherited transport, aliases, unsupported sources and ambiguous provider batches never start a child', async t => {
  const children = channel('child_process'); let count = 0
  const observe = () => { count++ }; children.subscribe(observe); t.after(() => children.unsubscribe(observe))
  const invalid = (m: Record<string, unknown>, p: Record<string, unknown> = {}) => {
    const cs = batch({ test: { reasoning: true, ...m } }, `fixture-${cases.length}`)
    Object.assign(cs[0].provider, p); return cs
  }
  const cases: Candidate[] = []
  for (const p of [{ npm: undefined }, { npm: '@ai-sdk/openai' }, { npm: '@ai-sdk/anthropic' }, { npm: 'injected-provider' }, { options: { baseURL: '{env:URL}' } },
    { options: { baseURL: 'https://example.invalid/', headers: { Authorization: 'forbidden' } } }, { env: ['{file:payload}'] },
    { whitelist: ['test', '{env:MODEL}'] }, { plugin: ['file://bad'] }]) cases.push(...invalid({}, p))
  for (const m of [{ reasoning: null }, { reasoning: false }, { reasoning: undefined }, { id: '../remote' }, { id: '{env:TARGET}' },
    { family: '{file:payload}' }, { options: { custom: true } }, { reasoning: 'true' }, { tool_call: 1 }, { cost: { input: 1 } },
    { modalities: { input: ['{env:MODALITY}'] } }, { provider: { npm: 'file:evil' } }, { variants: { opaque: 5 } }]) cases.push(...invalid(m))
  for (const p of ['openai', 'abacus', 'zro', 'apertis', 'anaconda-desktop', 'opencode-arbitrary', '--refresh', 'constructor'])
    cases.push(...batch({ test: { reasoning: true } }, p))
  cases.push(...batch({ a: { reasoning: true, id: 'other' }, other: { reasoning: false } }, 'alias-collision'))
  cases.push(...batch({ x: { reasoning: true } }, 'ambiguous'), ...batch({ y: { reasoning: true } }, 'ambiguous'))
  assert.equal((await readStock(official, cases, signal())).size, 0)
  assert.equal((await readStock(official, [], signal())).size, 0)
  assert.equal((await readStock(official, batch({ a: { reasoning: true } }), AbortSignal.abort())).size, 0)
  const inherited = Object.hasOwn(process.env, 'KILO_MODELS_PATH')
  try {
    if (!inherited) process.env.KILO_MODELS_PATH = 'do-not-open'
    assert.equal((await readStock(official, batch({ a: { reasoning: true } }), signal())).size, 0)
  } finally { if (!inherited) delete process.env.KILO_MODELS_PATH }
  assert.equal(count, 0)
})

test('never substitutes an executable from PATH, a spoofed install, link, or UNC/device path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'kvc-source-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const folder = 'kilocode.kilo-code-7.8.32-win32-x64'
  const fake = join(root, folder); await mkdir(join(fake, 'bin'), { recursive: true })
  await writeFile(join(fake, 'bin', 'kilo.exe'), 'not the pinned official binary')
  const paths = [fake, 'kilo.exe', `\\\\host.invalid\\ext\\${folder}`, `\\\\?\\${fake}`, `${fake}\\..\\${folder}`]
  if (official) {
    const via = join(root, 'via'); await mkdir(via)
    const link = join(via, folder); await symlink(official, link, 'junction'); paths.push(link)
  }
  const children = channel('child_process'); let count = 0
  const observe = () => { count++ }; children.subscribe(observe); t.after(() => children.unsubscribe(observe))
  for (const p of paths) assert.equal((await readStock(p, batch({ ok: { reasoning: true } }), signal())).size, 0)
  assert.equal(count, 0)
})

test('aborting an active official CLI kills it, waits for exit, and removes the disposable environment', { skip: skipNative }, async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'kvc-cancel-test-'))
  const old = process.env.TEMP; process.env.TEMP = tmp
  t.after(async () => { if (old === undefined) delete process.env.TEMP; else process.env.TEMP = old; await rm(tmp, { recursive: true, force: true }) })
  const controller = new AbortController()
  let child: ChildProcess | undefined
  const children = channel('child_process'), abort = (message: unknown) => {
    child = (message as { process: ChildProcess }).process
    child.once('spawn', () => controller.abort())
  }
  children.subscribe(abort); t.after(() => children.unsubscribe(abort))
  assert.equal((await readStock(official, batch({ ok: { reasoning: true } }), controller.signal)).size, 0)
  assert(child?.killed)
  assert.deepEqual(await readdir(tmp), [])
})
