import * as vscode from 'vscode'
import { Budget, budgetScope } from './budget.js'
import { probe, probeDestination } from './metadata.js'
import type { Candidate } from './config.js'
import { scheduleLevels, scheduleModels, bodyTimeoutGuard, scopedGrant, type CheckAction } from './schedule.js'

// These are candidates for the wire check, not a list of supported values.
const candidates = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'minimal', 'none']
type Update = (model: Candidate, name: string, evidence: 'gateway-model' | 'gateway-accepted') => void
type LevelBatch = Awaited<ReturnType<typeof scheduleLevels>>

export function localBudget(ctx: vscode.ExtensionContext) {
  const uri = ctx.globalStorageUri
  if (vscode.env.remoteName || vscode.env.uiKind !== vscode.UIKind.Desktop || uri.authority || uri.query || uri.fragment ||
    (uri.scheme !== 'file' && uri.scheme !== 'vscode-userdata')) throw new Error('Local desktop storage required')
  return new Budget(uri.with({ scheme: 'file' }).fsPath)
}

function route(provider: Candidate['provider'], m: Candidate) {
  // Kilo may inherit a different SDK from its catalog. Never pay to test a guessed route.
  if (!provider.npm && !(m.model.provider as Record<string, unknown> | undefined)?.npm) return
  if (!candidates.every(n => configured(m, n))) return probeDestination(provider, m.modelID)?.href
}

function terms(id: string, endpoint: string) {
  return `Up to 64 potentially billable requests TOTAL for ${id} at ${endpoint} with this key, shared by current and future model additions. Up to 8 at a time in this window for one model on a new approval; existing approvals keep their original balance and parallelism. Each request: up to 16 output tokens and 10 seconds. A model-specific failure skips that model, not the next one. At 0 requests remaining, future paid checks stop. No automatic renewal or refill.`
}

/** Prepare BEFORE the first saved-key/destination prompt. No credential read, grant, or
 * network traffic here. The host must show `terms` and call allow only on explicit opt-in. */
export async function preparePaidChoice(ctx: vscode.ExtensionContext, provider: Candidate['provider'], models: Candidate[], signal: AbortSignal, selectedProvider?: string) {
  const disabled = () => signal.aborted || !!ctx.globalState.get('auto.off')
  if (!models.length || disabled()) return
  const id = models[0].providerID
  if (id !== selectedProvider || !models.every(m => m.providerID === id)) return
  const endpoints = new Set(models.map(m => route(provider, m)).filter((s): s is string => !!s))
  if (endpoints.size !== 1) return
  const [endpoint] = endpoints
  const budget = localBudget(ctx)
  const generation = await budget.checkpoint()
  if (disabled()) return
  let used = false
  const scopeFor = (key: string) => {
    if (used) return
    used = true
    const keyed = { ...provider, options: { ...provider.options as Record<string, unknown>, apiKey: key } }
    if (models.some(m => route(keyed, m) === endpoint)) return budgetScope(id, endpoint, key)
  }
  return {
    endpoint,
    terms: `Use the saved Kilo key for ${id} to read model metadata at ${(provider.options as Record<string, unknown>).baseURL}? Metadata only sends no paid checks. Allow 64 requests also enables checks for missing levels. ${terms(id, endpoint)}`,
    async decline(key: string) {
      const scope = scopeFor(key)
      if (scope) await scopedGrant(ctx.globalState, scope).decline()
    },
    async allow(key: string, current: () => Promise<boolean>) {
      const scope = scopeFor(key)
      if (!scope || disabled()) return false
      const status = await budget.inspect(scope)
      // The key may not have been saved when the prompt opened. Bind its answer to the
      // original generation as well as the concrete credential used to inspect the balance.
      return !!await scopedGrant(ctx.globalState, scope).confirm(budget, status,
        async () => await current() && generation === await budget.checkpoint() && !disabled())
    },
  }
}

function label(model: Candidate, level: string) { return `${model.providerID}/${model.modelID}, ${level}` }

// Keep only fixed diagnostic classes, never provider strings, returned model IDs, or response bodies.
function failure(u: NonNullable<LevelBatch['unknown']>) {
  const status = u.status !== undefined && Number.isInteger(u.status) && u.status >= 100 && u.status <= 599 ? `HTTP ${u.status}` : ''
  switch (u.reason) {
    case 'model_mismatch': return 'model mismatch'
    case 'ambiguous_completion': return 'inconclusive completion'
    case 'request_incompatible': return 'model request failed validation (HTTP 400)'
    case 'model_unavailable': return 'model unavailable'
    case 'billing': return status ? `billing or quota (${status})` : 'billing or quota'
    case 'timeout': return 'timeout'
    case 'network': return 'network or TLS failure'
    case 'configuration': return 'configuration error'
    case 'invalid_response': return status ? `invalid response (${status})` : 'invalid response'
    default: return status || 'connection or provider error'
  }
}

/** Per sync, not persisted. Preferred/tail chunks and non-adjacent route groups share one notice. */
export function newAutomaticRun(selectedProvider?: string) {
  type Summary = { models: number; firstSkip?: string; providerStop?: string; exhausted?: string; health: ReturnType<typeof bodyTimeoutGuard> }
  const summaries = new Map<string, Summary>()
  return {
    selectedProvider,
    skipped: new Set<string>(),
    summary(scope: string) {
      const value = summaries.get(scope) ?? { models: 0, health: bodyTimeoutGuard() }
      summaries.set(scope, value)
      return value
    },
    report() {
      for (const s of summaries.values()) {
        const lines = []
        if (s.providerStop) lines.push(`${s.providerStop}. Automatic checks for this provider stopped for this run. Check the provider's status and your access.`)
        if (s.exhausted) lines.push(`${s.exhausted}: 0 of 64 approved requests remaining. No more paid checks for current or future models under this approval; metadata checks are still available.`)
        if (s.firstSkip) lines.push(`${s.firstSkip}. Skipped remaining checks for this model${s.models > 1 ? ` and ${s.models - 1} more` : ''}.${s.exhausted || s.providerStop ? '' : ' Other models remain eligible.'} Check the model ID and route.`)
        if (lines.length) void vscode.window.showInformationMessage([...lines, 'Confirmed levels are kept; unconfirmed levels are not added.'].join(' '))
      }
      summaries.clear()
    },
  }
}

export async function checkMissing(ctx: vscode.ExtensionContext, provider: Candidate['provider'], models: Candidate[],
  signal: AbortSignal, current: (model: Candidate) => Promise<boolean>, add: Update,
  run: ReturnType<typeof newAutomaticRun>, checkpoint?: () => Promise<boolean>): Promise<CheckAction> {
  const opts = provider.options as Record<string, unknown>
  const disabled = () => signal.aborted || !!ctx.globalState.get('auto.off')
  if (disabled()) return 'cancelled'
  if (typeof opts.apiKey !== 'string' || !models.every(m => m.providerID === models[0].providerID)) return 'continue'
  // Group adjacent equal routes only. Grouping the entire batch by route would
  // silently reprioritize A/1, B/2, A/3 into A/1, A/3, B/2.
  const groups: { endpoint: string; models: Candidate[] }[] = []
  for (const m of models) {
    const endpoint = route(provider, m)
    if (!endpoint) continue
    const last = groups.at(-1)
    if (last?.endpoint === endpoint) last.models.push(m)
    else groups.push({ endpoint, models: [m] })
  }
  if (!groups.length) return 'continue'
  const budget = localBudget(ctx)
  const generation = await budget.checkpoint()
  for (const { endpoint, models: group } of groups) {
    const providerID = group[0].providerID
    if (run.selectedProvider !== undefined && run.selectedProvider !== providerID) continue
    const scope = budgetScope(providerID, endpoint, opts.apiKey)
    const grant = scopedGrant(ctx.globalState, scope)
    if (run.skipped.has(scope)) continue
    if (disabled() || !await current(group[0])) return 'cancelled'
    const status = await budget.inspect(scope)
    if (generation !== await budget.checkpoint() || disabled()) return 'cancelled'
    let epoch = status.epoch
    const admission = grant.admission(status, run.selectedProvider === providerID)
    if (admission === 'skip') continue
    if (admission === 'confirm') {
      const yes = status.allowed ? 'Use remaining requests' : 'Allow 64 requests', no = 'Metadata only'
      const message = status.allowed
        ? `Resume automatic checks for ${providerID} at ${endpoint} with this key? ${status.remaining} of 64 potentially billable requests remain; up to ${grant.width(epoch)} at a time. No renewal or refill.`
        : `Automatically check missing reasoning levels? ${terms(providerID, endpoint)}`
      const choice = await vscode.window.showWarningMessage(message, yes, no)
      if (choice !== yes) { run.skipped.add(scope); if (choice === no) await grant.decline(); continue }
      const confirmed = await grant.confirm(budget, status, async () => await current(group[0]) && generation === await budget.checkpoint() && !disabled())
      if (!confirmed) return 'cancelled'
      epoch = confirmed
    }

    const summary = run.summary(scope)
    const first = group[0]
    let lastCheck = label(first, candidates.find(n => !configured(first, n))!)
    if (admission === 'exhausted') {
      summary.exhausted = lastCheck
      run.skipped.add(scope)
      continue
    }

    const width = grant.width(epoch)
    const action = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Checking reasoning levels: ${providerID}`, cancellable: true }, async (progress, token) => {
      const cancel = new AbortController()
      const handle = token.onCancellationRequested(() => cancel.abort())
      const deadline = AbortSignal.any([signal, cancel.signal, AbortSignal.timeout(120000)])
      try {
        return await scheduleModels(group, async m => {
          const remote = typeof m.model.id === 'string' ? m.model.id : m.modelID
          return summary.health.settle(await scheduleLevels(candidates.filter(n => !configured(m, n)), summary.health.width(width), deadline, {
            current: async () => await current(m) && generation === await budget.checkpoint() && !token.isCancellationRequested && !disabled() && !grant.metadataOnly(epoch),
            reserve: level => budget.reserve(scope, epoch, { model: remote, protocol: endpoint.endsWith('/responses') ? 'responses' : 'chat', level, context: m.context, maxOutputTokens: 16 }),
            send: level => {
              lastCheck = label(m, level)
              progress.report({ message: `${m.modelID}: ${level}` })
              return probe(provider, m.modelID, level, deadline)
            },
          }))
        }, async (m, batch) => {
          if (deadline.aborted || disabled()) return false
          for (const name of batch.accepted) add(m, name, 'gateway-accepted')
          for (const name of batch.advertised) if (!configured(m, name)) add(m, name, 'gateway-model')
          if (batch.unknown) {
            const notice = `${label(m, batch.unknown.level)}: ${failure(batch.unknown)}`
            if (batch.unknown.scope === 'provider') summary.providerStop = notice
            else { summary.firstSkip ??= notice; summary.models++ }
          }
          if (batch.exhaustedAt) summary.exhausted = label(m, batch.exhaustedAt)
          return (!checkpoint || await checkpoint()) && !deadline.aborted && !disabled()
        })
      } finally { handle.dispose() }
    })
    if (action === 'cancelled' || disabled()) return 'cancelled'
    // The last successful dispatch can consume slot 64 with no 65th reservation to signal exhaustion.
    if (!summary.exhausted) {
      const balance = await budget.inspect(scope)
      if (!balance.allowed || balance.epoch !== epoch || disabled()) return 'cancelled'
      if (!balance.remaining) summary.exhausted = lastCheck
    }
    if (summary.exhausted) run.skipped.add(scope)
    if (action === 'provider-stop') return action
  }
  return 'continue'
}

function configured(c: Candidate, name: string) {
  return !c.stockLevels?.has(name) && Object.keys(c.model.variants ?? {}).some(k => k.toLowerCase() === name.toLowerCase())
}
