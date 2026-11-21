import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { authFile, storedKey } from '../src/credential.js'

const id = 'custom-fixture_1'
const slot = (key: string) => JSON.stringify({ [id]: { type: 'api', key } })

async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'kilo-auth-test-'))
  const data = path.join(root, 'data')
  const dir = path.join(data, 'kilo')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  // No inherited auth overrides/keys; never load or copy their values, even to restore them.
  const originalEnv = process.env
  process.env = { HOME: root, USERPROFILE: root, XDG_DATA_HOME: data }
  t.after(async () => { process.env = originalEnv; await fs.rm(root, { recursive: true, force: true }) })
  const file = path.join(dir, 'auth.json')
  assert.equal(authFile(), file)
  return { root, data, dir, file, write: (s: string | Buffer) => fs.writeFile(file, s, { mode: 0o600 }) }
}

test('reads only the exact slot, reflecting creation, rotation and removal without caching', async t => {
  const f = await fixture(t)
  await fs.writeFile(path.join(f.dir, 'account.json'), slot('not-from-accounts'))
  process.env.CUSTOM_FIXTURE_1_API_KEY = 'not-from-env'
  assert.equal(await storedKey(id), undefined)
  await f.write(JSON.stringify({ other: { type: 'api', key: 'not-ours' }, [id]: { key: 'fixture-first', type: 'api' } }))
  assert.equal(await storedKey('missing'), undefined)
  assert.equal(await storedKey(id), 'fixture-first')
  await f.write(slot('fixture-second'))
  assert.equal(await storedKey(id), 'fixture-second')
  await fs.unlink(f.file)
  assert.equal(await storedKey(id), undefined)
})

test('declines process-local auth and DB overrides without using or falling back from them', async t => {
  const f = await fixture(t)
  await f.write(slot('disk-fixture'))
  for (const [variable, value] of [['KILO_AUTH_CONTENT', ''], ['KILO_AUTH_CONTENT', '{'],
    ['KILO_AUTH_CONTENT', slot('injected-fixture')], ['KILO_DB', ':memory:']]) {
    process.env[variable] = value
    assert.equal(authFile(), undefined)
    assert.equal(await storedKey(id), undefined)
    delete process.env[variable]
  }
  // This default-path assertion is purely lexical. Never call storedKey on the default home.
  delete process.env.XDG_DATA_HOME
  assert.equal(authFile(), path.join(os.homedir(), '.local', 'share', 'kilo', 'auth.json'))
  for (const root of ['', 'relative', f.data + '\n', f.dir + path.sep + '..']) {
    process.env.XDG_DATA_HOME = root
    assert.equal(authFile(), undefined)
  }
})

test('rejects OAuth, metadata, malformed or ambiguous records and non-literal keys', async t => {
  const f = await fixture(t)
  const api = '{"type":"api","key":"fixture"}'
  for (const raw of [
    null, [], { type: 'oauth', access: 'fixture', key: 'fixture' }, { type: 'wellknown', key: 'fixture', token: 'fixture' },
    { type: 'api', key: 'fixture', metadata: {} }, { type: 'api', key: 'fixture', extra: true }, { type: 'api' },
    ...[null, 7, {}, '', 'a\r\nb', ' x', '{env:TEST_KEY}', '********', 'kilo-oauth-dummy-key', 'x'.repeat(4097)]
      .map(key => ({ type: 'api', key })),
  ]) {
    await f.write(JSON.stringify({ [id]: raw }))
    assert.equal(await storedKey(id), undefined)
  }
  for (const text of [
    `{ "${id}":${api}, "custom-fixture_\\u0031":${api} }`, `{ "${id}":${api}, "${id}//":${api} }`,
    `{ "${id}":{"type":"oauth","type":"api","key":"fixture"} }`,
    `{ "${id}":{"type":"api","k\\u0065y":"first","key":"second"} }`,
    `{"other":{"nested":1,"nested":2},"${id}":${api}}`,
    `{ "${id}":${api}, }`, `/* comment */${slot('fixture')}`, slot('fixture') + 'garbage',
    JSON.stringify([{ [id]: { type: 'api', key: 'fixture' } }]),
  ]) {
    await f.write(text)
    assert.equal(await storedKey(id), undefined)
  }
  for (const name of ['kilo', 'constructor', '__proto__', 'prototype', id + '/', 'bad/id', id.toUpperCase()]) {
    await f.write(JSON.stringify({ [name]: { type: 'api', key: 'fixture' } }))
    assert.equal(await storedKey(name), undefined)
  }
})

test('rejects invalid bytes, oversized files, hardlinks and linked directories', async t => {
  const f = await fixture(t)
  await f.write(Buffer.concat([Buffer.from(slot('fixture')), Buffer.from([0xff])]))
  assert.equal(await storedKey(id), undefined)
  await f.write(slot('fixture') + ' '.repeat(2 * 1024 * 1024))
  assert.equal(await storedKey(id), undefined)
  await f.write(slot('fixture'))
  const hard = path.join(f.root, 'alias')
  await fs.link(f.file, hard)
  assert.equal(await storedKey(id), undefined)
  await fs.unlink(hard)
  const linked = path.join(f.root, 'linked')
  await fs.symlink(f.data, linked, process.platform === 'win32' ? 'junction' : 'dir')
  process.env.XDG_DATA_HOME = linked
  assert.equal(await storedKey(id), undefined)
  if (process.platform !== 'win32') {
    process.env.XDG_DATA_HOME = f.data
    await fs.rename(f.file, hard)
    await fs.symlink(hard, f.file)
    assert.equal(await storedKey(id), undefined)
  }
})
