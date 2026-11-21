import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'

const posts = 64, grants = 64, generations = 64, writers = 8
let reserving = 0 // Per extension host, no unbounded in-memory wait queue.
const win = process.platform === 'win32'
const hex = (s: unknown): s is string => typeof s === 'string' && s.length === 64 && !/[^a-f0-9]/.test(s)
const field = (s: unknown, limit: number): s is string => typeof s === 'string' && s.length > 0 && s.length <= limit
const hash = (...parts: string[]) => createHash('sha256').update(JSON.stringify(['spend-v1', ...parts])).digest('hex')
const code = (err: unknown, value: string) => (err as NodeJS.ErrnoException | null)?.code === value
function invalid(): never { throw new Error('Invalid local spend ledger or input') }
class Busy extends Error { constructor() { super('Local spend ledger busy') } }

/** Pass the exact validated POST URL and the concrete credential actually used for the POST. */
export function budgetScope(providerID: string, exactEndpoint: string, credential: string): string {
  if (!field(providerID, 512) || !field(exactEndpoint, 4096) || !field(credential, 4096)) invalid()
  return hash('scope', providerID, exactEndpoint, hash('credential', credential))
}

export type BudgetAttempt = { model: string; protocol: string; level: string; context: string; maxOutputTokens: number }
export type Reservation = 'reserved' | 'duplicate' | 'exhausted' | 'stale' | 'invalid' | 'busy'

// The caller supplies ExtensionContext.globalStorageUri.fsPath, never a config/workspace path.
// Trust the user's local filesystem, not a writable share or another user modifying the ledger.
async function directory(dir: string, create = true) {
  if (create) {
    try { await fs.mkdir(dir, { mode: 0o700 }) } catch (e) { if (!code(e, 'EEXIST')) throw e }
  }
  const st = await fs.lstat(dir)
  if (!st.isDirectory() || path.relative(dir, await fs.realpath(dir)) !== '' ||
      (!win && (st.uid !== process.getuid!() || (st.mode & 0o022) !== 0))) invalid()
}

// Node cannot portably open/fsync directory handles on Windows. File data is flushed
// there too; process crashes are covered, not OS/power loss or filesystem rollback.
async function syncDir(dir: string) {
  if (win) return
  const fd = await fs.open(dir, 'r')
  try { await fd.sync() } finally { await fd.close() }
}

/** Append only. No timers, lock stealing, mutable counter, grants on inspect, or network I/O. */
export class Budget {
  private readonly root: string
  private readonly revocations: string
  private hierarchySynced = false
  constructor(private readonly storage: string) {
    const volume = path.parse(storage).root
    if (!path.isAbsolute(storage) || storage === volume || path.resolve(storage) !== storage ||
        /[\x00-\x1f]/.test(storage) || (win && (!/^[a-z]:\\$/i.test(volume) || /[:*?"<>|]|[. ](?:\\|$)/.test(storage.slice(volume.length))))) invalid()
    this.root = path.join(storage, 'spend-v1')
    this.revocations = path.join(this.root, 'revoked')
  }

  private async setup() {
    // Never create an ancestor outside globalStorageUri. Reject a linked parent before mkdir.
    const parent = path.dirname(this.storage)
    if (path.relative(parent, await fs.realpath(parent)) !== '') invalid()
    await directory(this.storage)
    await directory(this.root)
    // Another host may have created either directory but crashed before syncing its parent.
    if (!this.hierarchySynced) {
      await syncDir(this.storage)
      await syncDir(parent)
      this.hierarchySynced = true
    }
  }

  private async read(name: string): Promise<string | undefined> {
    const file = path.join(this.root, name)
    let st
    try { st = await fs.lstat(file) } catch (e) { if (code(e, 'ENOENT')) return; throw e }
    if (!st.isFile() || st.size !== 129 || st.nlink > 2 || (!win && (st.uid !== process.getuid!() || (st.mode & 0o022)))) invalid()
    const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const buf = Buffer.alloc(129)
      if ((await fd.read(buf, 0, buf.length, 0)).bytesRead !== buf.length) invalid()
      const value = buf.toString('latin1', 0, 64)
      if (!hex(value) || buf.toString('latin1', 64) !== ':' + hash('record', name, value)) invalid()
      return value
    } finally { await fd.close() }
  }

  // link() is an exclusive, atomic publication of an ALREADY complete inode, even on NTFS.
  // A crash leaves either no committed slot or the entire record. Never reclaim another
  // writer's scratch file: up to eight interrupted writers can deny service, not add credit.
  private async publish(name: string, value: string): Promise<boolean> {
    for (let i = 0; i < writers; i++) {
      const tmp = path.join(this.root, 'writer.' + i)
      let fd
      try { fd = await fs.open(tmp, 'wx', 0o600) } catch (e) { if (code(e, 'EEXIST')) continue; throw e }
      try {
        await fd.writeFile(value + ':' + hash('record', name, value))
        await fd.sync()
        try { await fs.link(tmp, path.join(this.root, name)) } catch (e) { if (code(e, 'EEXIST')) return false; throw e }
        await syncDir(this.root)
        return true
      } finally {
        try { await fd.close() } finally { await fs.unlink(tmp) }
      }
    }
    throw new Busy()
  }

  private async generation() {
    let seed = await this.read('seed')
    if (!seed) {
      await directory(this.revocations)
      const candidate = randomBytes(32).toString('hex')
      seed = await this.publish('seed', candidate) ? candidate : await this.read('seed')
      if (!seed) invalid()
    } else await directory(this.revocations, false)
    let count = 0, highest = -1
    for await (const mark of await fs.opendir(this.revocations)) {
      if (++count > generations || !mark.isDirectory() || !/^(0|[1-9][0-9]?)$/.test(mark.name) || String(Number(mark.name)) !== mark.name) invalid()
      highest = Math.max(highest, Number(mark.name))
    }
    if (highest !== count - 1) invalid()
    return { id: hash('generation', seed, String(count)), count }
  }

  // Every writer must inspect the winner of slot N before trying N+1. Thus two windows
  // with the same tuple cannot both win, even if they started with identical stale views.
  private async find(prefix: string, count: number, value?: string, insert = false) {
    // Detect a hole in the append-only prefix before mistaking it for fresh credit.
    // Trust the store not to be deliberately deleted/restored: tail rollback cannot
    // be detected by an offline ledger that lives entirely in that same store.
    let length = 0, highest = -1
    let entries = 0
    for await (const { name } of await fs.opendir(this.root)) {
      if (++entries > 2 + writers + grants * (1 + posts)) invalid()
      if (!name.startsWith(prefix)) continue
      const n = Number(name.slice(prefix.length))
      if (!Number.isSafeInteger(n) || n < 0 || n >= count || name !== prefix + n) invalid()
      highest = Math.max(highest, n); length++
    }
    if (highest !== length - 1) invalid()
    for (let i = 0; i < count; i++) {
      const name = prefix + i
      let found = await this.read(name)
      if (found === undefined) {
        if (i < length) invalid()
        if (!insert || value === undefined) return { i, state: 'free' as const }
        if (await this.publish(name, value)) return { i, state: 'new' as const }
        found = await this.read(name)
        if (found === undefined) invalid()
      }
      if (found === value) return { i, state: 'found' as const }
    }
    return { i: count, state: 'full' as const }
  }

  async checkpoint(): Promise<string> {
    await this.setup()
    return (await this.generation()).id
  }

  async inspect(scope: string): Promise<{ epoch: string; allowed: boolean; remaining: number }> {
    if (!hex(scope)) invalid()
    await this.setup()
    const g = await this.generation()
    const active = hash('grant', scope, g.id)
    const slot = await this.find('grant.', grants, active)
    if (g.count === generations || slot.state === 'full') invalid() // storage ceiling, not a consent prompt
    if (slot.state !== 'found') return { epoch: hash('consent', scope, g.id), allowed: false, remaining: 0 }
    const used = await this.find(`post.${slot.i}.`, posts)
    return { epoch: active, allowed: true, remaining: posts - used.i }
  }

  /** Pass the epoch observed before consent. By default callers may share an existing grant.
   * With onlyNew, only the writer that publishes this grant can receive its epoch. Neither mode refills it. */
  async allow(scope: string, consentEpoch: string, onlyNew = false): Promise<string | undefined> {
    if (!hex(scope) || !hex(consentEpoch)) return
    await this.setup()
    const g = await this.generation()
    if (g.count === generations || hash('consent', scope, g.id) !== consentEpoch) return
    const active = hash('grant', scope, g.id)
    const claim = await this.find('grant.', grants, active, true)
    if (claim.state !== 'new' && (onlyNew || claim.state !== 'found')) return
    if ((await this.generation()).id === g.id) return active
  }

  /** Only 'reserved' licenses ONE immediate send. Never replay a reservation or retry the POST. */
  async reserve(scope: string, epoch: string, a: BudgetAttempt): Promise<Reservation> {
    if (!hex(scope) || !hex(epoch) || !a || !field(a.model, 512) || !field(a.protocol, 128) || !field(a.level, 32) ||
        !field(a.context, 4096) || !Number.isSafeInteger(a.maxOutputTokens) || a.maxOutputTokens < 1 || a.maxOutputTokens > 16) return 'invalid'
    const attempt = hash('attempt', epoch, a.model, a.protocol, a.level, a.context)
    if (reserving >= writers) return 'busy'
    reserving++
    try {
      await this.setup()
      const g = await this.generation()
      if (g.count === generations || hash('grant', scope, g.id) !== epoch) return 'stale'
      const grant = await this.find('grant.', grants, epoch)
      if (grant.state !== 'found') return 'stale'
      const slot = await this.find(`post.${grant.i}.`, posts, attempt, true)
      if (slot.state !== 'new') return slot.state === 'found' ? 'duplicate' : 'exhausted'
      // Revoke during publication burns the slot without authorizing a send. A revoke
      // AFTER this final check cannot recall an already authorized/in-flight POST.
      return (await this.generation()).id === g.id ? 'reserved' : 'stale'
    } catch (e) { if (e instanceof Busy) return 'busy'; throw e }
    finally { reserving-- }
  }

  async revokeAll(): Promise<void> {
    await this.setup()
    const g = await this.generation()
    if (g.count < generations) {
      try { await fs.mkdir(path.join(this.revocations, String(g.count)), { mode: 0o700 }) }
      catch (e) { if (!code(e, 'EEXIST')) throw e }
    }
    await syncDir(this.revocations)
    await syncDir(this.root)
  }
}
