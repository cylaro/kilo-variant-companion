import { createHash, randomUUID } from "node:crypto"
import { constants as F, type BigIntStats } from "node:fs"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const limit = 2 * 1024 * 1024
const win = process.platform === "win32"
const stat = (name: string) => fs.lstat(name, { bigint: true })
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino !== 0n && a.ino === b.ino
const unchanged = (a: BigIntStats, b: BigIntStats) => same(a, b) && a.ctimeNs === b.ctimeNs && a.size === b.size
const code = (e: unknown, value: string) => (e as NodeJS.ErrnoException | null)?.code === value
function unsafe(): never { throw new Error("Unsafe or changing local config path") }

function components(name: string) {
  // Reject rather than normalize aliases, ADS, UNC/device names or '..' through a link.
  if (!path.isAbsolute(name) || path.resolve(name) !== name || /[\x00-\x1f]/.test(name)) unsafe()
  const { root } = path.parse(name)
  if (win && !/^[a-z]:\\$/i.test(root)) unsafe()
  const parts = name.slice(root.length).split(path.sep).filter(Boolean)
  if (win && parts.some(p => /[:*?"<>|]|[. ]$/.test(p) || /^(con(in\$|out\$)?|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(p))) unsafe()
  const result = [root]
  for (const part of parts) result.push(path.join(result[result.length - 1], part))
  return result
}

type Entry = { name: string; info: BigIntStats }
async function checkDirs(chain: Entry[]) {
  for (const { name, info } of chain) {
    if (!same(await stat(name), info)) unsafe()
  }
}

async function directories(dir: string, create = false): Promise<Entry[] | undefined> {
  const chain: Entry[] = []
  for (const name of components(dir)) {
    let info: BigIntStats
    try { info = await stat(name) } catch (e) {
      if (!code(e, "ENOENT")) throw e
      await checkDirs(chain)
      if (!create) return undefined
      try { await fs.mkdir(name, { mode: 0o700 }) } catch (err) { if (!code(err, "EEXIST")) throw err }
      info = await stat(name)
    }
    if (!info.isDirectory() || info.isSymbolicLink() || !info.ino) unsafe()
    if (!win) {
      const uid = BigInt(process.getuid!())
      if (info.uid !== 0n && info.uid !== uid) unsafe()
      // A root-owned sticky /tmp may contain a user's private fixture directory.
      if ((info.mode & 0o022n) && !(info.mode & 0o1000n)) unsafe()
    }
    chain.push({ name, info })
  }
  // Includes junctions and redirections the filesystem can canonicalize. Node
  // does not expose every Windows reparse tag (e.g. opaque cloud filters).
  if ((await fs.realpath(dir)) !== dir) unsafe()
  await checkDirs(chain)
  return chain
}

function regular(info: BigIntStats) {
  if (!info.isFile() || !info.ino || info.nlink !== 1n || info.size > limit || info.size < 0n) unsafe()
  if (!win && (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o022n))) unsafe()
}

async function snapshot(file: string) {
  components(file)
  const dirs = await directories(path.dirname(file))
  if (!dirs) return undefined
  let info: BigIntStats
  try { info = await stat(file) } catch (e) {
    if (!code(e, "ENOENT")) throw e
    await checkDirs(dirs)
    return undefined
  }
  regular(info)
  if ((await fs.realpath(file)) !== file) unsafe()
  // O_NONBLOCK avoids hanging on a substituted FIFO on POSIX. No truncation.
  const fd = await fs.open(file, F.O_RDONLY | (F.O_NOFOLLOW ?? 0) | (F.O_NONBLOCK ?? 0))
  try {
    if (!unchanged(info, await fd.stat({ bigint: true }))) unsafe()
    const bytes = Buffer.alloc(Number(info.size))
    let pos = 0
    while (pos < bytes.length) {
      const { bytesRead } = await fd.read(bytes, pos, bytes.length - pos, pos)
      if (!bytesRead) unsafe()
      pos += bytesRead
    }
    if (!unchanged(info, await fd.stat({ bigint: true })) || !unchanged(info, await stat(file))) unsafe()
    await checkDirs(dirs)
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), info, dirs }
  } finally { await fd.close() }
}

/** Exact UTF-8 text (including BOM); undefined only for a missing path. */
export async function readConfig(file: string): Promise<string | undefined> {
  return (await snapshot(file))?.text
}

// v7.8.27 core/global.ts + kilocode/global.ts. Kilo caches the state root at
// startup. Without an explicit override, never create a root or guess between
// two existing roots: the running instance could be using either one.
function xdg(variable: string, fallback: string) {
  const dir = (process.env[variable] || path.join(os.homedir(), fallback)).replace(/[\r\n]/g, "")
  components(dir)
  return dir
}

async function lockRoot() {
  const preferred = path.join(xdg("XDG_STATE_HOME", ".local/state"), "kilo")
  if (process.env.XDG_STATE_HOME) return path.join(preferred, "locks")
  const fallback = path.join(xdg("XDG_DATA_HOME", ".local/share"), "kilo", "state")
  const [a, b] = await Promise.all([directories(preferred), directories(fallback)])
  if (Boolean(a) === Boolean(b)) return undefined
  return path.join(a ? preferred : fallback, "locks")
}

async function lock() {
  const root = await lockRoot()
  if (!root) return undefined
  const parents = (await directories(root, true))!
  const config = path.resolve(xdg("XDG_CONFIG_HOME", ".config"), "kilo")
  const hash = createHash("sha1").update("config:global:" + config).digest("hex")
  const dir = path.join(root, hash + ".lock")
  const start = performance.now()
  try { await fs.mkdir(dir, { mode: 0o700 }) } catch (e) { if (code(e, "EEXIST")) return undefined; throw e }
  const info = await stat(dir)
  if (!info.isDirectory()) unsafe()
  const chain = [...parents, { name: dir, info }]
  await checkDirs(chain)
  // EffectFlock uses meta mtime (or directory mtime) when no heartbeat exists.
  // No timer, waiting, stale breaking or recursive removal. Failure to prove
  // ownership leaves recovery to Kilo's own stale-lock protocol.
  const meta = path.join(dir, "meta.json")
  const contents = JSON.stringify({ token: randomUUID(), pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() })
  const fd = await fs.open(meta, "wx+", 0o600)
  try { await fd.writeFile(contents) } catch (err) { await fd.close(); throw err }
  const verify = async () => {
    await checkDirs(chain)
    const current = await stat(meta)
    if (!current.isFile() || current.nlink !== 1n || current.size !== BigInt(Buffer.byteLength(contents)) || !same(current, await fd.stat({ bigint: true }))) unsafe()
    const bytes = Buffer.alloc(Number(current.size))
    if ((await fd.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length || bytes.toString() !== contents) unsafe()
    if (performance.now() - start > 30_000 || Date.now() - Number(current.mtimeMs) > 30_000) unsafe()
  }
  return { verify, release: async () => {
    try {
      await verify()
      await fs.unlink(meta)
      await checkDirs(chain)
      await fs.rmdir(dir)
    } finally { await fd.close() }
  } }
}

/** Compare under Kilo's nonblocking global-config lock. Other editors do not
 * honor this lock: pathname checks + rename/editor save are not OS-level CAS.
 * Assumes a local, trusted user directory, not a hostile same-user process.
 * A short host callback must check the editor model version, expected text and
 * dirty state itself. Its normal editor save/backup/ACL semantics apply. A
 * false result or exception after a save needs reconciliation, not a retry. */
export async function replaceConfig(file: string, expected: string, updated: string, save: () => Promise<boolean>, changesSurvived?: (current: string) => boolean): Promise<boolean> {
  if (Buffer.byteLength(updated) > limit || Buffer.from(updated).toString() !== updated) unsafe()
  const before = await snapshot(file)
  if (!before || before.text !== expected) return false
  const lease = await lock()
  if (!lease) return false
  try {
    const current = await snapshot(file)
    await checkDirs(before.dirs)
    if (!current || current.text !== expected || !unchanged(before.info, current.info)) return false
    await lease.verify()
    if (expected === updated) return true
    if (!await save()) return false
    await checkDirs(before.dirs)
    const actual = await readConfig(file)
    return actual === updated || (actual !== undefined && changesSurvived?.(actual) === true)
  } finally { await lease.release() }
}
