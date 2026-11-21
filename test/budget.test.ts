import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'
import { Budget, budgetScope, type BudgetAttempt } from '../src/budget.js'

const id = 'fixture-provider', url = 'https://fixture.invalid/v1/chat/completions', key = 'not-a-real-credential'
const scope = budgetScope(id, url, key)
const attempt: BudgetAttempt = { model: 'fixture/remote', protocol: 'chat', level: 'high', context: 'fixture-context', maxOutputTokens: 16 }
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'kilo-spend-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const storage = path.join(root, 'extension-storage')
  const window = () => new Budget(storage)
  return { root, storage, ledger: path.join(storage, 'spend-v1'), window, a: window(), b: window() }
}

async function approved(b: Budget) {
  const observed = await b.inspect(scope)
  assert.equal(observed.allowed, false)
  const epoch = await b.allow(scope, observed.epoch)
  assert.ok(epoch)
  return epoch
}

test('explicit scope-bound approval, persistent unused credit, no raw identifiers on disk', async t => {
  const { a, b, ledger, storage } = await fixture(t)
  const prospective = (await a.inspect(scope)).epoch
  assert.equal(await b.reserve(scope, prospective, attempt), 'stale')
  const active = await a.allow(scope, prospective)
  assert.ok(active)
  for (const other of [budgetScope(id + '2', url, key), budgetScope(id, url + '/', key), budgetScope(id, url, key + '2')]) {
    assert.notEqual(other, scope)
    assert.equal((await b.inspect(other)).allowed, false)
    assert.equal(await b.allow(other, prospective), undefined)
    assert.equal(await b.reserve(other, active, attempt), 'stale')
  }
  assert.deepEqual(await b.inspect(scope), { epoch: active, allowed: true, remaining: 64 })
  assert.equal(await a.reserve(scope, active, attempt), 'reserved') // crash/no send/unknown: never refund
  assert.equal(await b.reserve(scope, active, { ...attempt, maxOutputTokens: 1 }), 'duplicate')
  for (const delta of [{ model: 'later-model' }, { protocol: 'responses' }, { level: 'low' }, { context: 'changed-context' }]) {
    assert.equal(await new Budget(storage).reserve(scope, active, { ...attempt, ...delta }), 'reserved')
  }
  assert.equal((await b.inspect(scope)).remaining, 59)
  for (const f of await fs.readdir(ledger, { withFileTypes: true })) {
    if (f.isDirectory()) { assert.deepEqual(await fs.readdir(path.join(ledger, f.name)), []); continue }
    assert.match(f.name, /^(seed|grant\.0|post\.0\.[0-4])$/)
    assert.match(await fs.readFile(path.join(ledger, f.name), 'utf8'), /^[a-f0-9]{64}:[a-f0-9]{64}$/)
  }
})

test('concurrent approvals and attempts share one grant, including the last slot', async t => {
  const { a, b, window } = await fixture(t)
  const views = await Promise.all([a.inspect(scope), b.inspect(scope)])
  assert.deepEqual(views[0], views[1])
  const [epoch, other] = await Promise.all([a.allow(scope, views[0].epoch), b.allow(scope, views[1].epoch)])
  assert.ok(epoch); assert.equal(epoch, other)
  const same = await Promise.all(Array.from({ length: 4 }, () => window().reserve(scope, epoch, attempt)))
  assert.deepEqual(same.sort(), ['duplicate', 'duplicate', 'duplicate', 'reserved'])
  // Simulate batches on later saves, not one in-memory budget per model or per batch.
  for (let i = 1; i < 63; i++) assert.equal(await a.reserve(scope, epoch, { ...attempt, model: 'later-' + i }), 'reserved')
  const last = await Promise.all(Array.from({ length: 4 }, (_, n) => window().reserve(scope, epoch, { ...attempt, model: 'last-' + n })))
  assert.deepEqual(last.sort(), ['exhausted', 'exhausted', 'exhausted', 'reserved'])
  assert.deepEqual(await b.inspect(scope), { epoch, allowed: true, remaining: 0 })
  assert.equal(await b.allow(scope, epoch), undefined)
  assert.equal(await b.allow(scope, views[0].epoch), epoch) // same consent cannot top up
  assert.equal(await b.allow(scope, views[0].epoch, true), undefined) // exhaustion is not a fresh approval
  assert.equal(await b.reserve(scope, epoch, { ...attempt, model: 'restart' }), 'exhausted')
  assert.equal(await b.reserve(scope, epoch, attempt), 'duplicate')
})

test('create-only approval returns the epoch to exactly one writer and cannot replace a spent balance', async t => {
  const { a, b, window } = await fixture(t)
  const consent = (await a.inspect(scope)).epoch
  const winners = (await Promise.all([a.allow(scope, consent, true), b.allow(scope, consent, true)])).filter(epoch => epoch !== undefined)
  assert.equal(winners.length, 1)
  const [epoch] = winners
  assert.deepEqual(await b.inspect(scope), { epoch, allowed: true, remaining: 64 })
  assert.equal(await a.reserve(scope, epoch, attempt), 'reserved')
  const reopened = window()
  assert.equal(await reopened.allow(scope, consent, true), undefined)
  assert.equal(await reopened.allow(scope, consent), epoch)
  assert.equal(await reopened.reserve(scope, epoch, attempt), 'duplicate')
  assert.deepEqual(await reopened.inspect(scope), { epoch, allowed: true, remaining: 63 })
})

test('token bound and malformed attempts cost nothing; bad inputs never grant', async t => {
  const { a } = await fixture(t)
  const epoch = await approved(a)
  for (const n of [0, -1, 17, 1.5, NaN, Infinity]) assert.equal(await a.reserve(scope, epoch, { ...attempt, maxOutputTokens: n }), 'invalid')
  for (const field of ['model', 'protocol', 'level', 'context']) assert.equal(await a.reserve(scope, epoch, { ...attempt, [field]: '' }), 'invalid')
  assert.equal(await a.reserve('not a scope', epoch, attempt), 'invalid')
  assert.equal(await a.reserve(scope, 'x', attempt), 'invalid')
  assert.deepEqual(await a.inspect(scope), { epoch, allowed: true, remaining: 64 })
  assert.throws(() => budgetScope(id, url, ''))
})

test('revoke fences open prompts and committed but not yet returned reservations', async t => {
  const { a, b, window } = await fixture(t)
  const unrelated = budgetScope(id, url, key + '-new')
  const prompt = await a.inspect(unrelated)
  const epoch = await approved(b)
  assert.equal(await b.reserve(scope, epoch, attempt), 'reserved') // already dispatched; not undoable
  // Revoke at the commit boundary, using a second instance, with no timing assumptions.
  const writer = a as unknown as { publish(name: string, value: string): Promise<boolean> }
  const publish = writer.publish.bind(a)
  t.mock.method(writer, 'publish', async (name: string, value: string) => {
    const ok = await publish(name, value)
    if (name.startsWith('post.')) await b.revokeAll()
    return ok
  })
  assert.equal(await a.reserve(scope, epoch, { ...attempt, level: 'low' }), 'stale')
  assert.equal(await b.allow(unrelated, prompt.epoch), undefined)
  assert.equal(await b.reserve(scope, epoch, attempt), 'stale')
  const fresh = window()
  const renewed = await approved(fresh)
  assert.notEqual(renewed, epoch)
  assert.equal(await fresh.reserve(scope, renewed, attempt), 'reserved')
})

test('partial scratch writes grant nothing; bounded writer contention fails closed', async t => {
  const { a, b, ledger } = await fixture(t)
  const epoch = await approved(a)
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(ledger, 'writer.' + i), 'partial', { flag: 'wx' })
  assert.equal(await b.reserve(scope, epoch, attempt), 'busy')
  assert.equal((await b.inspect(scope)).remaining, 64)
  await b.revokeAll() // does not need a free scratch file in an initialized store
  assert.equal(await a.reserve(scope, epoch, attempt), 'stale')
  assert.equal(await fs.readFile(path.join(ledger, 'writer.0'), 'utf8'), 'partial')
})

for (const onlyNew of [false, true]) test(`a delayed ${onlyNew ? 'create-only' : 'shared'} consent write cannot recreate a revoked grant`, async t => {
  const { a, b } = await fixture(t)
  const { epoch } = await a.inspect(scope)
  const writer = a as unknown as { publish(name: string, value: string): Promise<boolean> }
  const publish = writer.publish.bind(a)
  t.mock.method(writer, 'publish', async (name: string, value: string) => {
    await b.revokeAll()
    return publish(name, value)
  })
  assert.equal(await a.allow(scope, epoch, onlyNew), undefined)
  assert.equal((await b.inspect(scope)).allowed, false)
  assert.equal(await b.allow(scope, epoch, onlyNew), undefined)
})

test('the final revocation still works and permanently closes the bounded ledger', async t => {
  const { a, b } = await fixture(t)
  for (let i = 0; i < 63; i++) await a.revokeAll()
  const epoch = await approved(a)
  await b.revokeAll()
  assert.equal(await a.reserve(scope, epoch, attempt), 'stale')
  await assert.rejects(a.inspect(scope))
  await b.revokeAll()
})

test('damaged, misplaced or gapped slots never license another send', async t => {
  const { a, b, ledger } = await fixture(t)
  const epoch = await approved(a)
  const post = path.join(ledger, 'post.0.0')
  assert.equal(await a.reserve(scope, epoch, attempt), 'reserved')
  await fs.rename(post, path.join(ledger, 'post.0.1'))
  await assert.rejects(b.reserve(scope, epoch, attempt))
  await fs.copyFile(path.join(ledger, 'grant.0'), post)
  await assert.rejects(b.reserve(scope, epoch, attempt))
  await fs.writeFile(path.join(ledger, 'grant.0'), '')
  await assert.rejects(b.inspect(scope))
  await assert.rejects(b.reserve(scope, epoch, attempt))
})

test('refuses relative paths and linked stores before writing outside storage', async t => {
  const { a, root, storage } = await fixture(t)
  assert.throws(() => new Budget('workspace'))
  const outside = path.join(root, 'do-not-write')
  await fs.mkdir(outside)
  await fs.symlink(outside, storage, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(a.inspect(scope))
  assert.deepEqual(await fs.readdir(outside), [])
})
