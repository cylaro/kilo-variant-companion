import type { Budget, Reservation } from './budget.js'
import type { probe } from './metadata.js'

type Reply = Awaited<ReturnType<typeof probe>>
type Width = 1 | 4 | 8
type Balance = Awaited<ReturnType<Budget['inspect']>>
type Markers = { get(key: string): unknown; update(key: string, value: unknown): PromiseLike<void> }

/** Markers can narrow an active ledger grant, never license a send on their own. */
export function scopedGrant(state: Markers, scope: string) {
  const four = 'auto.parallel4.' + scope, eight = 'auto.parallel8.' + scope, denial = 'auto.metadataOnly.' + scope
  const metadataOnly = (epoch: string) => { const mark = state.get(denial); return !!mark && mark !== epoch }
  return {
    width(epoch: string): Width { return state.get(four) === epoch ? 4 : state.get(eight) === epoch ? 8 : 1 },
    metadataOnly,
    admission(balance: Balance, setup: boolean) {
      if (balance.allowed && !balance.remaining) return 'exhausted'
      if (balance.allowed && !metadataOnly(balance.epoch)) return 'use'
      return setup ? 'confirm' : 'skip'
    },
    decline() { return state.update(denial, true) },
    // Only call on explicit affirmative consent to the displayed terms for this route/key.
    async confirm(budget: Pick<Budget, 'inspect' | 'allow'>, before: Balance, current: () => Promise<boolean>) {
      const now = await budget.inspect(scope)
      if (now.epoch !== before.epoch || (now.allowed && !now.remaining) || !await current()) return
      let epoch = now.epoch
      if (!now.allowed) {
        // A different (possibly older) window may have won between inspect and allow.
        const created = await budget.allow(scope, epoch, true)
        if (!created) return
        epoch = created
        await state.update(eight, epoch)
      }
      if (!await current()) return
      const balance = await budget.inspect(scope)
      if (!balance.allowed || balance.epoch !== epoch || !balance.remaining) return
      if (metadataOnly(epoch)) {
        // Lift the denial only for THIS epoch. A racing revocation must not clear it
        // for the next grant. Older extension versions still see the conservative denial.
        await state.update(denial, epoch)
      }
      return await current() ? epoch : undefined
    },
  }
}

type Unknown = { scope: 'model' | 'provider'; level: string; status?: number; reason?: Reply['reason'] }
export type CheckAction = 'continue' | 'provider-stop' | 'cancelled'
type Checks = {
  current(): Promise<boolean>
  reserve(level: string): Promise<Reservation>
  send(level: string): Promise<Reply>
}

/** One model only. Serialize admission, not network latency. A committed reservation that
 * loses the race with a stop stays spent; it is never returned or used on another request. */
export async function scheduleLevels(levels: string[], width: Width, signal: AbortSignal, checks: Checks) {
  const pending = new Set<Promise<void>>()
  const accepted = new Set<string>(), denied = new Set<string>(), lists: string[][] = []
  let stopped = false, unsupported = false, cancelled = false
  let unknown: Unknown | undefined, exhaustedAt: string | undefined
  function priority(u: Unknown) {
    if (u.scope === 'model') return 0
    // The guard may recover a stalled 200 body, but no other provider stop in the wave.
    if (u.reason === 'timeout' && u.status === 200) return 1
    return (u.status === 401 || u.status === 402 || u.status === 403 || u.status === 429 || (u.status ?? 0) >= 500 ||
      u.reason === 'billing' || u.reason === 'network' || u.reason === 'timeout') ? 3 : 2
  }
  function inconclusive(level: string, reply?: Reply) {
    stopped = true
    const issue: Unknown = { level, scope: reply?.unknownScope === 'model' ? 'model' : 'provider', status: reply?.status, reason: reply?.reason }
    // A model skip cannot mask a provider stop; prefer its actionable cause over an ambiguous response.
    if (!unknown || priority(issue) > priority(unknown)) unknown = issue
  }
  async function receive(level: string) {
    try {
      const reply = await checks.send(level)
      // Close admission immediately, before performing any further asynchronous check.
      if (reply.result === 'unknown') return inconclusive(level, reply)
      if (reply.modelUnsupported) { unsupported = stopped = true; return }
      if (reply.result === 'accepted') accepted.add(level)
      else denied.add(level.toLowerCase())
      if (reply.allowedLevels?.length) { lists.push(reply.allowedLevels); stopped = true }
    } catch { inconclusive(level) }
  }
  try {
    for (const level of levels) {
      if (pending.size >= width) await Promise.race(pending)
      if (stopped || signal.aborted) break
      if (!await checks.current()) { cancelled = true; break }
      if (stopped || signal.aborted) break
      const claim = await checks.reserve(level)
      if (claim === 'duplicate') continue
      if (claim !== 'reserved') { if (claim === 'exhausted') exhaustedAt = level; else cancelled = true; break }
      if (stopped || signal.aborted) break
      if (!await checks.current()) { cancelled = true; break }
      if (stopped || signal.aborted) break
      const call = receive(level).finally(() => pending.delete(call))
      pending.add(call)
    }
  } finally { await Promise.all(pending) } // Also drain on ledger or config read failure.
  cancelled ||= signal.aborted || !await checks.current() || signal.aborted

  // Responses can disagree or arrive out of order. A whole-model denial vetoes all rows;
  // a named denial vetoes that name, and an advertised value must agree with every list.
  // Keep exact spelling for positive evidence; don't restore a denied case variant.
  const consistent = (name: string) => !denied.has(name.toLowerCase()) && lists.every(list => list.includes(name))
  const usable = !cancelled && !unsupported
  const advertised = usable && lists.length ? lists[0].filter(name => !accepted.has(name) && consistent(name)) : []
  return { accepted: usable ? levels.filter(name => accepted.has(name) && consistent(name)) : [], advertised, unknown, exhaustedAt, cancelled }
}

type LevelBatch = Awaited<ReturnType<typeof scheduleLevels>>

/** One different model may establish health after headers arrived but a body stalled.
 * Never resend the stalled request. No second exception until good evidence arrives. */
export function bodyTimeoutGuard() {
  let uncertain = false
  return {
    width(normal: Width): Width { return uncertain ? 1 : normal },
    settle(batch: LevelBatch) {
      if (!batch.unknown) {
        if (batch.accepted.length || batch.advertised.length) uncertain = false
        return batch
      }
      if (uncertain) return { ...batch, unknown: { ...batch.unknown, scope: 'provider' as const } }
      if (batch.unknown.reason !== 'timeout' || batch.unknown.status !== 200) return batch
      uncertain = true
      return { ...batch, unknown: { ...batch.unknown, scope: 'model' as const } }
    },
  }
}

/** Run models in order within one grant. Never start the next model before the previous
 * wave has drained. Publish consistent rows even when the same wave also produced a stop. */
export async function scheduleModels<M>(models: readonly M[], check: (model: M) => Promise<LevelBatch>,
  keep: (model: M, batch: LevelBatch) => Promise<boolean>): Promise<CheckAction> {
  for (const model of models) {
    const batch = await check(model)
    if (batch.cancelled) return 'cancelled'
    if (!await keep(model, batch)) return 'cancelled'
    if (batch.unknown?.scope === 'provider') return 'provider-stop'
    if (batch.exhaustedAt) break
  }
  return 'continue'
}
