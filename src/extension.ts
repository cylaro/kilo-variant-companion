import * as vscode from 'vscode'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { analyzeConfig, applyVariants, reconcileOwnership, validLevel, type Candidate, type ConfigSnapshot, type Ownership } from './config.js'
import { readConfig, replaceConfig } from './file.js'
import { afterCheck } from './window-refresh.js'

// The official dialog saves config first, auth second. Subscribe only while an
// authorized lookup is pending. Subscribe before reading to close the save race.
async function savedCredential(id: string, signal: AbortSignal) {
  const { authFile, storedKey } = await import('./credential.js')
  const file = authFile()
  if (!file || signal.aborted) return
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(dirname(file)), basename(file)), false, false, true)
  let finish!: (value: string | undefined) => void
  const result = new Promise<string | undefined>(resolve => { finish = resolve })
  const stop = () => finish(undefined)
  const read = async () => { try { const key = await storedKey(id); if (key) finish(key) } catch { stop() } }
  const listeners = [watcher.onDidCreate(read), watcher.onDidChange(read)]
  signal.addEventListener('abort', stop, { once: true })
  const timeout = setTimeout(stop, 10000)
  try { void read(); return await result }
  finally { clearTimeout(timeout); signal.removeEventListener('abort', stop); for (const l of listeners) l.dispose(); watcher.dispose() }
}

// Config.updateGlobal picks the first existing name in this order in Kilo 7.8.27.
const names = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json', 'config.json']
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

async function exists(path: string) {
  return stat(path).then(() => true, (e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return false
    throw e
  })
}

async function save(file: string, before: string, after: string) {
  const uri = vscode.Uri.file(file)
  const doc = await vscode.workspace.openTextDocument(uri)
  // VS Code's text model excludes the UTF-8 BOM; the save operation preserves the encoding.
  const previous = before.replace(/^\uFEFF/, '')
  const updated = after.replace(/^\uFEFF/, '')
  if (doc.isDirty || doc.getText() !== previous) return false
  const edit = new vscode.WorkspaceEdit()
  // Use the editor's normal save path, never an ad-hoc copy of a file that might contain secrets.
  edit.replace(uri, new vscode.Range(doc.positionAt(0), doc.positionAt(previous.length)), updated)
  if (!await vscode.workspace.applyEdit(edit) || doc.getText() !== updated) return false
  return doc.save()
}

export async function activate(context: vscode.ExtensionContext) {
  if (!vscode.workspace.isTrusted || vscode.env.remoteName) return
  const compatible = () => /^7\./.test(String(vscode.extensions.getExtension('kilocode.kilo-code')?.packageJSON.version ?? ''))
  if (!compatible()) return
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  if (!isAbsolute(base) || process.env.KILO_CONFIG || process.env.KILO_CONFIG_DIR || process.env.KILO_CONFIG_CONTENT) return
  const dir = join(base, 'kilo')
  const key = 'kvc1.' + createHash('sha256').update(dir).digest('hex')
  const controller = new AbortController()
  const { signal } = controller
  let automatic = new AbortController()
  let generation = 0
  context.subscriptions.push({ dispose: () => controller.abort() })
  type State = { file: string; snapshot: ConfigSnapshot; ownership: Ownership[] }
  let state = context.globalState.get<State>(key)
  let valid = false
  let pending = Promise.resolve()
  const refresh = afterCheck(context, () => pending)
  let queued = false
  const active = () => !signal.aborted && vscode.window.state.focused && vscode.workspace.isTrusted
  const persist = async (next: State) => {
    state = next
    await context.globalState.update(key, next)
  }
  async function primary() {
    // Kilo merges all global files. With layered definitions the effective route is ambiguous.
    const files = names.map(n => join(dir, n))
    const present = await Promise.all(files.map(exists))
    if (present.filter(Boolean).length > 1) return undefined
    return files[present.findIndex(Boolean)] ?? files[0]
  }
  async function commit(file: string, before: string, after: string, additions?: Ownership[]) {
    if (before === after || !active() || await primary() !== file) return false
    // Preserve ownership after an unrelated edit only if the exact inserted rows
    // and their provider contexts survived our successful editor save.
    return replaceConfig(file, before, after, () => save(file, before, after), additions?.length ? now =>
      !!analyzeConfig(now) && reconcileOwnership(now, additions).ownership.length === additions.length : undefined)
  }
  type Mode = 'baseline' | 'added' | 'provider' | 'automatic' | 'model' | 'verify'
  const watchKey = key + '.watchedProvider'
  async function sync(mode: Mode) {
    const generationAtStart = generation
    const verify = mode === 'verify'
    const manual = mode === 'model' || verify
    const chooseProvider = mode === 'provider' || mode === 'automatic'
    const file = await primary()
    if (!file || signal.aborted) { valid = false; return }
    const source = await readConfig(file)
    if (source === undefined && state?.ownership.length) return
    let text = source ?? '{}'
    const analysis = analyzeConfig(text, state?.snapshot, manual || chooseProvider)
    if (!analysis) { valid = false; return }
    const skip = mode === 'baseline' || !active() || !compatible() || !valid || state?.file !== file
    valid = true
    let owned = reconcileOwnership(text, state?.file === file ? state.ownership : []).ownership
    // Older versions did not distinguish pricing prose from authenticated metadata.
    // Sweep only rows that still match our recorded source AND provider context.
    const legacy = owned.filter(entry => !entry.evidence)
    if (mode === 'baseline' && active() && legacy.length) {
      const cleanup = reconcileOwnership(text, legacy, true)
      if (cleanup.text !== text) {
        if (!await commit(file, text, cleanup.text)) return
        text = cleanup.text
        refresh.project()
        void vscode.window.showInformationMessage('Removed unchanged additions from the older verification policy. Manual choices were kept. If the Kilo menu is cached, reload the window when convenient.')
      }
      owned = [...owned.filter(entry => entry.evidence), ...cleanup.ownership]
    }
    const next: State = { file, snapshot: analysis.snapshot, ownership: owned }
    // Background windows may observe the same save. They must not overwrite the
    // focused window's provenance record with an older copy of globalState.
    if (active() && JSON.stringify(state) !== JSON.stringify(next)) await persist(next)
    else state = next
    if (skip || (mode === 'added' && !analysis.candidates.length)) return
    const { discover, metadataDestination, probeDestination, probe, maxMetadataConcurrency } = await import('./metadata.js')
    let watched = context.globalState.get<string>(watchKey)
    const destination = verify ? probeDestination : metadataDestination
    let selected = analysis.candidates.filter(c => (mode !== 'added' || c.providerID === watched) && destination(c.provider, c.modelID))
    if (mode === 'added' && !selected.length) return
    const addressGrant = (id: string) => key + '.destination.' + createHash('sha256').update(id).digest('hex')
    if (chooseProvider) {
      const ids = [...new Set(selected.map(c => c.providerID))].sort()
      const choice = await vscode.window.showQuickPick([{ label: 'No checks', id: undefined }, ...ids.map(id => ({label: id, id}))],
        { title: mode === 'provider' ? 'Check one provider (metadata only)' : 'Enable automatic checks for one provider' })
      if (!choice || !active()) return
      if (mode === 'automatic') {
        if (generationAtStart !== generation) return
        await context.globalState.update(watchKey, choice.id)
        // Disable runs outside this queue and may have revoked the watch during the save.
        if (generationAtStart !== generation) return
        watched = choice.id
        if (choice.id) {
          automatic = new AbortController()
          await context.globalState.update('auto.off', undefined)
        }
      }
      if (!choice.id) return
      selected = selected.filter(c => c.providerID === choice.id)
    }
    const defaults = vscode.workspace.getConfiguration('kilo-code.new.model')
    const wanted = analysis.defaultModel ?? `${defaults.get<string>('providerID')}/${defaults.get<string>('modelID')}`
    const preferred = selected.find(c => `${c.providerID}/${c.modelID}` === wanted)
    if (preferred) selected = [preferred, ...selected.filter(c => c !== preferred)]
    let requested: string | undefined
    if (manual) {
      if (!selected.length) { void vscode.window.showInformationMessage('No eligible custom models in the global Kilo config.'); return }
      const choice = await vscode.window.showQuickPick(selected.map(c => ({ label: `${c.providerID}/${c.modelID}`, candidate: c })), { title: 'Check advertised reasoning levels for one model' })
      if (!choice) return
      selected = [choice.candidate]
      if (verify) {
        requested = await vscode.window.showInputBox({ title: 'One reasoning level to verify', value: 'xhigh', validateInput: s => validLevel(s) ? undefined : 'Enter a level name, not Default.' })
        if (!requested || !validLevel(requested)) return
        const variants = choice.candidate.model.variants
        if (record(variants) && Object.entries(variants).some(([name, v]) => name.toLowerCase() === requested!.toLowerCase() && record(v) && v.disabled === true)) {
          void vscode.window.showInformationMessage('This level is manually disabled. No request sent.'); return
        }
      }
    }
    const groups = new Map<string, Candidate[]>()
    for (const candidate of selected) {
      // Unmodified baseline rows exist to preserve the picker, not as proof from
      // this gateway. Manual and disabled rows are never scheduled automatically.
      candidate.stockLevels = new Set(owned.filter(e => e.evidence === 'kilo-default' && e.providerID === candidate.providerID && e.modelID === candidate.modelID).map(e => e.level))
      const group = groups.get(candidate.providerID) ?? []
      group.push(candidate)
      groups.set(candidate.providerID, group)
    }
    const updates = new Map<Candidate, Record<string, Record<string, string>>>()
    const acceptedLevels = new Map<Candidate, Set<string>>()
    const credentials = new Map<string, string>()
    const withdrawn = new Set<Ownership>()
    const stock = new Map<string, Promise<Map<string, Record<string, Record<string, unknown>>>>>()
    let stockSkipped = false
    const stockFor = async (c: Candidate) => {
      let defaults = stock.get(c.providerID)
      if (!defaults) {
        const kilo = vscode.extensions.getExtension('kilocode.kilo-code')!
        defaults = import('./stock.js').then(s => s.readStock(kilo.extensionPath, groups.get(c.providerID)!, signal))
        stock.set(c.providerID, defaults)
      }
      return (await defaults).get(JSON.stringify([c.providerID, c.modelID]))
    }
    let wrote = false
    const checkpoint = async () => {
      if (!updates.size && !withdrawn.size) return true
      for (const [id, used] of credentials) if (await (await import('./credential.js')).storedKey(id) !== used) return false
      const latest = await readConfig(file)
      if (!latest) return false
      let patched = latest
      const additions: Ownership[] = []
      for (const [c, levels] of updates) {
        const original = await stockFor(c)
        if (!original) { stockSkipped = true; continue } // Never narrow a menu we cannot reproduce.
        const applied = applyVariants(patched, c, levels, original)
        patched = applied.text
        additions.push(...applied.ownership.map(row => row.evidence !== 'kilo-default' && (verify || acceptedLevels.get(c)?.has(row.level)) ? { ...row, evidence: 'gateway-accepted' as const } : row))
      }
      const retirement = reconcileOwnership(patched, [...withdrawn], true)
      patched = retirement.text
      if (patched !== latest) {
        if (!await commit(file, latest, patched, withdrawn.size ? undefined : additions)) {
          void vscode.window.showWarningMessage('Kilo config was busy or changed. No further checks in this run.')
          return false
        }
        owned = [...owned.filter(e => !withdrawn.has(e)), ...retirement.ownership, ...additions]
        await persist({ ...next, ownership: owned })
        // Do not overwrite the input snapshot with unrelated edits counted as current.
        // A later model must still pass stillCurrent() and applyVariants().
        wrote = true
        refresh.request() // deferred until the entire operation (including queued saves) drains
      }
      updates.clear(); acceptedLevels.clear(); withdrawn.clear()
      return true
    }
    // Kilo can save unrelated settings while the permission notification is open.
    // Revalidate the actual provider/model and its manual choices, not file formatting.
    const stillCurrent = async (candidates: Candidate[]) => {
      if (!active() || await primary() !== file) return false
      const now = await readConfig(file)
      if (!now) return false
      if (now === text) return true
      const current = analyzeConfig(now, next.snapshot, true)?.candidates ?? []
      return candidates.every(c => current.some(n => n.providerID === c.providerID && n.modelID === c.modelID && n.context === c.context && JSON.stringify(n.model.variants) === JSON.stringify(c.model.variants)))
    }
    let matched = false, advertised = false
    let stopAutomatic = false
    const { checkMissing, newAutomaticRun } = await import('./automatic.js')
    const run = newAutomaticRun(mode === 'automatic' ? watched : undefined)
    try {
    for (const [id, candidates] of groups) {
      if (!await stillCurrent(candidates)) return
      let provider = candidates[0].provider
      const opts = provider.options
      if (!record(opts)) continue
      let saved: string | undefined
      let permitChecks = (mode === 'automatic' || mode === 'added') && id === watched && generationAtStart === generation
      if (opts.apiKey === undefined) {
        if (Array.isArray(provider.env) && provider.env.some(name => typeof name === 'string' && !!process.env[name])) {
          if (manual) void vscode.window.showInformationMessage('Provider has an active environment credential; the saved key was not used.')
          continue
        }
        // A Kilo API credential is bound to a provider ID, NOT to an address.
        // Remember only approval of the exact address; never remember the key.
        const baseURL = opts.baseURL
        if (typeof baseURL !== 'string' || !candidates.every(c => metadataDestination(provider, c.modelID)?.startsWith(baseURL.replace(/\/$/, '') + '/'))) continue
        const grant = addressGrant(id)
        const metadataOnly = grant + '.metadataOnly'
        const wasReadOnly = context.globalState.get(metadataOnly) === baseURL
        if (wasReadOnly && mode !== 'automatic') permitChecks = false
        let bindChoice: ((key: string, current: () => Promise<boolean>) => Promise<boolean | void>) | undefined
        if (context.globalState.get<string>(grant) !== baseURL || (wasReadOnly && mode === 'automatic')) {
          const token = automatic.signal
          const terms = mode === 'automatic' && permitChecks && !context.globalState.get('auto.off') && !token.aborted
            ? await (await import('./automatic.js')).preparePaidChoice(context, provider, candidates, token, watched) : undefined
          if (terms) {
            const yes = 'Allow 64 requests', no = 'Metadata only'
            const choice = await vscode.window.showWarningMessage(terms.terms, yes, no)
            if (choice !== yes && choice !== no) continue
            permitChecks = choice === yes
            bindChoice = choice === yes ? terms.allow : terms.decline
          } else {
            permitChecks = false
            const consent = 'Allow for this address'
            if (await vscode.window.showInformationMessage(`Use the Kilo API key saved for ${id} to read model metadata at ${baseURL}? Only allow an address you trust.`, consent) !== consent) continue
          }
          if (!await stillCurrent(candidates)) return
          if ((mode === 'automatic' || mode === 'added') && !permitChecks) await context.globalState.update(metadataOnly, baseURL)
          await context.globalState.update(grant, baseURL)
        }
        saved = await savedCredential(id, signal)
        if (!saved) { void vscode.window.showInformationMessage(`No supported saved API key for ${id}. No request was sent.`); continue }
        if (context.globalState.get<string>(grant) !== baseURL || !await stillCurrent(candidates)) return
        if (bindChoice) {
          const credential = saved
          const result = await bindChoice(credential, async () => !automatic.signal.aborted && await stillCurrent(candidates) && credential === await (await import('./credential.js')).storedKey(id))
          if (result === false) permitChecks = false
          if (result === true && permitChecks && wasReadOnly) await context.globalState.update(metadataOnly, undefined)
        }
        provider = { ...provider, options: { ...opts, apiKey: saved } }
        credentials.set(id, saved)
      }
      for (let offset = 0; offset < candidates.length;) {
        // Finish the configured default's detail and probes before the rest of the catalog.
        const width = permitChecks && offset === 0 && candidates[0] === preferred ? 1 : 64
        const batch = candidates.slice(offset, offset + width)
        offset += width
        if (!await stillCurrent(batch)) return
        const checked = new Set<string>()
        const missing = new Set<string>()
        let stop = false
        const result = await discover(provider, batch.map(c => c.modelID), signal, (found, efforts, modelID, source, names, eligible) => {
          checked.add(modelID)
          matched ||= found
          advertised ||= efforts
          stop ||= source === 'stop'
          if (eligible && !efforts) missing.add(modelID)
          if (mode === 'model' && names?.length) {
            for (const row of owned) {
              if (row.evidence !== 'kilo-default' && row.providerID === id && row.modelID === modelID && !names.includes(row.level)) withdrawn.add(row)
            }
          }
        }, permitChecks, manual ? 1 : maxMetadataConcurrency)
        if (saved && await (await import('./credential.js')).storedKey(id) !== saved) return
        for (const c of batch) {
          const levels = verify ? undefined : result.get(c.modelID)
          if (levels || (mode === 'provider' && record(c.model.variants) && Object.keys(c.model.variants).length)) updates.set(c, levels ?? {})
        }
        if (permitChecks && !manual && !stop && !stopAutomatic && missing.size && !context.globalState.get('auto.off')) {
          const runSignal = AbortSignal.any([signal, automatic.signal])
          const current = async (c: Candidate) => !runSignal.aborted && !context.globalState.get('auto.off') && await stillCurrent([c]) &&
            (!saved || await (await import('./credential.js')).storedKey(id) === saved)
          try {
            const proceed = await checkMissing(context, provider, batch.filter(c => missing.has(c.modelID)), runSignal, current, (c, name, evidence) => {
              const update = updates.get(c) ?? Object.create(null)
              update[name] = { reasoningEffort: name }
              updates.set(c, update)
              if (evidence === 'gateway-accepted') {
                const names = acceptedLevels.get(c) ?? new Set()
                names.add(name)
                acceptedLevels.set(c, names)
              }
            }, run, checkpoint)
            if (proceed === 'provider-stop') stop = true
            stopAutomatic = proceed === 'cancelled' || runSignal.aborted
          } catch { stopAutomatic = true; void vscode.window.showWarningMessage('Automatic checks stopped. The remaining budget was not renewed.') }
        }
        if (verify && requested) {
          const c = batch[0]
          const endpoint = probeDestination(provider, c.modelID)
          if (!endpoint || !await stillCurrent(batch)) return
          const consent = 'Send one request'
          const confirmed = await vscode.window.showWarningMessage(`Verify ${id}/${c.modelID} (${requested}) at ${endpoint}? ${advertised ? 'Model metadata advertises effort settings.' : 'No conclusive effort list from metadata.'} One possibly billable POST: "Reply OK", up to 16 output tokens, 10 seconds, no retry. No chat history.`, consent)
          if (confirmed !== consent || !await stillCurrent(batch) || (saved && await (await import('./credential.js')).storedKey(id) !== saved)) return
          const outcome = await probe(provider, c.modelID, requested, signal)
          if (!await stillCurrent(batch) || (saved && await (await import('./credential.js')).storedKey(id) !== saved)) return
          const label = `${id}/${c.modelID}, ${requested}: ${outcome.result}${outcome.status === undefined ? '' : ` (HTTP ${outcome.status})`}.`
          if (outcome.result === 'unknown') { void vscode.window.showInformationMessage(label + ' No changes.'); return }
          if (outcome.result === 'accepted') updates.set(c, { [requested]: { reasoningEffort: requested } })
          else for (const row of owned) if (row.evidence !== 'kilo-default' && row.providerID === id && row.modelID === c.modelID && row.level === requested) withdrawn.add(row)
          void vscode.window.showInformationMessage(label + (outcome.result === 'accepted' ? ' The gateway accepted the value; application by the model is not proven.' : ' Manual settings are preserved.'))
        }
        if (!await checkpoint()) return
        if (stop || checked.size !== batch.length) break
      }
    }
    } finally { run.report() }
    if (stockSkipped) void vscode.window.showInformationMessage('Some model defaults could not be determined from this Kilo installation. Those models were left unchanged.')
    else if (!wrote && (mode === 'model' || mode === 'provider') && groups.size) {
      void vscode.window.showInformationMessage(!matched ? 'No usable metadata for this model. Existing choices are unchanged.' : !advertised ? 'Model found in the authenticated catalog, but no reasoning levels were advertised for this route. Existing choices are unchanged.' : 'Advertised levels found; no new entries were written. Existing choices are unchanged.')
    }
  }
  function changed() {
    if (queued || signal.aborted) return
    queued = true
    pending = pending.then(async () => { queued = false; await sync('added') }).catch(() => { valid = false })
  }
  pending = sync('baseline').catch(() => { valid = false })
  const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), `{${names.join(',')}}`)
  const watcher = vscode.workspace.createFileSystemWatcher(pattern)
  context.subscriptions.push(watcher, watcher.onDidCreate(changed), watcher.onDidChange(changed), watcher.onDidDelete(changed))
  // Do not queue revocation behind a running batch or a permission notification.
  context.subscriptions.push(vscode.commands.registerCommand('kiloVariantCompanion.disableAutomatic', async () => {
    generation++
    automatic.abort()
    const { localBudget } = await import('./automatic.js')
    await Promise.all([context.globalState.update('auto.off', true), context.globalState.update(watchKey, undefined), localBudget(context).revokeAll()])
    void vscode.window.showInformationMessage('Automatic paid checks disabled. An already sent request may still be billed. Metadata discovery stays on.')
  }))
  for (const [command, mode] of [['setupAutomatic','automatic'], ['checkProvider','provider'], ['verifyLevel','verify'], ['checkModel','model']] as const) context.subscriptions.push(vscode.commands.registerCommand('kiloVariantCompanion.' + command, () => {
    pending = pending.then(() => sync(mode)).catch(() => { void vscode.window.showWarningMessage('Could not safely complete the check. Unconfirmed choices were not added.') })
    return pending
  }))
  context.subscriptions.push(vscode.window.onDidChangeWindowState(window => {
    if (!window.focused) return
    pending = pending.then(async () => {
      state = context.globalState.get<State>(key) ?? state
      await sync('baseline')
    }).catch(() => { valid = false })
  }))
  context.subscriptions.push(vscode.commands.registerCommand('kiloVariantCompanion.removeAdded', () => {
    pending = pending.then(async () => {
      const file = await primary()
      if (!file || !state || state.file !== file) return
      const text = await readConfig(file)
      if (!text || !analyzeConfig(text)) return
      const result = reconcileOwnership(text, state.ownership, true)
      if (result.text === text || await commit(file, text, result.text)) {
        await persist({ ...state, ownership: result.ownership })
        if (result.text !== text) refresh.project()
        void vscode.window.showInformationMessage('Kilo Variant Companion: no unchanged additions remain.')
      } else void vscode.window.showWarningMessage('Kilo Variant Companion: file busy or changed. No rollback was confirmed.')
    }).catch(() => { void vscode.window.showWarningMessage('Kilo Variant Companion: could not safely complete rollback.') })
    return pending
  }))
  await pending
}
