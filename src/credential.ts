import { homedir } from 'node:os'
import path from 'node:path'
import { visit } from 'jsonc-parser'
import { readConfig } from './file.js'

// v7.8.27: core/src/{global,credential}.ts and opencode/src/auth/index.ts.
// Only compute the path here: watchers can use it without opening any store.
export function authFile(): string | undefined {
  if (Object.hasOwn(process.env, 'KILO_AUTH_CONTENT') || Object.hasOwn(process.env, 'KILO_DB')) return
  const xdg = process.env.XDG_DATA_HOME
  const root = xdg ?? homedir()
  // Don't let join() silently collapse a relative path or a linked component/.. .
  if (!root || !path.isAbsolute(root) || path.resolve(root) !== root || /[\x00-\x1f]/.test(root)) return
  if (process.platform === 'win32' && !/^[a-z]:\\$/i.test(path.parse(root).root)) return
  return path.join(root, ...(xdg === undefined ? ['.local', 'share'] : []), 'kilo', 'auth.json')
}

// Scan the single JSON document without building a credential map. Property names
// are needed to reject duplicates; only the two requested literal fields survive.
function lookup(text: string, id: string) {
  const stack: (Set<string> | null)[] = []
  let selected = false
  let field = ''
  let api = false
  let key: string | undefined
  function invalid(): never { throw new Error('Unsupported auth file') }
  visit(text, {
    onObjectBegin(_o, _l, _ln, _c, location) {
      if (selected || stack.length > 64) invalid()
      selected = stack.length === 1 && location()[0] === id
      stack.push(new Set())
    },
    onObjectEnd() { stack.pop(); selected = false },
    onArrayBegin() {
      if (!stack.length || selected || stack.length > 64) invalid()
      stack.push(null)
    },
    onArrayEnd() { stack.pop() },
    onObjectProperty(name) {
      // Kilo normalizes trailing slashes when reconciling legacy provider IDs.
      if (stack.length === 1 && name.startsWith(id + '/') && /^\/+$/u.test(name.slice(id.length))) invalid()
      const seen = stack.at(-1)!
      if (seen.has(name)) invalid()
      seen.add(name)
      if (!selected) return
      if (name !== 'type' && name !== 'key') invalid()
      field = name
    },
    onLiteralValue(value: unknown) {
      if (!selected) return
      if (field === 'type') api = value === 'api'
      if (field === 'key' && typeof value === 'string' && value.length > 0 && value.length <= 4096 &&
          !/[^!-~]|[{}$%]|^\*+$/.test(value) && value !== 'kilo-oauth-dummy-key') key = value
    },
    onError: invalid,
  }, { disallowComments: true, allowTrailingComma: false })
  return api ? key : undefined
}

/** Caller must first establish the custom provider and approve its full destination.
 * No secret cache, alternate credential source, retry, logging or network I/O. */
export async function storedKey(id: string): Promise<string | undefined> {
  if (typeof id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(id) ||
      id === 'kilo' || id === 'prototype' || Object.hasOwn(Object.prototype, id)) return
  try {
    const file = authFile()
    if (!file) return
    const text = await readConfig(file)
    if (text !== undefined && file === authFile()) return lookup(text, id)
  } catch { /* Unsafe path, unstable read or invalid JSON: no credential. */ }
  return undefined
}
