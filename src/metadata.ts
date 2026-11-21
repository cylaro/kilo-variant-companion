import { get as httpGet, request as httpPost, type IncomingMessage } from "node:http"
import { get as httpsGet, request as httpsPost } from "node:https"
import { visit } from "jsonc-parser"

type Json = Record<string, unknown>
type Variants = Record<string, Record<string, string>>
const routes = new Map([
  ["@ai-sdk/openai-compatible", "/chat/completions"],
  ["@ai-sdk/openai", "/responses"],
  ["@ai-sdk/anthropic", "/messages"],
])
const reserved = new Set(["default", "provider-default", "prototype", ...Object.getOwnPropertyNames(Object.prototype)].map(s => s.toLowerCase()))
const maxBytes = 4 * 1024 * 1024
const maxCandidates = 64
export const maxMetadataConcurrency = 16

function record(v: unknown): v is Json {
  return !!v && typeof v === "object" && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
}

function only(v: unknown, fields: string[]): v is Json {
  return record(v) && Object.keys(v).every(key => fields.includes(key))
}

function safeKey(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 4096 && !/[^!-~]|[{}$%]|^\*+$/.test(v)
}

function base(v: unknown) {
  // Require an unambiguous literal authority and path. Don't normalize away userinfo,
  // substitutions, encoded delimiters, dot segments, a query or a fragment.
  if (typeof v !== "string" || v.length > 2048 || !/^https?:\/\/(?:[\w.-]+|\[::1\])(?::[0-9]+)?(?:\/[\w.~-]+)*\/?$/.test(v)) return
  if (v.split("/").some(s => s === "." || s === "..")) return
  try {
    const u = new URL(v)
    if (u.protocol !== "https:" && !["127.0.0.1", "[::1]"].includes(u.hostname)) return
    return u.href.replace(/\/$/, "")
  } catch { return }
}

function validID(id: unknown): id is string {
  return typeof id === "string" && id.length <= 512 && /^[\w.:@~-]+(?:\/[\w.:@~-]+)*$/.test(id) &&
    !id.split("/").some(part => part === "." || part === ".." || reserved.has(part.toLowerCase()))
}

function validLevel(v: unknown): v is string {
  return typeof v === "string" && /^[a-z][a-z0-9_-]{0,31}$/i.test(v) && !reserved.has(v.toLowerCase())
}

function request(p: Json, id: string) {
  if (!only(p, ["name", "npm", "api", "options", "models", "env", "whitelist", "blacklist"]) || !validID(id)) return
  if (p.env !== undefined && !(Array.isArray(p.env) && p.env.length <= 1 && p.env.every(v => typeof v === "string" && /^[A-Z_][A-Z0-9_]*$/.test(v)))) return
  if (p.whitelist !== undefined && !(Array.isArray(p.whitelist) && p.whitelist.includes(id))) return
  if (p.blacklist !== undefined && (!Array.isArray(p.blacklist) || p.blacklist.includes(id))) return
  const opts = p.options
  if (!only(opts, ["baseURL", "apiKey", "headers", "timeout"])) return
  if (opts.headers !== undefined && !only(opts.headers, [])) return
  if (opts.apiKey !== undefined && !safeKey(opts.apiKey)) return
  const timeout = opts.timeout
  if (timeout !== undefined && timeout !== false && !(typeof timeout === "number" && Number.isSafeInteger(timeout) && timeout > 0)) return
  const root = base(opts.baseURL)
  if (!root || (p.api !== undefined && base(p.api) !== root)) return

  if (!record(p.models) || !Object.hasOwn(p.models, id)) return
  const m = p.models[id]
  if (!only(m, ["id", "name", "family", "release_date", "attachment", "reasoning", "temperature", "tool_call", "cost", "limit", "modalities", "status", "provider", "options", "headers", "variants"])) return
  if (m.reasoning !== undefined && m.reasoning !== null && m.reasoning !== true) return
  if (m.status !== undefined && m.status !== "active" && m.status !== "beta") return
  if (m.headers !== undefined && !only(m.headers, [])) return
  if (m.options !== undefined && !only(m.options, [])) return
  if (m.variants !== undefined && !record(m.variants)) return
  const override = m.provider
  if (override !== undefined && (!only(override, ["api", "npm"]) || (override.api !== undefined && base(override.api) !== root))) return
  if (p.npm !== undefined && (typeof p.npm !== "string" || !routes.has(p.npm))) return
  if (override?.npm !== undefined && typeof override.npm !== "string") return
  const pkg = override?.npm ?? p.npm ?? "@ai-sdk/openai-compatible"
  const route = typeof pkg === "string" && routes.get(pkg)
  const remote = m.id === undefined ? id : m.id
  if (!route || !validID(remote)) return
  // Stock Kilo can inherit transport/headers from another configured remote model.
  if (remote !== id && Object.hasOwn(p.models, remote)) return
  const prefix = route === "/messages" && root === "https://api.anthropic.com" ? `${root}/v1` : root
  const list = `${prefix}/models`
  const url = `${list}/${encodeURIComponent(remote)}`
  return { id, remote, route, root, url, list, variants: m.variants, timeout: Math.min(typeof timeout === "number" ? timeout : 4000, 4000) }
}
type Target = NonNullable<ReturnType<typeof request>>

/** Validated destination, without reading credentials or making a request. */
export function metadataDestination(provider: Json, id: string): string | undefined {
  return request(provider, id)?.url
}

export function probeDestination(provider: Json, id: string): URL | undefined {
  const target = request(provider, id)
  if (target && target.route !== "/messages") return new URL(target.root + target.route)
}

const unsupported = Symbol("unsupported detail")

// Only missing endpoint metadata can fall back. In particular, a generic
// invalid_request_error or model_not_found is not evidence of a missing API.
function noDetailAPI(data: unknown): boolean {
  if (data === null || only(data, [])) return true
  const missing = (v: unknown) => typeof v === "string" && /^(?:(?:model detail |model details |detail )?endpoint (?:is )?(?:not implemented|not supported|not found)|not implemented|method not allowed)\.?$/i.test(v)
  if (only(data, ["detail"])) return missing(data.detail)
  if (!only(data, ["error", "success"]) || (data.success !== undefined && data.success !== false)) return false
  const e = data.error
  if (!record(e)) return missing(e)
  return only(e, ["message", "type", "code", "param", "request_id"]) && e.param == null &&
    (e.type === undefined || (typeof e.type === "string" && ["api_error", "invalid_request_error", "not_implemented"].includes(e.type))) &&
    (e.code == null || (typeof e.code === "string" && ["not_implemented", "unsupported_endpoint", "endpoint_not_found", "method_not_allowed"].includes(e.code))) &&
    (e.request_id === undefined || typeof e.request_id === "string") && missing(e.message)
}

function parse(text: string): unknown {
  // JSON.parse silently keeps the last of duplicate id, route, or effort fields.
  const stack: (Set<string> | null)[] = []
  function invalid(): never { throw new Error("Ambiguous metadata") }
  visit(text, {
    onObjectBegin() { if (stack.length > 32) invalid(); stack.push(new Set()) },
    onArrayBegin() { if (stack.length > 32) invalid(); stack.push(null) },
    onObjectEnd() { stack.pop() }, onArrayEnd() { stack.pop() },
    onObjectProperty(name) { const seen = stack.at(-1); if (!seen || seen.has(name)) invalid(); seen.add(name) },
    onError: invalid,
  }, { disallowComments: true, allowTrailingComma: false })
  return JSON.parse(text)
}

async function readBody(res: IncomingMessage, limit: number): Promise<string> {
  if (Number(res.headers["content-length"]) > limit || (res.headers["content-encoding"] ?? "identity") !== "identity") throw new Error("Unsupported response")
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of res) {
    size += chunk.length
    if (size > limit) throw new Error("Oversized response")
    chunks.push(chunk)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}

async function load(url: string, timeout: number, signal: AbortSignal, headers: Record<string, string>, allowUnsupported = false): Promise<unknown> {
  const get = url.startsWith("https:") ? httpsGet : httpGet
  // Node core, direct connection, verified TLS, no cookies, proxy credentials,
  // automatic redirect, retries or decompression. Bound time through body EOF.
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeout)])
  return new Promise((resolve, reject) => {
    const req = get(url, { signal: deadline, headers, agent: false, maxHeaderSize: 16384, rejectUnauthorized: true }, async res => {
      res.on("error", reject)
      const missing = allowUnsupported && (res.statusCode === 404 || res.statusCode === 405)
      try {
        if (!missing && res.statusCode !== 200) throw new Error("Unavailable metadata")
        const text = await readBody(res, maxBytes)
        if (!missing) return resolve(parse(text))
        // Do not interpret a model-specific denial/not-found as absence of a detail API.
        const message = res.statusCode === 404 ? "not found" : "method not allowed"
        if (text.trim() && text.trim().toLowerCase() !== message) {
          const body = parse(text)
          if (!only(body, ["detail"]) || typeof body.detail !== "string" || body.detail.toLowerCase() !== message) throw new Error("Detail unavailable")
        }
        resolve(unsupported)
      } catch (err) { res.destroy(); reject(err) }
    })
    req.on("error", reject)
  })
}

function nonempty(v: unknown): v is string {
  return typeof v === "string" && !!v.trim()
}

const probeTokens = 16
type ModelReason = "model_mismatch" | "ambiguous_completion" | "model_unavailable" | "request_incompatible"
type ProviderReason = "configuration" | "cancelled" | "timeout" | "network" | "authentication" | "billing" | "rate_limit" |
  "redirect" | "server_error" | "http_status" | "invalid_response" | "unrecognized_error"
type ProbeResult = { result: "accepted" | "rejected" | "unknown"; status?: number; allowedLevels?: string[]; modelUnsupported?: true;
  unknownScope?: "model" | "provider"; reason?: ModelReason | ProviderReason }

function providerUnknown(reason: ProviderReason, status?: number): ProbeResult {
  return { result: "unknown", unknownScope: "provider", reason, ...(status === undefined ? {} : { status }) }
}
function modelUnknown(reason: ModelReason, status: number): ProbeResult {
  return { result: "unknown", unknownScope: "model", reason, status }
}

// A usage receipt alone is not a completion. When present, it must agree with the
// request limit and with itself before it can corroborate hidden or truncated output.
function usageReceipt(u: unknown, chat: boolean) {
  if (!record(u)) return
  const input = u[chat ? "prompt_tokens" : "input_tokens"], output = u[chat ? "completion_tokens" : "output_tokens"]
  const count = (n: unknown, bound: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= bound
  // Allow generous gateway-added context for "Reply OK", not arbitrary huge counters.
  if (!count(input, 65536) || !input || !count(output, probeTokens) || !output || u.total_tokens !== input + output) return
  const details = u[chat ? "completion_tokens_details" : "output_tokens_details"]
  const prompt = u[chat ? "prompt_tokens_details" : "input_tokens_details"]
  if ((prompt != null && (!record(prompt) || !Object.values(prompt).every(n => count(n, input)))) ||
    (details != null && (!record(details) || !Object.values(details).every(n => count(n, output))))) return
  const reasoning = details?.reasoning_tokens
  if (u.reasoning_tokens !== undefined && (!count(u.reasoning_tokens, output) || (reasoning !== undefined && u.reasoning_tokens !== reasoning))) return
  return { output, reasoning: typeof reasoning === "number" ? reasoning : typeof u.reasoning_tokens === "number" ? u.reasoning_tokens : undefined }
}

// The probe asks only for "OK". An assistant message repeating a denial isn't
// positive evidence; never turn free-form gateway prose into alternative levels.
function apparentDenial(text: string) {
  return /\b(?:unsupported|not supported|does not support|unknown parameter|supported (?:values|levels|efforts) (?:are|include)|invalid (?:parameter|value|effort)|access denied|insufficient (?:balance|quota|credits?)|rate limit(?:ed)?|payment required)\b/i.test(text)
}

function completionResult(target: Target, level: string, v: unknown): ProbeResult {
  const invalid = providerUnknown("invalid_response", 200)
  if (!record(v) || !validID(v.model) || !nonempty(v.id) || (v.stream !== undefined && v.stream !== false) ||
    (v.reasoning_effort !== undefined && v.reasoning_effort !== level) ||
    (v.reasoning !== undefined && (!record(v.reasoning) || (v.reasoning.effort !== undefined && v.reasoning.effort !== level)))) return invalid
  const chat = target.route === "/chat/completions"
  const { error, ...rest } = v // Successful Responses commonly include error:null.
  if ((error !== undefined && (chat || error !== null)) || hasError(rest) || ["errors", "detail", "message", "code", "delta"].some(k => k in v)) return invalid
  const usage = usageReceipt(v.usage, chat)
  if (v.usage !== undefined && !usage) return invalid
  let text = false, reasoning = false, reasoningItem = false, emptyMessage = false, truncated: boolean
  if (chat) {
    if (v.object !== "chat.completion" || (v.status !== undefined && v.status !== "completed") || v.incomplete_details != null || "output" in v ||
      !Array.isArray(v.choices) || v.choices.length !== 1) return invalid
    const c = v.choices[0]
    if (!record(c) || c.index !== 0 || "delta" in c || (c.finish_reason !== "stop" && c.finish_reason !== "length") || !record(c.message)) return invalid
    const m = c.message
    if (m.role !== "assistant" || m.tool_calls != null || m.function_call != null || m.refusal != null ||
      (m.content != null && typeof m.content !== "string")) return invalid
    const traces = [m.reasoning_content, m.reasoning, m.reasoning_text].filter(x => x != null)
    if (!traces.every(x => typeof x === "string") || (m.content === undefined && !traces.length)) return invalid
    if ([m.content, ...traces].some(t => nonempty(t) && apparentDenial(t))) return invalid
    text = nonempty(m.content); reasoning = traces.some(nonempty); truncated = c.finish_reason === "length"
  } else {
    truncated = v.status === "incomplete"
    if (v.object !== "response" || "choices" in v || (!truncated && v.status !== "completed") ||
      (truncated ? !only(v.incomplete_details, ["reason"]) || v.incomplete_details.reason !== "max_output_tokens" : v.incomplete_details != null) ||
      (v.max_output_tokens != null && v.max_output_tokens !== probeTokens) || !Array.isArray(v.output) || !v.output.length) return invalid
    const ids = new Set<string>()
    for (const item of v.output) {
      if (!record(item) || !nonempty(item.id) || ids.has(item.id) || (item.status !== "completed" && !(truncated && item.status === "incomplete") &&
        !(item.type === "reasoning" && item.status === undefined))) return invalid
      ids.add(item.id)
      if (item.type === "reasoning") {
        reasoningItem = true
        if (!Array.isArray(item.summary)) return invalid
        for (const [parts, type] of [[item.summary, "summary_text"], [item.content ?? [], "reasoning_text"]] as const) {
          if (!Array.isArray(parts) || !parts.every(p => record(p) && p.type === type && nonempty(p.text) && !apparentDenial(p.text))) return invalid
          reasoning ||= parts.length > 0
        }
      } else {
        if (item.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content) ||
          !item.content.every(p => record(p) && p.type === "output_text" && nonempty(p.text) && !apparentDenial(p.text))) return invalid
        text ||= item.content.length > 0
        emptyMessage ||= item.content.length === 0
      }
    }
  }
  if ((reasoning && usage?.reasoning === 0) || (text && usage && usage.output === usage.reasoning)) return invalid
  if (v.model !== target.remote) return modelUnknown("model_mismatch", 200)
  // A typed Responses reasoning item may hide its text. If nothing is visible,
  // require the receipt to account for all output tokens as reasoning.
  const hidden = reasoningItem && usage !== undefined && usage.reasoning === usage.output
  if (!emptyMessage && (!truncated || usage) && (text || reasoning || hidden)) return { result: "accepted", status: 200 }
  return modelUnknown("ambiguous_completion", 200)
}

function denialEnvelope(data: unknown) {
  if (!only(data, ["error", "request_id"]) || !only(data.error, ["type", "param", "code", "message", "request_id"])) return
  const e = data.error, ids = [data.request_id, e.request_id].filter(id => id !== undefined)
  if (!ids.every(id => typeof id === "string" && /^[\w.-]{1,160}$/.test(id)) || new Set(ids).size > 1 ||
    !nonempty(e.message) || e.message.length > 2048) return
  let message = e.message.trim()
  const suffix = ` (request_id: ${ids[0]})`
  if (ids.length && message.endsWith(suffix)) message = message.slice(0, -suffix.length)
  return { type: e.type, code: e.code, param: e.param, message: message.replace(/(["`])([\w.:@~/\-]+)\1/g, "'$2'").replace(/\.$/, "") }
}

function rejected(target: Target, level: string, e: NonNullable<ReturnType<typeof denialEnvelope>>): boolean | string[] {
  if (e.type !== "invalid_request_error") return false
  const field = target.route === "/responses" ? "reasoning.effort" : "reasoning_effort"
  const message = e.message
  if (e.param === "model" && e.code === "model_not_supported") {
    return message === `Model '${target.remote}' is not supported on ${target.route}`
  }
  if (e.param !== field) return false
  if (e.code === "unsupported_parameter" || e.code === "unknown_parameter") return [
    `Unsupported parameter: '${field}'`, `Unknown parameter: '${field}'`,
    `Unsupported parameter: '${field}' is not supported with this model`,
  ].includes(message)
  if (e.code !== "unsupported_value") return false
  // Match the denied value, not a selected name appearing among suggested alternatives.
  const [denial, alternatives, extra] = message.split(". Supported values are: ")
  let names: string[] | undefined
  if (extra !== undefined) return false
  if (alternatives !== undefined) {
    if (!/^'[a-z0-9_-]+'(?:, '[a-z0-9_-]+')*(?:,? and '[a-z0-9_-]+')?$/i.test(alternatives)) return false
    names = [...alternatives.matchAll(/'([^']+)'/g)].map(m => m[1])
    if (names.length > 64 || !names.every(validLevel) || names.some(n => n.toLowerCase() === level.toLowerCase()) ||
      new Set(names.map(n => n.toLowerCase())).size !== names.length) return false
  }
  if (denial === `Unsupported value: '${level}' is not supported with the '${target.remote}' model`) return names ?? true
  return [`Unsupported value '${level}' for ${field}`, `Unsupported value: '${field}' does not support '${level}' with this model`,
    `Unsupported value: '${level}' is not supported with this model`].includes(denial)
}

function errorResult(target: Target, level: string, status: number, data: unknown): ProbeResult {
  const e = denialEnvelope(data)
  if (!e) return providerUnknown("unrecognized_error", status)
  if (["insufficient_quota", "insufficient_balance", "billing_error", "billing_hard_limit_reached"].some(s => s === e.type || s === e.code)) return providerUnknown("billing", status)
  const denial = rejected(target, level, e)
  if (Array.isArray(denial)) return { result: "rejected", status, allowedLevels: denial }
  if (denial) return e.code === "unsupported_value" ? { result: "rejected", status } : { result: "rejected", status, modelUnsupported: true }
  // A request validation error does not advertise any level. It can be isolated
  // to this check without promoting an account, billing or gateway error.
  if (status === 400 && e.type === 'api_error' && e.code === 'invalid_request' && e.param == null &&
    /^Invalid request\s*[.:;-]?\s*(?:please )?(?:check|verify) the model and request (?:parameters|format|settings)$/i.test(e.message)) {
    return modelUnknown('request_incompatible', status)
  }
  if ((status === 400 || status === 404) && (e.type === "invalid_request_error" || e.type === "api_error")) {
    const id = `'${target.remote}'`
    if ((e.param == null || e.param === "model") && ["model_not_found", "model_unavailable", "model_not_supported", "unsupported_model"].some(s => s === e.code) &&
      [`Model ${id} not found`, `Model ${id} was not found`, `The requested model ${id} was not found`, `Model ${id} is not available`, `Model ${id} is unavailable`, `Model ${id} is not supported`,
        `The model ${id} does not exist`, `The model ${id} does not exist or you do not have access to it`].includes(e.message)) return modelUnknown("model_unavailable", status)
    // A non-effort probe parameter can be incompatible with this model, without saying anything about effort support.
    if (e.code === "unsupported_parameter" && e.param === (target.route === "/responses" ? "max_output_tokens" : "max_tokens") &&
      e.message === `Unsupported parameter: '${e.param}' is not supported with the ${id} model`) return modelUnknown("model_unavailable", status)
  }
  return providerUnknown("unrecognized_error", status)
}

/** One explicit, potentially billable call; no credential lookup, fallback, or retry. */
export async function probe(provider: Json, localModelID: string, level: string, signal: AbortSignal): Promise<ProbeResult> {
  const target = request(provider, localModelID)
  if (signal.aborted) return providerUnknown("cancelled")
  if (!target || target.route === "/messages" || !record(provider.options) || !Object.hasOwn(provider.options, "apiKey") ||
    !safeKey(provider.options.apiKey) || !validLevel(level)) return providerUnknown("configuration")
  // A manual variant can override the outgoing model or effort, among other options.
  for (const [name, variant] of Object.entries(target.variants ?? {})) {
    if (name.toLowerCase() === level.toLowerCase() && (name !== level || !only(variant, ["reasoningEffort"]) || variant.reasoningEffort !== level)) return providerUnknown("configuration")
  }
  const chat = target.route === "/chat/completions"
  const payload = JSON.stringify(chat ? { model: target.remote, messages: [{ role: "user", content: "Reply OK" }], reasoning_effort: level, max_tokens: probeTokens, stream: false } :
    { model: target.remote, input: "Reply OK", reasoning: { effort: level }, max_output_tokens: probeTokens, stream: false, store: false })
  const post = target.root.startsWith("https:") ? httpsPost : httpPost
  const timeout = provider.options.timeout
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(typeof timeout === "number" ? timeout : 10000, 10000))])
  const headers = { authorization: `Bearer ${provider.options.apiKey}`, "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
  let status: number | undefined
  try {
    return await new Promise<ProbeResult>((resolve, reject) => {
      const req = post(target.root + target.route, { method: "POST", signal: deadline, headers, agent: false, maxHeaderSize: 16384, rejectUnauthorized: true }, async res => {
        status = res.statusCode
        res.on("error", reject)
        try {
          if (status !== 200 && status !== 400 && status !== 404 && status !== 422) {
            const reason = status === 401 || status === 403 ? "authentication" : status === 402 ? "billing" : status === 429 ? "rate_limit" :
              status && status >= 300 && status < 400 ? "redirect" : status && status >= 500 ? "server_error" : "http_status"
            return resolve(providerUnknown(reason, status))
          }
          if (res.headers["content-type"]?.split(";")[0].trim().toLowerCase() === "text/event-stream") return resolve(providerUnknown("invalid_response", status))
          const data = parse(await readBody(res, 64 * 1024))
          deadline.throwIfAborted()
          resolve(status === 200 ? completionResult(target, level, data) : errorResult(target, level, status, data))
        } catch (err) {
          if (deadline.aborted) reject(err)
          else resolve(providerUnknown("invalid_response", status))
        } finally { res.destroy() }
      })
      req.on("error", reject)
      req.end(payload)
    })
  } catch { return providerUnknown(signal.aborted ? "cancelled" : deadline.aborted ? "timeout" : "network", status) }
}

function hasError(v: unknown, depth = 0): boolean {
  if (depth > 32) return true
  if (Array.isArray(v)) return v.some(item => hasError(item, depth + 1))
  return record(v) && ("error" in v || ("success" in v && v.success !== true) || Object.values(v).some(item => hasError(item, depth + 1)))
}

function levels(target: Target, row: Json): string[] {
  if (target.route === "/messages") {
    const effort = record(row.capabilities) && row.capabilities.effort
    if (row.type !== "model" || row.id !== target.remote || !record(effort) || effort.supported !== true) return []
    return ["low", "medium", "high", "xhigh", "max"].filter(name => record(effort[name]) && effort[name].supported === true)
  }
  // Unknown capability/policy fields can qualify the list. Do not cherry-pick
  // a positive array from an otherwise unrecognized or disabled model shape.
  if (!only(row, ["id", "name", "object", "created", "owned_by", "description", "tags", "version", "supported_endpoints",
    "supported_endpoint_types", "model_picker_enabled", "policy", "capabilities", "reasoning_options", "reasoning"])) return []
  if ((row.object !== undefined && row.object !== "model") || (row.model_picker_enabled !== undefined && row.model_picker_enabled !== true) ||
    (row.policy !== undefined && (!only(row.policy, ["state"]) || row.policy.state !== "enabled"))) return []
  const exact = (v: unknown, value: string) => Array.isArray(v) && v.length === 1 && v[0] === value
  if (!exact(row.supported_endpoints, target.route)) return []
  if (row.supported_endpoint_types !== undefined && !exact(row.supported_endpoint_types, target.route === "/responses" ? "responses" : "openai")) return []
  let values: unknown
  if (row.capabilities !== undefined) {
    if (!only(row.capabilities, ["family", "limits", "supports"]) || !only(row.capabilities.supports,
      ["reasoning_effort", "streaming", "structured_outputs", "tool_calls", "vision", "adaptive_thinking", "max_thinking_budget", "min_thinking_budget"])) return []
    values = row.capabilities.supports.reasoning_effort
  }
  if (row.reasoning_options !== undefined) {
    const options = row.reasoning_options
    if (values !== undefined || !Array.isArray(options) || options.length !== 1 || !only(options[0], ["type", "values"]) || options[0].type !== "effort") return []
    values = options[0].values
  }
  if (row.reasoning !== undefined) {
    const r = row.reasoning
    if (values !== undefined || !only(r, ["supported", "mandatory", "supported_efforts"]) ||
      (r.supported !== undefined && r.supported !== true) || (r.mandatory !== undefined && typeof r.mandatory !== "boolean")) return []
    values = r.supported_efforts
    if (r.mandatory && Array.isArray(values) && values.some(v => typeof v === "string" && v.toLowerCase() === "none")) return []
  }
  if (!Array.isArray(values) || values.length > 64) return []
  // A typed option may include null (provider default); it is not a level.
  const names = row.reasoning_options === undefined ? values : values.filter(v => v !== null)
  if (!names.every(validLevel)) return []
  return new Set(names.map(n => n.toLowerCase())).size === names.length ? names : []
}

type Source = "detail" | "list" | "unavailable" | "stop"
type Report = (matched: boolean, advertised: boolean, modelID: string, source: Source, names?: readonly string[], eligibleForAutomaticProbe?: boolean) => void

function probeEligible(target: Target, row: Json, source: Source): boolean {
  if (target.route === "/messages" || row.id !== target.remote ||
    !only(row, ["id", "object", "created", "owned_by", "name", "description", "supported_endpoints", "supported_endpoint_types"]) ||
    (row.object !== undefined && row.object !== "model") || (row.created !== undefined && !Number.isSafeInteger(row.created)) ||
    [row.owned_by, row.name, row.description].some(v => v !== undefined && typeof v !== "string")) return false
  // A model being routable is weaker evidence than a route-specific effort
  // enum. Multiple protocols may be offered; do not publish levels from that.
  const paths = row.supported_endpoints, types = row.supported_endpoint_types
  if (paths !== undefined && (!Array.isArray(paths) || paths.length !== 1 || paths[0] !== target.route)) return false
  if (types !== undefined) {
    if (!Array.isArray(types) || types.length > 64 ||
      !types.includes(target.route === "/responses" ? "responses" : "openai")) return false
    const seen = new Set<string>()
    for (const token of types) {
      if (typeof token !== "string" || token.length > 64 || !/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i.test(token)) return false
      const name = token.toLowerCase()
      if (reserved.has(name) || /(?:^|[._-])(?:no|not|none|null|false|off|disabled|unsupported|notsupported|nosupport)(?:$|[._-])/.test(name) || seen.has(name)) return false
      seen.add(name)
    }
  }
  // The ID in its own model detail can suffice with no route metadata. A
  // catalog row, even under the same key and base, needs an explicit route.
  return source === "detail" || paths !== undefined || types !== undefined
}

/** Raw custom-provider JSON only. The caller validates the credential destination,
 * submits at most 64 IDs, and must not start another chunk after a `stop` report.
 * Reads are serial unless the caller opts into bounded GET concurrency. */
export async function discover(provider: Json, ids: string[], signal: AbortSignal, report?: Report, corroborateAvailability = false, concurrency = 1): Promise<Map<string, Variants>> {
  if (ids.length > maxCandidates) throw new RangeError(`Select at most ${maxCandidates} models per metadata check`)
  const result = new Map<string, Variants>()
  const opts = provider.options
  if (!record(opts) || !Object.hasOwn(opts, "apiKey") || !safeKey(opts.apiKey)) return result
  const apiKey = opts.apiKey
  const groups = new Map<string, Target[]>()
  for (const id of new Set(ids)) {
    const target = request(provider, id)
    if (!target) { report?.(false, false, id, "unavailable", undefined, false); continue }
    const key = `${target.route === "/messages" ? "anthropic" : "bearer"} ${target.url}`
    const group = groups.get(key)
    if (group) group.push(target)
    else groups.set(key, [target])
  }
  const selected = new Set([...groups.values()].map(group => group[0].remote))
  const stop = new AbortController(), active = AbortSignal.any([signal, stop.signal])
  // All bearer targets in this invocation have the same validated base and key.
  // Cache the promise (including rejection), not just the completed catalog.
  let list: Promise<Map<string, Json | undefined>> | undefined
  async function readList(first: Target, headers: Record<string, string>) {
    const data = await load(first.list, first.timeout, active, headers)
    if (!only(data, ["object", "data", "success"]) || hasError(data) || (data.object !== undefined && data.object !== "list") || !Array.isArray(data.data)) throw new Error("Invalid list")
    const rows = new Map<string, Json | undefined>()
    for (const item of data.data) {
      if (record(item) && typeof item.id === "string" && selected.has(item.id)) rows.set(item.id, rows.has(item.id) ? undefined : item)
    }
    return rows
  }

  async function check(targets: Target[]) {
    const first = targets[0]
    let row: Json | undefined, source: Source = "detail", availabilityOnly = false
    if (!active.aborted) {
      const bearer = first.route !== "/messages"
      const headers: Record<string, string> = bearer ? { authorization: `Bearer ${apiKey}` } : { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
      try {
        const data = await load(first.url, first.timeout, active, headers, bearer)
        active.throwIfAborted()
        // Some gateways have distinct detail and inference catalogs. A missing
        // detail is never effort evidence. Only a separate authenticated unique
        // route listing can make it a candidate for an independently opted-in POST.
        if (corroborateAvailability && bearer && only(data, ['error']) && only(data.error, ['code','type','message','request_id'])) {
          const e = data.error
          const trace = typeof e.request_id === 'string' && /^[\w.-]{1,160}$/.test(e.request_id) ? ` (request_id: ${e.request_id})` : undefined
          availabilityOnly = e.type === 'api_error' && e.code === 'model_not_found' &&
            (e.message === 'The requested model was not found.' || (trace !== undefined && e.message === `The requested model was not found.${trace}`))
        }
        if (bearer && (data === unsupported || noDetailAPI(data) || availabilityOnly)) {
          source = "list"
          list ??= readList(first, headers)
          row = (await list).get(first.remote)
        } else {
          if (hasError(data)) throw new Error("Failed detail")
          if (record(data) && data.id === first.remote) row = data
        }
      } catch { stop.abort() } // cancel sibling GETs; never dispatch another detail or fallback
    }
    for (const target of targets) {
      if (active.aborted || !row) { report?.(false, false, target.id, active.aborted ? "stop" : source, undefined, false); continue }
      const field = target.route === "/messages" ? "effort" : "reasoningEffort"
      const advertised = availabilityOnly ? [] : levels(target, row)
      report?.(true, advertised.length > 0, target.id, source, advertised.length ? advertised : undefined,
        !advertised.length && probeEligible(target, row, source))
      const existing = new Set(Object.keys(target.variants ?? {}).map(name => name.toLowerCase()))
      const names = advertised.filter(name => !existing.has(name.toLowerCase()))
      if (names.length) result.set(target.id, Object.fromEntries(names.map(n => [n, { [field]: n }])))
    }
  }
  // A worker owns at most one GET: it finishes its detail before it can start or
  // await the list. No separate list slot and no pre-dispatch of queued groups.
  const remaining = groups.values()
  async function worker() { for (const targets of remaining) await check(targets) }
  const width = Number.isSafeInteger(concurrency) ? Math.min(maxMetadataConcurrency, Math.max(1, concurrency)) : 1
  try { await Promise.all(Array.from({ length: Math.min(width, groups.size) }, worker)) }
  finally { stop.abort() }
  return signal.aborted ? new Map() : result
}
