import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Candidate } from './config.js'
import { readConfig } from './file.js'
import { metadataDestination } from './metadata.js'

type Obj = Record<string, unknown>
type Stock = Record<string, Obj>
const npm = '@ai-sdk/openai-compatible'
const synthetic = 'variant-companion-offline'
const loopback = 'http://127.0.0.1:1'
const pin = 'd403391214fbba69bc46c4a920b58535ce3cd7a7d736b344a69cda058a02b3d7'
// Special loaders/overlays not necessarily present in the release's base catalog.
const special = new Set(['apertis', 'anaconda-desktop', 'github-copilot-enterprise', 'github-models', 'lilac', 'kiro', 'kimi-for-coding'])

const record = (v: unknown): v is Obj => !!v && typeof v === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(v))
const only = (v: unknown, keys: string[]): v is Obj => record(v) && Object.keys(v).every(k => keys.includes(k))
const literal = (s: unknown) => typeof s === 'string' && s.length <= 256 && !/[\x00-\x1f\x7f{}$%]/.test(s)
const reserved = new Set(['prototype', 'default', 'provider-default', ...Object.getOwnPropertyNames(Object.prototype)].map(v => v.toLowerCase()))
const safeID = (s: unknown): s is string => typeof s === 'string' && s.length <= 512 &&
  s.split('/').every(v => /^[A-Za-z0-9][A-Za-z0-9_.@~:-]*$/.test(v) && !reserved.has(v.toLowerCase()))

function sanitized({ providerID, modelID, provider, model }: Candidate): Obj | undefined {
  if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(providerID) || !safeID(providerID) || special.has(providerID) ||
      providerID === synthetic || providerID.startsWith('opencode') || !safeID(modelID)) return
  if (!record(provider) || !record(provider.models) || !Object.hasOwn(provider.models, modelID) || provider.models[modelID] !== model ||
      !record(model) || model.reasoning !== true || !metadataDestination(provider, modelID)) return
  for (const v of [provider.whitelist, provider.blacklist]) if (v !== undefined && (!Array.isArray(v) || !v.every(safeID))) return
  if (record(model.variants) && !Object.values(model.variants).every(row => row === null || (record(row) &&
      (row.disabled === undefined || typeof row.disabled === 'boolean')))) return
  const override = model.provider
  if ((provider.npm !== undefined && provider.npm !== npm) || (override !== undefined && (!record(override) ||
      (override.npm !== undefined && override.npm !== npm))) || ((override as Obj | undefined)?.npm ?? provider.npm) !== npm) return
  if ((provider.name !== undefined && !literal(provider.name)) || (model.name !== undefined && !literal(model.name)) ||
      (model.family !== undefined && !literal(model.family)) || (model.release_date !== undefined &&
      (typeof model.release_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(model.release_date)))) return
  const remote = model.id ?? modelID
  if (!safeID(remote)) return
  const copy: Obj = { id: remote, reasoning: true }
  for (const key of ['temperature', 'attachment', 'tool_call']) {
    if (model[key] === undefined) continue
    if (typeof model[key] !== 'boolean') return
    copy[key] = model[key]
  }
  for (const key of ['family', 'release_date', 'status']) if (model[key] !== undefined) copy[key] = model[key]
  for (const [key, required, optional] of [['limit', ['context', 'output'], ['input']], ['cost', ['input', 'output'], ['cache_read', 'cache_write']]] as const) {
    const value = model[key]
    if (value === undefined) continue
    if (!only(value, [...required, ...optional]) || !required.every(k => Object.hasOwn(value, k)) || !Object.values(value).every(n =>
      typeof n === 'number' && Number.isFinite(n) && n >= 0 && (key === 'cost' || Number.isSafeInteger(n)))) return
    copy[key] = { ...value }
  }
  if (model.modalities !== undefined) {
    if (!only(model.modalities, ['input', 'output']) || !Object.values(model.modalities).every(v => Array.isArray(v) &&
      v.length <= 5 && new Set(v).size === v.length && v.every(i => ['text', 'audio', 'image', 'video', 'pdf'].includes(i)))) return
    copy.modalities = model.modalities
  }
  // Never serialize the real provider (or model): no URLs, keys, display names,
  // options, env, variants, headers, plugins, paths or other configured models.
  return copy
}

function localPath(s: string) {
  return /^[a-z]:\\/i.test(s) && path.resolve(s) === s && !/[\x00-\x1f:*?"<>|]/.test(s.slice(2)) &&
    !s.split('\\').some(v => /[. ]$/.test(v) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(v))
}

async function binary(extensionPath: string, signal: AbortSignal) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !localPath(extensionPath) ||
      path.basename(extensionPath).toLowerCase() !== 'kilocode.kilo-code-7.8.32-win32-x64') return
  const manifest: unknown = JSON.parse((await readConfig(path.join(extensionPath, 'package.json'))) ?? 'null')
  if (!record(manifest) || manifest.name !== 'kilo-code' || manifest.publisher !== 'kilocode' || manifest.version !== '7.8.32' ||
      !record(manifest.__metadata) || manifest.__metadata.targetPlatform !== 'win32-x64') return
  const file = path.join(extensionPath, 'bin', 'kilo.exe')
  if (file !== await realpath(file)) return
  const stat = await lstat(file)
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== 272251224) return
  const digest = createHash('sha256')
  // Data scan, never load/eval the bundle. For this exact hash this pattern covers
  // all 324 top-level keys of KILO_MODELS_DEV (checked against its object literals).
  const catalog = new Set<string>(), decoder = new StringDecoder('utf16le')
  let tail = ''
  for await (const bytes of createReadStream(file, { signal, highWaterMark: 1024 * 1024 })) {
    digest.update(bytes)
    const text = tail + decoder.write(bytes)
    for (const m of text.matchAll(/[{,]"?([\w.-]{1,128})"?:\{id:"\1",env:\[/g)) catalog.add(m[1])
    if (catalog.size > 324) return
    tail = text.slice(-512)
  }
  if (catalog.size === 324 && digest.digest('hex') === pin) return { file, catalog }
}

function stock(v: unknown): v is Stock {
  if (!record(v)) return false
  // The compatible adapter emits flat effort rows, or MiniMax M3's two thinking
  // objects. Unknown option names/values are NOT evidence, even in CLI output.
  return Object.entries(v).every(([k, row]) =>
    (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(k) && only(row, ['reasoningEffort']) && row.reasoningEffort === k) ||
    (['none', 'thinking'].includes(k) && only(row, ['thinking']) && only(row.thinking, ['type']) &&
      row.thinking.type === (k === 'none' ? 'disabled' : 'adaptive')))
}

// Boundary for the CLI's framed stdout. No arbitrary options escape this parser.
export function parseStockOutput(text: string, models: ReadonlyMap<string, Obj>) {
  if (text.length > 2 * 1024 * 1024 || !models.size) return
  const result = new Map<string, Stock>()
  const lines = text.replaceAll('\r\n', '\n').trimEnd().split('\n')
  for (let i = 0; i < lines.length;) {
    const header = lines[i++]
    const id = header.slice(synthetic.length + 1)
    if (header !== `${synthetic}/${id}` || !models.has(id) || result.has(id) || lines[i] !== '{') return
    const start = i
    while (i < lines.length && lines[i] !== '}') i++
    if (i >= lines.length || i - start > 256) return
    const json = lines.slice(start, ++i).join('\n')
    let m: unknown
    // Kilo uses JSON.stringify(model, null, 2); reject duplicates, truncated or noncanonical frames.
    try { m = JSON.parse(json); if (JSON.stringify(m, null, 2) !== json) return } catch { return }
    if (!record(m) || m.id !== id || m.providerID !== synthetic || !record(m.api) ||
        m.api.id !== models.get(id)!.id || m.api.npm !== npm || m.api.url !== loopback || !record(m.capabilities) ||
        m.capabilities.reasoning !== true || !stock(m.variants)) return
    result.set(id, m.variants)
  }
  if (result.size === models.size) return result
}

async function run(file: string, models: Map<string, Obj>, signal: AbortSignal) {
  const tmp = tmpdir()
  if (!localPath(tmp) || await realpath(tmp) !== tmp || signal.aborted) return
  const root = await mkdtemp(path.join(tmp, 'kvc-stock-'))
  const dir = (s: string) => path.join(root, s)
  try {
    await Promise.all(['home', 'work', 'managed', 'tmp', 'config', 'cache', 'data', 'state'].map(d => mkdir(dir(d))))
    // An empty catalog would run Kilo's separate Apertis catalog fetch. Supplying
    // its inert entry AND disabling both overlays prevents any provider discovery.
    await writeFile(dir('catalog.json'), JSON.stringify({ apertis: { id: 'apertis', name: 'Offline', env: [], models: {} } }))
    await writeFile(dir('stock.json'), JSON.stringify({ enabled_providers: [synthetic], disabled_providers: ['anaconda-desktop', 'apertis', 'kilo'],
      autoupdate: false, snapshot: false, share: 'disabled', provider: { [synthetic]: {
        npm, api: loopback, options: { baseURL: loopback }, models: Object.fromEntries(models),
      } } }))
    const windows = process.env.SystemRoot
    if (!windows || !/^[a-z]:\\Windows$/i.test(windows) || (await realpath(windows)).toLowerCase() !== windows.toLowerCase()) return
    const env: NodeJS.ProcessEnv = {
      HOME: dir('home'), USERPROFILE: dir('home'), HOMEDRIVE: root.slice(0, 2), HOMEPATH: dir('home').slice(2),
      APPDATA: dir('config'), LOCALAPPDATA: dir('data'), ProgramData: dir('managed'), TMP: dir('tmp'), TEMP: dir('tmp'), TMPDIR: dir('tmp'),
      XDG_CONFIG_HOME: dir('config'), XDG_CACHE_HOME: dir('cache'), XDG_DATA_HOME: dir('data'), XDG_STATE_HOME: dir('state'),
      KILO_TEST_HOME: dir('home'), KILO_TEST_MANAGED_CONFIG_DIR: dir('managed'), KILO_CONFIG: dir('stock.json'), KILO_MODELS_PATH: dir('catalog.json'),
      // No inherited PATH, CLI override, KILO_CONFIG*, node/bun preload, proxy or credentials. Explicit Windows essentials.
      SystemRoot: windows, windir: windows, SystemDrive: windows.slice(0, 2), ComSpec: path.join(windows, 'System32', 'cmd.exe'),
      PATH: dir('work'), PATHEXT: '.EXE', NODE_V8_COVERAGE: '', NODE_OPTIONS: '',
      // Prevent libuv's Windows spawn defaults from restoring real user/profile values.
      USERDOMAIN: 'offline', USERNAME: 'offline', LOGONSERVER: 'offline', USERDNSDOMAIN: 'offline', ALLUSERSPROFILE: dir('managed'),
      CI: 'true', NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root, KILO_PLATFORM: 'vscode', KILO_PURE: 'true',
      KILO_DISABLE_DEFAULT_PLUGINS: 'true', KILO_DISABLE_PROJECT_CONFIG: 'true', KILO_DISABLE_MODELS_FETCH: 'true',
      KILO_DISABLE_AUTOUPDATE: 'true', KILO_DISABLE_LSP_DOWNLOAD: 'true', KILO_DISABLE_EXTERNAL_SKILLS: 'true',
      KILO_DISABLE_CLAUDE_CODE: 'true', KILO_DISABLE_SHARE: 'true', KILO_DISABLE_FFF: 'true', KILO_EXPERIMENTAL_DISABLE_FILEWATCHER: 'true',
      KILO_TELEMETRY_LEVEL: 'off', DO_NOT_TRACK: '1', KILO_MODELS_URL: loopback, KILO_API_URL: loopback, KILO_AI_GATEWAY_URL: loopback,
      HTTP_PROXY: loopback, HTTPS_PROXY: loopback, ALL_PROXY: loopback, NO_PROXY: '', NPM_CONFIG_REGISTRY: loopback, NPM_CONFIG_OFFLINE: 'true',
    }
    signal.throwIfAborted()
    // Wait for 'close' even on AbortError before removing temp (Windows file handles).
    const text = await new Promise<string>((resolve, reject) => {
      const child = execFile(file, ['models', synthetic, '--verbose', '--pure'], { cwd: dir('work'), env, shell: false, windowsHide: true,
        killSignal: 'SIGKILL', timeout: 10000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => err ? reject(err) : resolve(stdout))
      const stop = () => { child.kill('SIGKILL') }
      signal.addEventListener('abort', stop, { once: true })
      child.once('close', () => signal.removeEventListener('abort', stop))
      child.stdin?.end()
      if (signal.aborted) stop()
    })
    if (!signal.aborted) return parseStockOutput(text, models)
  } finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}

/** Call only for candidates with a pending write. Keys are JSON.stringify([providerID,modelID]); absence means unknown.
 * extensionPath must come from VS Code's local installed kilocode.kilo-code registry entry. No PATH fallback, package imports
 * from the extension, real profile, workspace, auth, requests or live catalog. This is isolation by configuration of the
 * audited binary, NOT an OS network sandbox. Other binaries, platforms and non-custom/layered transports are unsupported. */
export async function readStock(extensionPath: string, candidates: Candidate[], signal: AbortSignal): Promise<Map<string, Stock>> {
  const result = new Map<string, Stock>()
  if (signal.aborted || !candidates.length || candidates.length > 256 ||
      ['KILO_MODELS_PATH', 'KILO_MODELS_URL'].some(key => Object.hasOwn(process.env, key))) return result
  try {
    const groups = new Map<string, Candidate[]>()
    for (const c of candidates) groups.set(c.providerID, [...(groups.get(c.providerID) ?? []), c])
    let cli: Awaited<ReturnType<typeof binary>>
    for (const [id, group] of groups) {
      if (signal.aborted) return new Map()
      if (new Set(group.map(c => c.modelID)).size !== group.length || !group.every(c => c.provider === group[0].provider)) continue
      const models = new Map<string, Obj>()
      for (const c of group) { const value = sanitized(c); if (value) models.set(c.modelID, value) }
      if (!models.size) continue
      cli ??= await binary(extensionPath, signal)
      if (!cli) break
      if (cli.catalog.has(id)) continue
      const stock = await run(cli.file, models, signal).catch(() => undefined)
      if (stock) for (const [model, value] of stock) result.set(JSON.stringify([id, model]), value)
    }
  } catch { /* No partial approximation, retries or logging of config/CLI output. */ return new Map() }
  return signal.aborted ? new Map() : result
}
