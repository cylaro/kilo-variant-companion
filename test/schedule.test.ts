import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { scheduleLevels, scheduleModels, bodyTimeoutGuard, scopedGrant } from '../src/schedule.js'
import type { probe } from '../src/metadata.js'
import { Budget, budgetScope } from '../src/budget.js'

type Reply = Awaited<ReturnType<typeof probe>>

function gate<T>() {
  let open!: (v: T) => void
  const wait = new Promise<T>(resolve => { open = resolve })
  return { open, wait }
}

test('runs only the licensed number of probes and reserves each before sending', async () => {
  for (const width of [1, 4, 8] as const) {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none', 'ninth']
    const started = levels.map(() => gate<void>()), finish = levels.map(() => gate<void>())
    const reserved: string[] = [], sent: string[] = []
    let active = 0, peak = 0
    const task = scheduleLevels(levels, width, new AbortController().signal, {
      current: async () => true,
      reserve: async name => { reserved.push(name); return 'reserved' },
      send: async name => {
        assert.ok(reserved.includes(name))
        const i = levels.indexOf(name)
        peak = Math.max(peak, ++active)
        sent.push(name); started[i].open(); await finish[i].wait; active--
        return { result: 'accepted' }
      },
    })
    await started[width - 1].wait
    await tick() // Keep the entire first wave blocked; admission must not even reserve the next slot.
    assert.deepEqual(sent, levels.slice(0, width))
    assert.deepEqual(reserved, sent)
    finish[0].open()
    await started[width].wait
    assert.equal(active, width)
    finish.forEach(g => g.open())
    const batch = await task
    assert.equal(peak, width); assert.equal(active, 0)
    assert.deepEqual(batch.accepted, levels); assert.deepEqual(batch.advertised, [])
  }
})

function markers() {
  const data = new Map<string, unknown>()
  return { get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value) } }
}

test('only the creator of the durable grant records eight; a racing legacy approval cannot be promoted', async t => {
  const dir = await mkdtemp(join(await realpath(tmpdir()), 'kilo-scheduler-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const a = new Budget(dir), b = new Budget(dir), state = markers()
  const scope = budgetScope('fixture', 'http://127.0.0.1/v1/chat/completions', 'dummy')
  const grant = scopedGrant(state, scope), before = await a.inspect(scope)
  await grant.decline()
  assert.equal(grant.admission(before, false), 'skip')
  assert.equal(grant.admission(before, true), 'confirm')
  // Simulate an older window winning the exact gap between inspection and grant creation.
  assert.equal(await grant.confirm(a, before, async () => !!await b.allow(scope, before.epoch)), undefined)
  const legacy = await b.inspect(scope)
  assert.ok(legacy.allowed); assert.equal(legacy.remaining, 64)
  assert.equal(grant.width(legacy.epoch), 1); assert.equal(grant.metadataOnly(legacy.epoch), true)
  const attempt = { model: 'fixture', level: 'low', protocol: 'chat', context: 'fixture', maxOutputTokens: 16 }
  assert.equal(await b.reserve(scope, legacy.epoch, attempt), 'reserved')
  for (const width of [1, 4] as const) {
    if (width === 4) await state.update('auto.parallel4.' + scope, legacy.epoch)
    await grant.decline()
    assert.equal(await grant.confirm(a, await a.inspect(scope), async () => true), legacy.epoch)
    assert.equal(grant.width(legacy.epoch), width)
    const batch = await scheduleLevels(['low'], width, new AbortController().signal, {
      current: async () => true, reserve: () => a.reserve(scope, legacy.epoch, attempt),
      send: async () => assert.fail('resume must not replay a previously paid check'),
    })
    assert.equal(batch.unknown, undefined); assert.deepEqual(batch.accepted, []); assert.equal((await b.inspect(scope)).remaining, 63)
  }

  await a.revokeAll()
  const fresh = await a.inspect(scope), epoch = await grant.confirm(a, fresh, async () => true)
  assert.ok(epoch); assert.deepEqual(await b.inspect(scope), { epoch, allowed: true, remaining: 64 })
  assert.equal(grant.width(epoch), 8); assert.equal(grant.metadataOnly(epoch), false)
  assert.equal(grant.width(legacy.epoch), 4); assert.equal(grant.metadataOnly(legacy.epoch), true)
  assert.equal(scopedGrant(state, 'other/key').width(epoch), 1)
})

test('explicit resume of a denied serial or four-wide grant does not create credit, increase width or spend a slot', async () => {
  for (const width of [1, 4] as const) {
    const state = markers(), grant = scopedGrant(state, 'scope'), other = scopedGrant(state, 'different-key')
    await state.update('auto.parallel8.scope', 'expired')
    if (width === 4) await state.update('auto.parallel4.scope', 'old')
    await grant.decline(); await other.decline()
    let balance = { epoch: 'old', allowed: true, remaining: 17 }
    const before = { ...balance }, ledger = { inspect: async () => balance, allow: async (): Promise<never> => assert.fail('cannot replace a grant') }
    assert.equal(grant.admission(before, false), 'skip'); assert.equal(grant.admission(before, true), 'confirm')
    assert.equal(await grant.confirm(ledger, before, async () => false), undefined)
    balance = { ...before, remaining: 0 }
    assert.equal(grant.admission(balance, true), 'exhausted')
    assert.equal(await grant.confirm(ledger, before, async () => true), undefined)
    balance = { ...before, epoch: 'revoked' }
    assert.equal(await grant.confirm(ledger, before, async () => true), undefined)
    assert.equal(grant.metadataOnly('old'), true)

    balance = before
    assert.equal(await grant.confirm(ledger, before, async () => true), 'old')
    assert.deepEqual(balance, { epoch: 'old', allowed: true, remaining: 17 }); assert.equal(grant.width('old'), width)
    assert.equal(grant.metadataOnly('old'), false); assert.equal(other.metadataOnly('old'), true)
    assert.equal(grant.admission(balance, false), 'use')
    assert.equal(grant.metadataOnly('next-epoch'), true)
    await grant.decline(); assert.equal(grant.metadataOnly('old'), true)
  }
})

test('a terminal response observed during reservation prevents that POST and drains the others', async () => {
  for (const terminal of [
    { result: 'unknown', status: 429 },
    { result: 'unknown', unknownScope: 'model', status: 200, reason: 'model_mismatch' },
    { result: 'rejected', modelUnsupported: true },
    { result: 'rejected', allowedLevels: ['high', 'untried'] },
  ] satisfies Reply[]) {
    const wire = gate<Reply>(), last = gate<Reply>(), reserving = gate<void>(), reserved = gate<void>()
    const sent: string[] = [], claims: string[] = []
    let drained = false
    const task = scheduleLevels(['low', 'high', 'max', 'ultra'], 4, new AbortController().signal, {
      current: async () => true,
      reserve: async level => {
        claims.push(level)
        if (level === 'max') { reserving.open(); await reserved.wait }
        return 'reserved'
      },
      send: async level => { sent.push(level); return level === 'low' ? wire.wait : last.wait },
    }).then(result => { drained = true; return result })
    await reserving.wait
    wire.open(terminal)
    await tick() // terminal result delivered while the unrelated write is blocked
    reserved.open(); await tick()
    assert.equal(drained, false)
    last.open({ result: 'accepted' })
    const result = await task
    assert.deepEqual(sent, ['low', 'high']); assert.deepEqual(claims, ['low', 'high', 'max'])
    assert.equal(result.unknown?.scope, terminal.result === 'unknown' ? ('unknownScope' in terminal ? 'model' : 'provider') : undefined)
    assert.deepEqual(result.accepted, 'modelUnsupported' in terminal ? [] : ['high'])
    assert.deepEqual(result.advertised, 'allowedLevels' in terminal ? ['untried'] : [])
  }
})

test('all in-flight denials and explicit lists constrain inferred and accepted levels regardless of reply order', async () => {
  const levels = ['low', 'medium', 'high', 'xhigh', 'max']
  const replies: Reply[] = [
    { result: 'rejected', allowedLevels: ['high', 'max', 'ULTRA', 'medium', 'untried'] },
    { result: 'rejected', allowedLevels: ['high', 'max', 'xhigh', 'ultra'] },
    { result: 'accepted' },
    { result: 'accepted' },
  ]
  for (const reversed of [false, true]) {
    const delivered = levels.map(() => gate<Reply>()), ready = gate<void>(), sent: string[] = []
    const task = scheduleLevels(levels, 4, new AbortController().signal, {
      current: async () => true, reserve: async () => 'reserved',
      send: async level => { sent.push(level); if (sent.length === 4) ready.open(); return delivered[levels.indexOf(level)].wait },
    })
    await ready.wait
    // First observer closes admission; responses from all four still participate in evidence.
    for (const i of reversed ? [1, 3, 2, 0] : [0, 2, 3, 1]) delivered[i].open(replies[i])
    const batch = await task
    assert.deepEqual(sent, ['low', 'medium', 'high', 'xhigh'])
    assert.deepEqual(batch.accepted, ['high']); assert.deepEqual(batch.advertised, ['max'])
  }
})

test('cancel or context change after a successful claim suppresses dispatch and stale additions', async () => {
  for (const mode of ['cancel', 'revoke', 'context']) {
    const cancel = new AbortController(), reserving = gate<void>(), reserved = gate<void>(), reply = gate<Reply>()
    const sent: string[] = []; let current = true
    const task = scheduleLevels(['low', 'high', 'max'], 4, cancel.signal, {
      current: async () => current,
      reserve: async level => {
        if (level === 'high') { reserving.open(); await reserved.wait; if (mode === 'revoke') return 'stale' }
        return 'reserved'
      },
      send: async level => { sent.push(level); return reply.wait },
    })
    await reserving.wait
    if (mode === 'cancel') cancel.abort()
    if (mode === 'context') current = false
    reserved.open(); reply.open({ result: 'accepted' })
    const result = await task
    assert.deepEqual(sent, ['low']); assert.deepEqual(result.accepted, []); assert.equal(result.cancelled, true)
  }
})

test('duplicates send nothing; exhaustion prevents new probes without discarding already confirmed responses', async () => {
  const claims: string[] = [], sent: string[] = []
  const batch = await scheduleLevels(['low', 'medium', 'high', 'xhigh'], 4, new AbortController().signal, {
    current: async () => true,
    reserve: async level => { claims.push(level); return level === 'low' ? 'duplicate' : level === 'high' ? 'exhausted' : 'reserved' },
    send: async level => { sent.push(level); return { result: 'accepted' } },
  })
  assert.deepEqual(sent, ['medium']); assert.deepEqual(claims, ['low', 'medium', 'high'])
  assert.deepEqual(batch.accepted, ['medium']); assert.equal(batch.exhaustedAt, 'high')
})

test('only an explicitly model-scoped unknown advances to the next model; confirmed rows survive either stop', async () => {
  for (const kind of ['local', 'provider', 'unclassified', 'exception']) {
    const visited: string[] = [], saved: string[] = []
    const action = await scheduleModels(['first', 'mixed', 'last'], model => scheduleLevels(['low', 'medium', 'high'], 1, new AbortController().signal, {
      current: async () => true, reserve: async () => 'reserved',
      send: async level => {
        visited.push(`${model}/${level}`)
        if (model === 'mixed' && level === 'medium') {
          if (kind === 'local') return { result: 'unknown', unknownScope: 'model', reason: 'ambiguous_completion' }
          if (kind === 'provider') return { result: 'unknown', unknownScope: 'provider', status: 503 }
          if (kind === 'exception') throw new Error('fixture body not for diagnostics')
          return { result: 'unknown', status: 200 }
        }
        return { result: 'accepted' }
      },
    }), async (model, batch) => { saved.push(...batch.accepted.map(level => `${model}/${level}`)); return true })
    const first = ['first/low', 'first/medium', 'first/high'], last = kind === 'local' ? ['last/low', 'last/medium', 'last/high'] : []
    assert.equal(action, kind === 'local' ? 'continue' : 'provider-stop')
    assert.deepEqual(visited, [...first, 'mixed/low', 'mixed/medium', ...last])
    assert.deepEqual(saved, [...first, 'mixed/low', ...last])
  }
})

test('a four-wide wave drains: provider reason wins over model-local reason in either order', async () => {
  for (const providerFirst of [true, false]) {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    const ready = gate<void>(), replies = levels.map(() => gate<Reply>()), sent: string[] = []
    const task = scheduleModels(['mixed', 'unreached'], model => scheduleLevels(levels, 4, new AbortController().signal, {
      current: async () => true, reserve: async () => 'reserved',
      send: async level => { sent.push(`${model}/${level}`); if (sent.length === 4) ready.open(); return replies[levels.indexOf(level)].wait },
    }), async (model, batch) => {
      assert.equal(model, 'mixed')
      assert.deepEqual(batch.unknown, { scope: 'provider', level: 'medium', reason: 'rate_limit', status: 429 })
      assert.deepEqual(batch.accepted, ['high', 'xhigh'])
      return true
    })
    await ready.wait
    const local = () => replies[0].open({ result: 'unknown', status: 200, unknownScope: 'model', reason: 'model_mismatch' })
    const provider = () => replies[1].open({ result: 'unknown', status: 429, unknownScope: 'provider', reason: 'rate_limit' })
    for (const answer of providerFirst ? [provider, local] : [local, provider]) { answer(); await tick() }
    replies[2].open({ result: 'accepted' }); replies[3].open({ result: 'accepted' })
    assert.equal(await task, 'provider-stop'); assert.deepEqual(sent, levels.slice(0, 4).map(level => `mixed/${level}`))
  }
})

test('budget exhaustion overrides a model skip but not a concurrent provider stop; neither loses confirmed levels', async () => {
  for (const scope of ['model', 'provider'] as const) {
    const levels = ['low', 'medium', 'high'], gateReply = gate<Reply>(), atLimit = gate<void>(), saved: string[] = []
    const task = scheduleModels(['model1', 'unreached'], model => scheduleLevels(levels, 4, new AbortController().signal, {
      current: async () => true, reserve: async level => {
        if (level !== 'high') return 'reserved'
        atLimit.open(); return 'exhausted'
      },
      send: async level => level === 'low' ? gateReply.wait : { result: 'accepted' },
    }), async (model, batch) => {
      assert.equal(model, 'model1'); assert.equal(batch.exhaustedAt, 'high'); assert.equal(batch.unknown?.scope, scope)
      saved.push(...batch.accepted); return true
    })
    await atLimit.wait; gateReply.open({ result: 'unknown', unknownScope: scope })
    assert.equal(await task, scope === 'model' ? 'continue' : 'provider-stop'); assert.deepEqual(saved, ['medium'])
  }
})

test('an ambiguous provider failure does not mask a concurrent quota or outage reason', async () => {
  for (const specific of [{ reason: 'billing', status: 400 }, { reason: 'server_error', status: 503 }] as const) {
    const ready = gate<void>(), ambiguous = gate<Reply>(), actionable = gate<Reply>()
    const batch = scheduleLevels(['low', 'medium'], 4, new AbortController().signal, {
      current: async () => true, reserve: async () => 'reserved',
      send: async level => { if (level === 'low') return ambiguous.wait; ready.open(); return actionable.wait },
    })
    await ready.wait; ambiguous.open({ result: 'unknown' }); await tick()
    actionable.open({ result: 'unknown', unknownScope: 'provider', ...specific })
    assert.deepEqual((await batch).unknown, { scope: 'provider', level: 'medium', ...specific })
  }
})

test('focus loss while draining supersedes both unknown scopes without undoing an earlier checkpoint', async () => {
  for (const unknownScope of ['model', 'provider'] as const) {
    const ready = gate<void>(), wire = gate<Reply>(), sent: string[] = [], saved: string[] = []
    let focused = true
    const task = scheduleModels(['first', 'second', 'unreached'], model => scheduleLevels(['low', 'high'], 4, new AbortController().signal, {
      current: async () => focused, reserve: async () => 'reserved',
      send: async level => {
        sent.push(`${model}/${level}`)
        if (model === 'second' && level === 'high') { ready.open(); return wire.wait }
        return { result: 'accepted' }
      },
    }), async (model, batch) => { saved.push(...batch.accepted.map(level => `${model}/${level}`)); return true })
    await ready.wait; focused = false; wire.open({ result: 'unknown', unknownScope })
    assert.equal(await task, 'cancelled')
    assert.deepEqual(sent, ['first/low', 'first/high', 'second/low', 'second/high']); assert.deepEqual(saved, ['first/low', 'first/high'])
  }
})

test('a refused checkpoint stops dispatch before the next model', async () => {
  const ready = gate<void>(), persisted = gate<boolean>(), sent: string[] = []
  const task = scheduleModels(['one', 'two'], model => scheduleLevels(['low'], 1, new AbortController().signal, {
    current: async () => true, reserve: async () => 'reserved', send: async () => { sent.push(model); return { result: 'accepted' } },
  }), async () => { ready.open(); return persisted.wait })
  await ready.wait; assert.deepEqual(sent, ['one']); persisted.open(false)
  assert.equal(await task, 'cancelled'); assert.deepEqual(sent, ['one'])
})

test('one stalled HTTP 200 body permits the next model at width one, never a retry of the stalled request', async () => {
  for (const healthy of [false, true]) {
    const guard = bodyTimeoutGuard(), sent: string[] = [], widths: number[] = []
    const action = await scheduleModels(['stalled','other','last'], async model => {
      widths.push(guard.width(8))
      return guard.settle(await scheduleLevels(['low'], guard.width(8), new AbortController().signal, {
        current: async () => true, reserve: async () => 'reserved', send: async () => {
          sent.push(model)
          return model === 'stalled' || !healthy ? {result:'unknown',unknownScope:'provider',reason:'timeout',status:200} : {result:'accepted'}
        },
      }))
    }, async () => true)
    assert.deepEqual(sent, healthy ? ['stalled','other','last'] : ['stalled','other'])
    assert.deepEqual(widths, healthy ? [8,1,8] : [8,1]); assert.equal(action, healthy ? 'continue' : 'provider-stop')
  }
})

for (const stop of [{ reason: 'redirect', status: 302 }, { reason: 'invalid_response', status: 200 }] as const) {
  for (const timeoutFirst of [true, false]) {
    test(`provider ${stop.reason} stops the next model when a 200 body timeout arrives ${timeoutFirst ? 'first' : 'last'}`, async () => {
      const guard = bodyTimeoutGuard(), started: string[] = []
      const ready = gate<void>(), timeout = gate<Reply>(), terminal = gate<Reply>()
      const task = scheduleModels(['mixed', 'unreached'], async model => {
        started.push(model)
        return guard.settle(await scheduleLevels(['low', 'high'], guard.width(4), new AbortController().signal, {
          current: async () => true, reserve: async () => 'reserved',
          send: async level => { if (level === 'low') return timeout.wait; ready.open(); return terminal.wait },
        }))
      }, async () => true)
      await ready.wait
      const stall = () => timeout.open({ result: 'unknown', unknownScope: 'provider', reason: 'timeout', status: 200 })
      const fail = () => terminal.open({ result: 'unknown', unknownScope: 'provider', ...stop })
      for (const respond of timeoutFirst ? [stall, fail] : [fail, stall]) { respond(); await tick() }
      assert.equal(await task, 'provider-stop')
      assert.deepEqual(started, ['mixed'])
    })
  }
}
