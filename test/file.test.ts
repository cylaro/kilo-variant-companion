import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import * as fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test, { type TestContext } from "node:test"
import { readConfig, replaceConfig } from "../src/file.js"
import { analyzeConfig, applyVariants, reconcileOwnership } from "../src/config.js"

const win = process.platform === "win32"
async function fixture(t: TestContext) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "kilo-file-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = path.join(root, "config")
  const state = path.join(root, "state")
  for (const [key, value] of Object.entries({ XDG_CONFIG_HOME: config, XDG_STATE_HOME: state, XDG_DATA_HOME: path.join(root, "data") })) {
    const prev = process.env[key]
    process.env[key] = value
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev })
  }
  const dir = path.join(config, "kilo")
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const locks = path.join(state, "kilo", "locks")
  const key = createHash("sha1").update(`config:global:${dir}`).digest("hex") + ".lock"
  return { root, dir, file: path.join(dir, "kilo.jsonc"), locks, lock: path.join(locks, key) }
}

test("bounded strict UTF-8, exact CRLF/BOM and missing paths", async t => {
  const { file } = await fixture(t)
  assert.equal(await readConfig(file), undefined)
  assert.equal(await readConfig(path.join(file, "nested")), undefined)
  const original = "\uFEFF{\r\n}\r\n"
  await fs.writeFile(file, original, { mode: 0o600 })
  assert.equal(await readConfig(file), original)
  const limit = 2 * 1024 * 1024
  await fs.writeFile(file, Buffer.alloc(limit, 65))
  assert.equal((await readConfig(file))?.length, limit)
  await fs.appendFile(file, "!")
  await assert.rejects(readConfig(file))
  await fs.writeFile(file, Buffer.from([0xc0, 0xaf]))
  await assert.rejects(readConfig(file))
  await assert.rejects(replaceConfig(file, "", "\ud800", () => assert.fail("invalid text")))
  await assert.rejects(replaceConfig(file, "", "a".repeat(limit + 1), () => assert.fail("oversize")))
})

test("rejects ambiguous names, linked parents, hardlinks and non-files", async t => {
  const { root, dir, file } = await fixture(t)
  await fs.writeFile(file, "original", { mode: 0o600 })
  await assert.rejects(readConfig(dir))
  await assert.rejects(readConfig(`${dir}${path.sep}..${path.sep}kilo${path.sep}kilo.jsonc`))
  if (win) await assert.rejects(readConfig(`${file}:stream`))
  const alias = path.join(root, "alias")
  await fs.symlink(dir, alias, win ? "junction" : "dir")
  await assert.rejects(readConfig(path.join(alias, "kilo.jsonc")))
  await assert.rejects(readConfig(path.join(alias, "absent")))
  if (!win) {
    const link = path.join(root, "linked-file")
    await fs.symlink(file, link)
    await assert.rejects(readConfig(link))
    await assert.rejects(replaceConfig(link, "original", "changed", () => assert.fail("symlink")))
  }
  await fs.link(file, path.join(root, "hardlink"))
  await assert.rejects(readConfig(file))
  await assert.rejects(replaceConfig(file, "original", "changed", () => assert.fail("hardlink")))
  assert.equal(await fs.readFile(file, "utf8"), "original")
})

test("one mutex attempt; even stale foreign lock remains untouched", async t => {
  const { file, lock } = await fixture(t)
  await fs.writeFile(file, "old", { mode: 0o600 })
  await fs.mkdir(lock, { recursive: true, mode: 0o700 })
  const marker = path.join(lock, "meta.json")
  await fs.writeFile(marker, "foreign")
  const old = new Date(0)
  await fs.utimes(marker, old, old)
  await fs.utimes(lock, old, old)
  assert.equal(await replaceConfig(file, "old", "new", () => assert.fail("occupied")), false)
  assert.equal(await fs.readFile(marker, "utf8"), "foreign")
  assert.deepEqual(await fs.readdir(path.dirname(lock)), [path.basename(lock)])
  assert.equal(await readConfig(file), "old")
})

test("save callback observes tagged lock, matches exact bytes, verifies result, releases on error", async t => {
  const { file, dir, locks, lock } = await fixture(t)
  assert.equal(await replaceConfig(file, "old", "new", () => assert.fail("missing file")), false)
  await fs.writeFile(file, "old", { mode: 0o600 })
  assert.equal(await replaceConfig(file, "other", "new", () => assert.fail("mismatch")), false)
  assert.equal(await replaceConfig(file, "old", "new", async () => {
    const meta = JSON.parse(await fs.readFile(path.join(lock, "meta.json"), "utf8"))
    assert.equal(typeof meta.token, "string")
    assert.equal(meta.pid, process.pid)
    assert.equal(await replaceConfig(file, "old", "second", () => assert.fail("lock not exclusive")), false)
    await fs.writeFile(file, "new")
    return true
  }), true)
  assert.equal(await replaceConfig(file, "new", "nomatch", async () => true), false)
  await assert.rejects(replaceConfig(file, "new", "no", async () => { throw new Error("edit rejected") }), /edit rejected/)
  assert.deepEqual(await fs.readdir(locks), [])
  assert.deepEqual(await fs.readdir(dir), [path.basename(file)])
})

test("an unrelated edit after editor save preserves only exact companion-owned rows", async t => {
  const { file } = await fixture(t)
  const before = '{"provider":{"fixture":{"models":{"test":{}}}}}'
  const candidate = analyzeConfig(before, analyzeConfig('{}')!.snapshot)!.candidates[0]
  const patch = applyVariants(before, candidate, { low: { reasoningEffort: 'low' } })
  assert.equal(patch.ownership.length, 1)
  const survives = (actual: string) => !!analyzeConfig(actual) && reconcileOwnership(actual, patch.ownership).ownership.length === 1
  for (const [after, expected] of [
    [patch.text.replace('"provider"', '"theme":"dark","provider"'), true],
    [patch.text.replace('"reasoningEffort":"low"', '"reasoningEffort":"high"'), false],
    ['{}', false],
  ] as const) {
    await fs.writeFile(file, before)
    const verified = await replaceConfig(file, before, patch.text, async () => {
      await fs.writeFile(file, after)
      return true
    }, survives)
    assert.equal(verified, expected)
    assert.equal(await readConfig(file), after)
  }
})

test("does not release a lock with altered ownership", async t => {
  const { file, lock } = await fixture(t)
  const marker = path.join(lock, "meta.json")
  await fs.writeFile(file, "old", { mode: 0o600 })
  await assert.rejects(replaceConfig(file, "old", "new", async () => {
    await fs.writeFile(marker, "new-owner")
    return false
  }))
  assert.equal(await fs.readFile(marker, "utf8"), "new-owner")
})

test("rejects reparenting during save even when replacement bytes match", async t => {
  const { file, dir } = await fixture(t)
  await fs.writeFile(file, "old", { mode: 0o600 })
  await assert.rejects(replaceConfig(file, "old", "new", async () => {
    await fs.rename(dir, dir + "-saved")
    await fs.mkdir(dir, { mode: 0o700 })
    await fs.writeFile(file, "new", { mode: 0o600 })
    return true
  }))
})

test("refuses a redirected state parent before creating the mutex", async t => {
  const { file, root } = await fixture(t)
  const dest = path.join(root, "other")
  await fs.mkdir(dest, { mode: 0o700 })
  await fs.symlink(dest, process.env.XDG_STATE_HOME!, win ? "junction" : "dir")
  await fs.writeFile(file, "old", { mode: 0o600 })
  await assert.rejects(replaceConfig(file, "old", "new", () => assert.fail("redirected")))
  assert.deepEqual(await fs.readdir(dest), [])
})

test("uses existing sticky data/state, declining ambiguous state roots", async t => {
  const { file, root, lock } = await fixture(t)
  const home = path.join(root, "home")
  for (const key of ["USERPROFILE", "HOME"]) {
    const prev = process.env[key]
    process.env[key] = home
    t.after(() => { if (prev === undefined) delete process.env[key]; else process.env[key] = prev })
  }
  // Never exercise host real state, even on a runtime that caches homedir().
  assert.equal(os.homedir(), home)
  delete process.env.XDG_STATE_HOME
  const fallback = path.join(root, "data", "kilo", "state")
  const preferred = path.join(home, ".local", "state", "kilo")
  await fs.mkdir(fallback, { recursive: true, mode: 0o700 })
  await fs.writeFile(file, "old", { mode: 0o600 })
  const meta = path.join(fallback, "locks", path.basename(lock), "meta.json")
  assert.equal(await replaceConfig(file, "old", "new", async () => {
    assert.equal(JSON.parse(await fs.readFile(meta, "utf8")).pid, process.pid)
    await fs.writeFile(file, "new")
    return true
  }), true)
  await fs.mkdir(preferred, { recursive: true, mode: 0o700 })
  assert.equal(await replaceConfig(file, "new", "unsafe", () => assert.fail("ambiguous roots")), false)
  assert.deepEqual(await fs.readdir(preferred), [])
})
