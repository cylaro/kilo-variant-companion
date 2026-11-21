import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type RequestListener, type ServerResponse } from "node:http"
import { test, type TestContext } from "node:test"
import { discover, metadataDestination, probe, probeDestination } from "../src/metadata.js"

async function fixture(t: TestContext, listener: RequestListener) {
  const server = createServer(listener)
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => new Promise<void>(resolve => {
    server.close(() => resolve())
    server.closeAllConnections()
  }))
  const address = server.address()
  assert.ok(address && typeof address !== "string")
  return `http://127.0.0.1:${address.port}/proxy/v1`
}

const key = "fixture-key"
const signal = new AbortController().signal
const chat = "/chat/completions", responses = "/responses"
const row = (id: string, route: string, values: unknown[]) => ({
  id, supported_endpoints: [route], capabilities: { supports: { reasoning_effort: values } },
})
const low = { reasoningEffort: "low" }, ultra = { reasoningEffort: "ultra" }

const remote = "tenant/model"
const completion = { id: "c1", object: "chat.completion", created: 1, model: remote,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "OK" } }] }
const response = { id: "r1", object: "response", model: remote, status: "completed", error: null,
  output: [{ id: "m1", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "OK", annotations: [] }] }] }
const unknown = (unknownScope: "model" | "provider", reason: string, status?: number) =>
  ({ result: "unknown", unknownScope, reason, ...(status === undefined ? {} : { status }) })

test("one selected effort sends a single tiny authenticated POST to the configured SDK route and remote model", async t => {
  const calls: unknown[] = []
  const baseURL = await fixture(t, async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    calls.push([req.method, req.url, req.headers.authorization, req.headers["content-type"], JSON.parse(Buffer.concat(chunks).toString())])
    res.end(JSON.stringify(req.url?.endsWith(chat) ? completion : response))
  })
  const models = { chat: { id: remote, provider: { npm: "@ai-sdk/openai-compatible" } }, responses: { id: remote } }
  const p = { npm: "@ai-sdk/openai", models, options: { baseURL, apiKey: key } }
  for (const [id, route] of [["chat", chat], ["responses", responses]]) {
    assert.equal(probeDestination(p, id)?.href, baseURL + route)
    assert.deepEqual(await probe(p, id, "ultra", signal), { result: "accepted", status: 200 })
  }
  assert.deepEqual(calls, [
    ["POST", "/proxy/v1/chat/completions", `Bearer ${key}`, "application/json", { model: remote, messages: [{ role: "user", content: "Reply OK" }], reasoning_effort: "ultra", max_tokens: 16, stream: false }],
    ["POST", "/proxy/v1/responses", `Bearer ${key}`, "application/json", { model: remote, input: "Reply OK", reasoning: { effort: "ultra" }, max_output_tokens: 16, stream: false, store: false }],
  ])
})

test("authenticated detail binds levels to the remote ID, SDK route and local alias", async t => {
  const requests: unknown[] = [], reports: unknown[] = []
  const baseURL = await fixture(t, (req, res) => {
    requests.push([req.method, req.url, req.headers.authorization, req.headers["x-api-key"]])
    const body = req.url?.endsWith("/tenant%2FA") ? row("tenant/A", chat, ["low", "ultra"]) :
      { id: "B", supported_endpoints: [responses], reasoning_options: [{ type: "effort", values: [null, "low"] }] }
    res.end(JSON.stringify(body))
  })
  const p = { options: { baseURL, apiKey: key }, models: {
    a: { id: "tenant/A" }, b: { id: "B", provider: { npm: "@ai-sdk/openai" } },
    alias: { id: "tenant/A", variants: { Ultra: { disabled: true }, low: { temperature: 0.3 } } },
    wrongRoute: { id: "tenant/A", provider: { npm: "@ai-sdk/openai" } },
  } }
  assert.equal(metadataDestination(p, "a"), `${baseURL}/models/tenant%2FA`)
  const result = await discover(p, ["a", "b", "a", "alias", "wrongRoute"], signal,
    (found, efforts, id, source, names) => reports.push([id, found, efforts, source, names]))
  assert.deepEqual(Object.fromEntries(result), { a: { low, ultra }, b: { low } })
  assert.deepEqual(reports, [["a", true, true, "detail", ["low", "ultra"]], ["alias", true, true, "detail", ["low", "ultra"]],
    ["wrongRoute", true, false, "detail", undefined], ["b", true, true, "detail", ["low"]]])
  assert.deepEqual(requests, [["GET", "/proxy/v1/models/tenant%2FA", `Bearer ${key}`, undefined],
    ["GET", "/proxy/v1/models/B", `Bearer ${key}`, undefined]])
})

test("only an explicit denial of the selected effort, field or model route is rejected", async t => {
  let status = 400, body: unknown
  const baseURL = await fixture(t, (_, res) => res.writeHead(status).end(JSON.stringify(body)))
  const p = { options: { baseURL, apiKey: key }, models: { alias: { id: remote }, r: { id: remote, provider: { npm: "@ai-sdk/openai" } } } }
  const error = { type: "invalid_request_error", code: "unsupported_value", param: "reasoning_effort", message: "Unsupported value 'ultra' for reasoning_effort." }
  const cases: [number, string, unknown, string, string[]?][] = [
    [400, "alias", { error }, "rejected"],
    [400, "alias", { error, request_id: "req-1" }, "rejected"],
    [400, "alias", { error: { ...error, request_id: "req-1", message: error.message + " (request_id: req-1)" } }, "rejected"],
    [400, "alias", { error: { ...error, request_id: "req-2" }, request_id: "req-1" }, "unknown"],
    [400, "alias", { error, request_id: { text: "req-1" } }, "unknown"],
    [400, "alias", { error, request_id: "line\nbreak" }, "unknown"],
    [400, "alias", { error, request_id: "req-1", message: "Account suspended" }, "unknown"],
    [400, "alias", { error: { ...error, request_id: "req-1", message: error.message + " (request_id: req-2)" } }, "unknown"],
    [400, "alias", { error: { ...error, message: `Unsupported value: 'ultra' is not supported with the '${remote}' model. Supported values are: 'low', 'medium', and 'high'.` } }, "rejected", ["low", "medium", "high"]],
    [422, "r", { error: { ...error, param: "reasoning.effort", message: `Unsupported value: 'ultra' is not supported with the '${remote}' model. Supported values are: 'low' and 'high'.` } }, "rejected", ["low", "high"]],
    [400, "alias", { error: { ...error, message: "Unsupported value: 'ultra' is not supported with this model. Supported values are: 'low' and 'high'." } }, "rejected"],
    [400, "alias", { error: { ...error, message: `Unsupported value: 'ultra' is not supported with the 'other' model. Supported values are: 'low' and 'high'.` } }, "unknown"],
    [400, "alias", { error: { ...error, message: `Unsupported value: 'ultra' is not supported with the '${remote}' model. Supported values are: 'low' and 'ultra'.` } }, "unknown"],
    ...["'low' and 'ULTRA'", "'low', 'LOW'", "'prototype'", "'Default'", "'low' and 'high\"", "'low' 'high'", "'high' except for this route",
      Array(65).fill("'low'").join(", ")].map(values => [400, "alias", { error: { ...error, message: `Unsupported value: 'ultra' is not supported with the '${remote}' model. Supported values are: ${values}.` } }, "unknown"] as [number, string, unknown, string]),
    [422, "r", { error: { ...error, param: "reasoning.effort", message: "Unsupported value: 'reasoning.effort' does not support 'ultra' with this model." } }, "rejected"],
    [400, "alias", { error: { ...error, code: "unsupported_parameter", message: "Unsupported parameter: 'reasoning_effort'" } }, "rejected"],
    [404, "alias", { error: { ...error, code: "model_not_supported", param: "model", message: `Model '${remote}' is not supported on /chat/completions.` } }, "rejected"],
    [400, "alias", { error: { ...error, message: "Unsupported value 'low' for reasoning_effort. Supported values include ultra." } }, "unknown"],
    [400, "r", { error }, "unknown"], [200, "alias", { ...completion, error }, "unknown"],
    [400, "alias", { error: { ...error, message: "Missing account balance" } }, "unknown"],
    [400, "alias", { error: { ...error, code: "insufficient_quota" } }, "unknown"],
    [400, "alias", { error: { ...error, param: "max_tokens" } }, "unknown"],
    [400, "alias", { error: "unsupported value" }, "unknown"], [404, "alias", { error: { code: "model_not_found" } }, "unknown"],
    ...[401, 402, 403, 429, 503].map(status => [status, "alias", { error }, "unknown"] as [number, string, unknown, string]),
  ]
  for (const [s, id, v, result, allowedLevels] of cases) {
    status = s; body = v
    const terminal = result === 'rejected' && ['unsupported_parameter','model_not_supported'].includes((v as { error?: { code?: string } })?.error?.code ?? '')
    const reason = s === 200 ? "invalid_response" : s === 401 || s === 403 ? "authentication" : s === 429 ? "rate_limit" : s === 503 ? "server_error" :
      s === 402 || (v as { error?: { code?: string } }).error?.code === "insufficient_quota" ? "billing" : "unrecognized_error"
    assert.deepEqual(await probe(p, id, "ultra", signal), result === "unknown" ? unknown("provider", reason, s) : allowedLevels ?
      { result, status, allowedLevels } : terminal ? { result, status, modelUnsupported: true } : { result, status }, JSON.stringify(v))
  }
})

test("a request validation failure is not a gateway outage or evidence of an effort level", async t => {
  let message = 'Invalid request - check the model and request parameters. (request_id: sample)'
  const baseURL = await fixture(t, (_, res) => res.writeHead(400).end(JSON.stringify({error:{type:'api_error',code:'invalid_request',message,request_id:'sample'}})))
  const p = {options:{baseURL,apiKey:key},models:{alias:{id:remote}}}
  assert.deepEqual(await probe(p, 'alias', 'none', signal), unknown('model', 'request_incompatible', 400))
  message = 'Invalid request: insufficient balance. (request_id: sample)'
  assert.deepEqual(await probe(p, 'alias', 'none', signal), unknown('provider', 'unrecognized_error', 400))
})

test("200 alone does not verify an alias, stream, malformed output, empty completion, or conflicting effort", async t => {
  let body: unknown
  const baseURL = await fixture(t, (_, res) => res.end(JSON.stringify(body)))
  const p = { options: { baseURL, apiKey: key }, models: { alias: { id: remote }, r: { id: remote, provider: { npm: "@ai-sdk/openai" } } } }
  for (body of [{ ...completion, object: "chat.completion.chunk" },
    { ...completion, stream: true }, { ...completion, status: "failed" }, { ...completion, reasoning_effort: "low" }, { ...completion, choices: [] },
    { ...completion, choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }], usage: { completion_tokens: 16 } },
    { ...completion, choices: [{ index: 0, finish_reason: "stop", message: { role: "user", content: "OK" } }] },
    { ...completion, details: [{ error: "denied" }] }, { ...completion, success: false }, response]) {
    assert.deepEqual(await probe(p, "alias", "ultra", signal), unknown("provider", "invalid_response", 200), JSON.stringify(body))
  }
  for (body of [{ ...response, error: {} }, { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, usage: { output_tokens: 16 } },
    { ...response, reasoning: { effort: "low" } }, { ...response, output: [] },
    { ...response, output: [{ ...response.output[0], status: "failed" }] }, completion]) {
    assert.deepEqual(await probe(p, "r", "ultra", signal), unknown("provider", "invalid_response", 200), JSON.stringify(body))
  }
  for (const [id, v, reason] of [
    ["alias", { ...completion, model: "alias" }, "model_mismatch"], ["alias", { ...completion, model: remote + "-snapshot" }, "model_mismatch"],
    ["r", { ...response, model: "r" }, "model_mismatch"], ["r", { ...response, output: [{ ...response.output[0], content: [] }] }, "ambiguous_completion"],
    ["alias", { ...completion, choices: [{ index: 0, finish_reason: "length", message: { role: "assistant", content: "" } }] }, "ambiguous_completion"],
  ] as const) {
    body = v
    assert.deepEqual(await probe(p, id, "ultra", signal), unknown("model", reason, 200))
  }
})

test("probe neither follows redirects nor retries even with a bounded, interrupted or invalid response", async t => {
  let leaks = 0, calls = 0
  const other = await fixture(t, (_, res) => { leaks++; res.end("{}") })
  const handlers: RequestListener[] = [
    (_, res) => res.writeHead(307, { location: other }).end(), (_, res) => res.writeHead(429, { "retry-after": "0" }).end(),
    (_, res) => res.writeHead(200, { "content-type": "text/event-stream" }).end(JSON.stringify(completion)),
    (_, res) => res.end('{"model":"wrong",' + JSON.stringify(completion).slice(1)), (_, res) => res.end("{"),
    (_, res) => res.writeHead(200, { "content-encoding": "gzip" }).end(JSON.stringify(completion)),
    (_, res) => { res.write(" ".repeat(64 * 1024)); res.end(JSON.stringify(completion)) },
    (_, res) => res.write("{"), req => req.socket.destroy(),
  ]
  const baseURL = await fixture(t, (req, res) => { calls++; handlers.shift()!(req, res) })
  const p = { options: { baseURL, apiKey: key, timeout: 150 }, models: { a: { id: remote } } }
  const reasons = ["redirect", "rate_limit", "invalid_response", "invalid_response", "invalid_response", "invalid_response", "invalid_response", "timeout", "network"]
  for (const [i, status] of [307, 429, 200, 200, 200, 200, 200, 200, undefined].entries()) {
    assert.deepEqual(await probe(p, "a", "ultra", signal), unknown("provider", reasons[i], status))
    assert.equal(calls, i + 1)
  }
  assert.equal(leaks, 0)
})

test("reasoning-only completions need exact model, nonstream assistant output, and a credible receipt when truncated", async t => {
  let body: unknown
  const baseURL = await fixture(t, (_, res) => res.end(JSON.stringify(body)))
  const p = { options: { baseURL, apiKey: key }, models: { alias: { id: remote } } }
  const choice = { index: 0, finish_reason: "length", message: { role: "assistant", content: null, reasoning_content: "Reply with OK" } }
  const usage = { prompt_tokens: 8, completion_tokens: 16, total_tokens: 24, completion_tokens_details: { reasoning_tokens: 16 } }
  const good = { ...completion, choices: [choice], usage }
  const accepted = { result: "accepted", status: 200 }, invalid = unknown("provider", "invalid_response", 200), ambiguous = unknown("model", "ambiguous_completion", 200)
  for (const [v, result] of [
    [good, accepted], [{ ...good, usage: undefined, choices: [{ ...choice, finish_reason: "stop" }] }, accepted],
    [{ ...good, model: "alias" }, unknown("model", "model_mismatch", 200)],
    [{ ...good, usage: undefined }, ambiguous], [{ ...good, choices: [{ ...choice, message: { role: "assistant", content: null } }] }, ambiguous],
    [{ ...good, choices: [{ ...choice, message: { ...choice.message, reasoning_content: "Unsupported effort. Supported values: low, ultra." } }] }, invalid],
    [{ ...good, choices: [{ ...choice, message: { ...choice.message, reasoning_content: "Supported values are low and ultra." } }] }, invalid],
    [{ ...good, choices: [{ ...choice, message: { ...choice.message, content: "OK" } }] }, invalid],
    [{ ...good, usage: { ...usage, reasoning_tokens: 1 } }, invalid],
    [{ ...good, choices: [{ ...choice, message: { ...choice.message, tool_calls: [] } }] }, invalid],
    [{ ...good, choices: [{ ...choice, message: { ...choice.message, refusal: "blocked" } }] }, invalid],
    ...["max_tokens", "content_filter", "tool_calls", "error", null].map(finish_reason => [{ ...good, choices: [{ ...choice, finish_reason }] }, invalid]),
    ...[{ ...usage, total_tokens: 16 }, { ...usage, prompt_tokens: "8" }, { ...usage, prompt_tokens: 0, total_tokens: 16 },
      { ...usage, prompt_tokens: Number.MAX_SAFE_INTEGER }, { ...usage, prompt_tokens: 999999, total_tokens: 1000015 }, { ...usage, completion_tokens: 17, total_tokens: 25 },
      { ...usage, completion_tokens: 0, total_tokens: 8 }, { ...usage, completion_tokens: 1.5, total_tokens: 9.5 },
      { ...usage, completion_tokens_details: { reasoning_tokens: 0 } }, { ...usage, prompt_tokens_details: { cached_tokens: 9 } },
      ...[-1, "1", 17, null].map(reasoning_tokens => ({ ...usage, completion_tokens_details: { reasoning_tokens } })),
    ].map(bad => [{ ...good, usage: bad }, invalid]),
  ]) {
    body = v
    assert.deepEqual(await probe(p, "alias", "ultra", signal), result, JSON.stringify(v))
  }
})

test("Responses requires typed reasoning output and exact, corroborated max_output_tokens termination", async t => {
  let body: unknown
  const baseURL = await fixture(t, (_, res) => res.end(JSON.stringify(body)))
  const p = { npm: "@ai-sdk/openai", options: { baseURL, apiKey: key }, models: { alias: { id: remote } } }
  const item = { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "Reply with OK" }] }
  const hidden = { ...item, summary: [] }
  const usage = { input_tokens: 10, output_tokens: 16, total_tokens: 26, output_tokens_details: { reasoning_tokens: 16 } }
  const good = { ...response, status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ ...item, status: "incomplete" }], usage }
  const accepted = { result: "accepted", status: 200 }, invalid = unknown("provider", "invalid_response", 200), ambiguous = unknown("model", "ambiguous_completion", 200)
  for (const [v, result] of [
    [good, accepted], [{ ...response, output: [item] }, accepted], [{ ...good, output: [hidden] }, accepted],
    [{ ...good, usage: undefined }, ambiguous], [{ ...response, output: [hidden] }, ambiguous],
    [{ ...good, output: [hidden], usage: { ...usage, output_tokens_details: { reasoning_tokens: 0 } } }, ambiguous],
    [{ ...good, output: [{ ...item, summary: [{ type: "text", text: "OK" }] }] }, invalid],
    [{ ...good, output: [{ ...item, summary: [], content: [{ type: "reasoning_text", text: "Reply OK" }] }] }, accepted],
    [{ ...good, output: [item, { ...response.output[0], content: [] }] }, ambiguous], [{ ...good, output: [item, item] }, invalid],
    [{ ...good, usage: { ...usage, total_tokens: undefined } }, invalid], [{ ...good, usage: { ...usage, output_tokens_details: { reasoning_tokens: 17 } } }, invalid],
    [{ ...good, status: "failed" }, invalid], [{ ...good, status: "completed" }, invalid], [{ ...good, output: [{ ...item, status: "in_progress" }] }, invalid],
    [{ ...good, output: [{ type: "function_call", id: "fc1" }] }, invalid], [{ ...good, model: "alias", error: { code: "billing_error" } }, invalid],
    ...[null, { reason: "content_filter" }, { reason: "MAX_OUTPUT_TOKENS" }, { reason: "max_output_tokens", code: "billing_error" }]
      .map(incomplete_details => [{ ...good, incomplete_details }, invalid]),
  ]) {
    body = v
    assert.deepEqual(await probe(p, "alias", "ultra", signal), result, JSON.stringify(v))
  }
})

test("only narrow 400/404 errors naming the exact remote model are model-local unknowns", async t => {
  let status = 400, body: unknown
  const baseURL = await fixture(t, (_, res) => res.writeHead(status).end(JSON.stringify(body)))
  const p = { options: { baseURL, apiKey: key }, models: { alias: { id: remote } } }
  const error = { type: "invalid_request_error", param: null, code: "model_not_found", message: `The model \`${remote}\` does not exist or you do not have access to it.` }
  for (const [s, e, scope, reason] of [
    [404, error, "model", "model_unavailable"],
    [400, { ...error, code: "unsupported_model", param: "model", message: `Model '${remote}' is not supported` }, "model", "model_unavailable"],
    [400, { ...error, code: "unsupported_parameter", param: "max_tokens", message: `Unsupported parameter: 'max_tokens' is not supported with the '${remote}' model` }, "model", "model_unavailable"],
    [422, error, "provider", "unrecognized_error"], [503, error, "provider", "server_error"], [200, error, "provider", "invalid_response"],
    [400, { ...error, param: "account" }, "provider", "unrecognized_error"], [404, { ...error, code: "insufficient_quota" }, "provider", "billing"],
    [400, { ...error, message: "Model not found" }, "provider", "unrecognized_error"],
    [400, { ...error, message: error.message.replace(remote, "alias") }, "provider", "unrecognized_error"],
    [404, { ...error, message: error.message + " Check your balance." }, "provider", "unrecognized_error"],
    [400, { ...error, type: "billing_error" }, "provider", "billing"],
  ] as const) {
    status = s; body = { error: e, request_id: "private-fixture-id" }
    assert.deepEqual(await probe(p, "alias", "ultra", signal), unknown(scope, reason, s))
  }
})

test("TLS negotiation failures stay provider-scoped and never downgrade to HTTP", async t => {
  let requests = 0
  const baseURL = (await fixture(t, (_, res) => { requests++; res.end(JSON.stringify(completion)) })).replace("http:", "https:")
  assert.deepEqual(await probe({ options: { baseURL, apiKey: key }, models: { alias: { id: remote } } }, "alias", "ultra", signal), unknown("provider", "network"))
  assert.equal(requests, 0)
})

test("unsupported raw provider, auth, route, selected variant or transport makes no probe request", async t => {
  let calls = 0
  const baseURL = await fixture(t, (_, res) => { calls++; res.end("{}") })
  const options = { baseURL, apiKey: key }, p = { options, models: { a: {} } }
  for (const candidate of [{ ...p, npm: "@ai-sdk/anthropic" }, { ...p, npm: "unknown" },
    { ...p, options: { ...options, headers: { authorization: "another" } } }, { ...p, options: { ...options, baseURL: baseURL + "?test=1" } },
    { ...p, options: { ...options, apiKey: "{env:EXAMPLE}" } }, { ...p, models: { a: { options: { model: "other" } } } },
    { ...p, models: { a: { provider: { api: baseURL + "/else" } } } }, { ...p, models: { a: { id: "other" }, other: {} } },
  ]) {
    assert.equal(probeDestination(candidate, "a"), undefined)
    assert.deepEqual(await probe(candidate, "a", "ultra", signal), unknown("provider", "configuration"))
  }
  assert.equal(probeDestination({ ...p, options: { baseURL } }, "a")?.href, baseURL + chat)
  for (const variant of [{ disabled: true }, { reasoningEffort: "low" }, { reasoningEffort: "ultra", model: "surprise" }]) {
    assert.deepEqual(await probe({ ...p, models: { a: { variants: { ultra: variant } } } }, "a", "ultra", signal), unknown("provider", "configuration"))
  }
  assert.deepEqual(await probe({ ...p, options: { baseURL } }, "a", "ultra", signal), unknown("provider", "configuration"))
  assert.deepEqual(await probe(p, "a", "ultra", AbortSignal.abort()), unknown("provider", "cancelled"))
  for (const name of ["", "default", "prototype", "toString", "too long ".repeat(6)]) assert.deepEqual(await probe(p, "a", name, signal), unknown("provider", "configuration"))
  assert.equal(calls, 0)
})

test("404 and 405 can share one authenticated fallback; a list row cannot override a detail", async t => {
  const reads: unknown[] = [], outcomes: unknown[] = []
  const baseURL = await fixture(t, (req, res) => {
    reads.push([req.method, req.url, req.headers.authorization])
    if (req.url?.endsWith("/A")) return res.writeHead(404).end()
    if (req.url?.endsWith("/B")) return res.writeHead(405).end('{"detail":"Method Not Allowed"}')
    if (req.url?.endsWith("/C")) return res.end(JSON.stringify(row("C", chat, [])))
    res.end(JSON.stringify({ object: "list", data: [row("A", chat, ["ultra"]), row("B", responses, ["low"]), row("C", chat, ["ultra"])] }))
  })
  const p = { options: { baseURL, apiKey: key }, models: { A: {}, B: { provider: { npm: "@ai-sdk/openai" } }, C: {} } }
  const result = await discover(p, ["A", "B", "C"], signal, (found, efforts, id, source) => outcomes.push([id, found, efforts, source]))
  assert.deepEqual(Object.fromEntries(result), { A: { ultra }, B: { low } })
  assert.deepEqual(outcomes, [["A", true, true, "list"], ["B", true, true, "list"], ["C", true, false, "detail"]])
  assert.deepEqual(reads, ["/A", "", "/B", "/C"].map(s => ["GET", `/proxy/v1/models${s}`, `Bearer ${key}`]))
})

test("discovery distinguishes a missing effort list from a positive list, disabled effort or a conflicting detail", async t => {
  const details = {
    bare: { id: "bare" }, typed: { id: "typed", object: "model", owned_by: "fixture", created: 10 },
    empty: row("empty", chat, []), defaults: { id: "defaults", supported_endpoints: [chat], reasoning_options: [{ type: "effort", values: [null] }] },
    disabled: { id: "disabled", supported_endpoints: [chat], reasoning: { supported: false } },
    off: { id: "off", capabilities: { supports: { reasoning_effort: false } } },
    wrong: { id: "wrong", supported_endpoints: [responses] }, advertised: row("advertised", chat, ["low"]),
    anthropic: { type: "model", id: "anthropic" }, mismatch: { id: "another" },
  }
  const calls: string[] = [], reports: unknown[] = [], ids = Object.keys(details)
  const baseURL = await fixture(t, (req, res) => {
    calls.push(req.url!)
    res.end(JSON.stringify(details[req.url!.split("/").pop() as keyof typeof details]))
  })
  const models = { ...Object.fromEntries(ids.map(id => [id, {}])), anthropic: { provider: { npm: "@ai-sdk/anthropic" } } }
  const result = await discover({ models, options: { baseURL, apiKey: key } }, ids, signal,
    (...args: unknown[]) => reports.push([args[2], args[5]]))
  assert.deepEqual(Object.fromEntries(result), { advertised: { low } })
  assert.deepEqual(reports, ids.map(id => [id, ["bare", "typed"].includes(id)]))
  assert.deepEqual(calls, ids.map(id => `/proxy/v1/models/${id}`))
})

test("unimplemented 200 details share one authenticated list; only exact unique route availability permits probes", async t => {
  const calls: unknown[] = [], reports: unknown[] = []
  const protocolRow = (id: string) => ({ id, created: 10, owned_by: "fixture", object: "model", supported_endpoint_types: ["openai", "responses"] })
  const baseURL = await fixture(t, (req, res) => {
    calls.push([req.method, req.url, req.headers.authorization])
    if (req.url === "/proxy/v1/models") return res.end(JSON.stringify({ object: "list", data: [
      protocolRow("A"), { id: "B", supported_endpoints: [chat] }, row("C", chat, ["ultra"]), { id: "D" },
      protocolRow("E"), protocolRow("E"), { ...protocolRow("F"), supported_endpoints: [responses] },
      { ...protocolRow("G"), reasoning: { supported: false } }, protocolRow("h"), { ...protocolRow("I"), disabled: true },
      { ...protocolRow("J"), reasoning: { supported_efforts: [] } }, { ...protocolRow("K"), policy: { state: "denied" } },
    ] }))
    res.end(JSON.stringify(req.url?.endsWith("/C") ? {} : {
      error: { type: "invalid_request_error", code: "not_implemented", message: "Model detail endpoint is not implemented" },
    }))
  })
  const ids = "ABCDEFGHIJK".split("")
  const models = Object.fromEntries(ids.map(id => [id, id === "A" ? { provider: { npm: "@ai-sdk/openai" } } : {}]))
  const result = await discover({ models, options: { baseURL, apiKey: key } }, ids, signal,
    (_, advertised, id, source, __, eligible) => reports.push([id, source, advertised, eligible]))
  assert.deepEqual(Object.fromEntries(result), { C: { ultra } })
  assert.deepEqual(reports, ids.map(id => [id, "list", id === "C", id === "A" || id === "B"]))
  assert.deepEqual(calls, ["/A", "", ...ids.slice(1).map(id => "/" + id)].map(s => ["GET", "/proxy/v1/models" + s, `Bearer ${key}`]))
})

test("wrong ID, disabled, prose, conflicting routes and invalid effort lists never consult a more permissive source", async t => {
  const good = row("up", chat, ["ultra"])
  const bodies: unknown[] = [
    row("Up", chat, ["ultra"]), { object: "list", data: [good] }, { ...good, object: "list" },
    { ...good, disabled: true }, { ...good, model_picker_enabled: false }, { ...good, policy: { state: "disabled" } },
    { ...good, capabilities: { ...good.capabilities, reasoning: false } }, { ...good, reasoning_effort: false },
    { ...good, supported_endpoints: [responses] }, { ...good, supported_endpoints: [chat, responses] },
    { ...good, supported_endpoints: [chat, chat] }, { ...good, supported_endpoint_types: ["responses"] },
    { ...good, supported_endpoints: undefined, supported_endpoint_types: ["openai"] },
    { id: "up", name: "Ultra", supported_endpoints: [chat], tags: ["reasoning"], description: "Reasoning low/ultra; default low." },
    { ...good, reasoning_options: [{ type: "effort", values: ["low"] }] },
    { id: "up", supported_endpoints: [chat], reasoning_options: [{ type: "effort", values: ["ultra"], enabled: false }] },
    ...[[], ["low", false], ["low", "Default"], ["ultra", "ULTRA"], ["low", "toString"], ["__proto__"], ["two words"],
      Array(65).fill("ultra")].map(values => row("up", chat, values)),
    { ...good, details: { nested: [{ error: "denied" }] } }, { ...good, success: false },
  ]
  let body: unknown, reads: string[] = []
  const baseURL = await fixture(t, (req, res) => {
    reads.push(req.url!)
    res.end(JSON.stringify(req.url?.endsWith("/up") ? body : { data: [good] }))
  })
  const p = { options: { baseURL, apiKey: key }, models: { up: {} } }
  for (body of bodies) {
    reads = []
    assert.equal((await discover(p, ["up"], signal)).size, 0, JSON.stringify(body))
    assert.deepEqual(reads, ["/proxy/v1/models/up"], "No list, /api/pricing, or generation request")
  }
})

test("a missing detail can corroborate only availability, with an independent authenticated route row and no effort additions", async t => {
  const type = "api_error", code = "model_not_found", request_id = "test-trace"
  const neutral = `The requested model was not found. (request_id: ${request_id})`
  let message = neutral, status = 200, rows: unknown[] = [], reads = 0
  const baseURL = await fixture(t, (req, res) => {
    assert.equal(req.method, 'GET'); assert.equal(req.headers.authorization, `Bearer ${key}`)
    if (req.url?.endsWith('/models')) { reads++; return res.end(JSON.stringify({ object: 'list', data: rows })) }
    res.writeHead(status).end(JSON.stringify({ error: { type, code, message, request_id } }))
  })
  const p = { options: { baseURL, apiKey: key }, models: { up: {} } }
  const available = { id: 'up', supported_endpoint_types: ['openai','responses'] }
  for (const [entries, msg, http, eligible, lists] of [
    [[available], neutral, 200, true, 1], [[available, available], neutral, 200, false, 1],
    [[{ ...available, id: 'other' }], neutral, 200, false, 1], [[{ ...available, supported_endpoint_types: ['responses'] }], neutral, 200, false, 1],
    [[row('up', chat, ['ultra'])], neutral, 200, false, 1], [[available], 'Access denied', 200, false, 0],
    [[available], neutral, 404, false, 0], [[available], neutral, 429, false, 0],
  ] as const) {
    rows = [...entries]; message = msg; status = http; reads = 0
    let offered = false
    const additions = await discover(p, ['up'], signal, (_, adv, __, ___, names, canTest) => {
      assert.equal(adv, false); assert.equal(names, undefined); offered = !!canTest
    }, true)
    assert.deepEqual([offered, reads, additions.size], [eligible, lists, 0])
  }
})

test("a fallback row must be unique, exact, single-route and free of error envelopes", async t => {
  const good = row("up", chat, ["low"])
  let body: unknown
  const baseURL = await fixture(t, (req, res) => {
    if (req.url?.endsWith("/up")) return res.writeHead(404).end("Not Found")
    res.end(JSON.stringify(body))
  })
  const p = { options: { baseURL, apiKey: key }, models: { up: {} } }
  for (body of [ { data: [] }, { data: [good, good] }, { data: [row("UP", chat, ["ultra"])] }, { data: [row("up", responses, ["low"])] },
    { data: [{ ...good, error: {} }] }, { data: [good], details: [{ success: false }] }, { data: [good], success: false },
    { data: [good], has_more: true }, { object: "model", data: [good] }, { id: "up", ...good.capabilities } ]) {
    assert.equal((await discover(p, ["up"], signal)).size, 0, JSON.stringify(body))
  }
})

test("additional protocol tokens establish only availability for the exact requested member", async t => {
  const protocols = ["anthropic", "vendor.v2-beta", "openai"]
  const cases: [string, Record<string, unknown>, boolean][] = [
    ["chat", { supported_endpoint_types: protocols }, true],
    ["responses", { supported_endpoint_types: [...protocols, "responses"] }, true],
    ["responses", { supported_endpoint_types: protocols }, false],
    ["chat", { supported_endpoint_types: protocols, supported_endpoints: [chat] }, true],
    ["chat", { supported_endpoint_types: protocols, supported_endpoints: [responses] }, false],
    ["chat", { supported_endpoint_types: protocols, reasoning: { supported: false } }, false],
    ["chat", { supported_endpoint_types: protocols, supported_endpoints: [chat], capabilities: { supports: { reasoning_effort: ["ultra"] } } }, false],
    ...[null, false, {}, "", "two words", "vendor/path", "OPENAI", "none", "no-openai", "openai-disabled", "x".repeat(65)].map(t =>
      ["chat", { supported_endpoint_types: [...protocols, t] }, false] as [string, Record<string, unknown>, boolean]),
  ]
  let fields: Record<string, unknown> = {}
  const baseURL = await fixture(t, (req, res) => {
    assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${key}`)
    res.end(JSON.stringify(req.url?.endsWith("/models") ? { data: [{ id: remote, ...fields }] } : {}))
  })
  const p = { options: { baseURL, apiKey: key }, models: { chat: { id: remote }, responses: { id: remote, provider: { npm: "@ai-sdk/openai" } } } }
  for (const [id, body, expected] of cases) {
    fields = body
    const reports: unknown[] = []
    const result = await discover(p, [id], signal, (...args) => reports.push(args), true)
    assert.equal(result.size, 0)
    assert.deepEqual(reports, [[true, false, id, "list", undefined, expected]], JSON.stringify(body))
  }
})

test("reasoning.supported_efforts needs one exact remote model, one route and an unqualified list", async t => {
  let body: unknown
  const baseURL = await fixture(t, (_, res) => res.end(JSON.stringify(body)))
  const p = { options: { baseURL, apiKey: key }, models: { alias: { id: remote } } }
  const reasoning = { supported_efforts: ["low", "ultra"], mandatory: true }
  const model = { id: remote, supported_endpoints: [chat], reasoning }
  body = model
  assert.deepEqual((await discover(p, ["alias"], signal)).get("alias"), { low, ultra })
  body = { ...model, reasoning: { supported_efforts: ["none", "high"], mandatory: false } }
  assert.deepEqual((await discover(p, ["alias"], signal)).get("alias"), { none: { reasoningEffort: "none" }, high: { reasoningEffort: "high" } })
  for (body of [ { ...model, id: "alias" }, { ...model, supported_endpoints: [chat, responses] }, { ...model, supported_endpoints: undefined },
    { ...model, capabilities: { supports: { reasoning_effort: ["none"] } } }, { ...model, reasoning_options: [{ type: "effort", values: ["high"] }] },
    ...[{ ...reasoning, supported_efforts: ["NONE", "low"] }, { ...reasoning, supported: false }, { ...reasoning, mandatory: "true" },
      { ...reasoning, supported_efforts: "low, ultra" }, { ...reasoning, enabled: false }, { mandatory: true },
      { supported_efforts: ["ultra", "ULTRA"] }, { supported_efforts: [null, "ultra"] }].map(reasoning => ({ ...model, reasoning })),
  ]) assert.equal((await discover(p, ["alias"], signal)).size, 0, JSON.stringify(body))
})

test("an earlier authenticated list cannot supply a model whose detail is rate-limited", async t => {
  const reads: string[] = [], statuses: unknown[] = []
  const baseURL = await fixture(t, (req, res) => {
    reads.push(req.url!)
    if (req.url?.endsWith("/A")) return res.writeHead(404).end()
    if (req.url?.endsWith("/B")) return res.writeHead(429).end()
    res.end(JSON.stringify({ data: [row("A", chat, ["low"]), row("B", chat, ["ultra"])] }))
  })
  const p = { options: { baseURL, apiKey: key }, models: { A: {}, B: {}, C: {} } }
  const result = await discover(p, ["A", "B", "C"], signal, (_, __, id, source) => statuses.push([id, source]))
  assert.deepEqual(Object.fromEntries(result), { A: { low } })
  assert.deepEqual(reads, ["/proxy/v1/models/A", "/proxy/v1/models", "/proxy/v1/models/B"])
  assert.deepEqual(statuses, [["A", "list"], ["B", "stop"], ["C", "stop"]])
})

test("an HTTP 200 denial, outage or malformed error cannot borrow eligibility from an earlier authenticated list", async t => {
  let body: unknown
  const reads: string[] = [], reports: unknown[] = []
  const baseURL = await fixture(t, (req, res) => {
    reads.push(req.url!)
    if (req.url?.endsWith("/a")) return res.writeHead(405).end()
    res.end(JSON.stringify(req.url?.endsWith("/models") ? { data: ["a", "b"].map(id => ({ id, supported_endpoints: [chat] })) } : body))
  })
  const provider = { models: { a: {}, b: {}, c: {} }, options: { baseURL, apiKey: key } }
  for (body of [
    { error: { type: "api_error", code: "model_not_found", message: "Model not found", request_id: "fixture-1" } },
    { error: { code: "model_disabled", message: "Model not found" } }, { error: { message: "Model not supported" } },
    { error: { code: "rate_limit_exceeded", message: "Endpoint not implemented" } },
    { error: { code: "not_implemented", message: "Forbidden" } }, { error: "Gateway unavailable" },
    { error: { code: ["not_implemented"], message: "Endpoint not implemented" } },
    { error: { type: ["api_error"], message: "Endpoint not implemented" } },
    { error: { code: "not_implemented", message: "Endpoint not implemented" }, denied: true },
  ]) {
    reads.length = reports.length = 0
    assert.equal((await discover(provider, ["a", "b", "c"], signal, (_, __, id, source, ___, eligible) => reports.push([id, source, eligible]))).size, 0)
    assert.deepEqual(reports, [["a", "list", true], ["b", "stop", false], ["c", "stop", false]], JSON.stringify(body))
    assert.deepEqual(reads, ["/proxy/v1/models/a", "/proxy/v1/models", "/proxy/v1/models/b"])
  }
})

test("each key sees only its own exact model detail", async t => {
  const baseURL = await fixture(t, (req, res) => {
    res.end(JSON.stringify(row("same", chat, req.headers.authorization === "Bearer fixture-premium" ? ["ultra"] : ["low"])))
  })
  for (const [apiKey, expected] of [["fixture-premium", { ultra }], ["fixture-basic", { low }]] as const) {
    const p = { options: { baseURL, apiKey }, models: { same: {} } }
    assert.deepEqual((await discover(p, ["same"], signal)).get("same"), expected)
  }
})

test("same model URL never shares an Anthropic credential scheme with a bearer lookup", async t => {
  const requests: unknown[] = []
  const baseURL = await fixture(t, (req, res) => {
    requests.push([req.method, req.url, req.headers["x-api-key"], req.headers["anthropic-version"], req.headers.authorization])
    const id = "tenant/shared"
    res.end(JSON.stringify(req.headers["x-api-key"] ? { type: "model", id, capabilities: { effort: { supported: true,
      low: { supported: true }, high: { supported: false }, ultra: { supported: true } } } } : row(id, chat, ["ultra"])))
  })
  const msg = { id: "tenant/shared", provider: { npm: "@ai-sdk/anthropic" } }
  const p = { options: { baseURL, apiKey: key }, models: { chat: { id: "tenant/shared" }, msg, alias: msg } }
  const result = await discover(p, ["chat", "msg", "alias"], signal)
  assert.deepEqual(Object.fromEntries(result), { chat: { ultra }, msg: { low: { effort: "low" } }, alias: { low: { effort: "low" } } })
  assert.deepEqual(requests, [["GET", "/proxy/v1/models/tenant%2Fshared", undefined, undefined, `Bearer ${key}`],
    ["GET", "/proxy/v1/models/tenant%2Fshared", key, "2023-06-01", undefined]])
})

test("reads are serial; allowed batches are not silently truncated, oversized batches refuse before I/O", async t => {
  const reads: string[] = [], ids = Array.from({ length: 64 }, (_, i) => `m${i}`)
  let active = 0, peak = 0
  const baseURL = await fixture(t, (req, res) => {
    peak = Math.max(++active, peak)
    reads.push(req.url!)
    setImmediate(() => { active--; res.end(JSON.stringify(row(req.url!.split("/").pop()!, chat, ["low"]))) })
  })
  const p = { options: { baseURL, apiKey: key }, models: Object.fromEntries(ids.map(id => [id, {}])) }
  await assert.rejects(discover(p, [...ids, "extra"], signal), RangeError)
  assert.equal(reads.length, 0)
  assert.deepEqual([...(await discover(p, ids, signal)).keys()], ids)
  assert.deepEqual(reads, ids.map(id => `/proxy/v1/models/${id}`))
  assert.equal(peak, 1)
})

test("one provider can reach 16 simultaneous GETs, counting its single shared list and deduplicating aliases", async t => {
  const ids = Array.from({ length: 24 }, (_, i) => `m${i}`)
  for (const [concurrency, expectedPeak] of [[8, 8], [16, 16], [32, 16]]) {
    const calls: string[] = [], waiting = new Map<string, () => void>()
    let active = 0, peak = 0, activeAtList = 0
    const baseURL = await fixture(t, (req, res) => {
      assert.equal(req.method, "GET"); assert.equal(req.headers.authorization, `Bearer ${key}`)
      calls.push(req.url!); peak = Math.max(peak, ++active)
      res.once("finish", () => active--)
      const id = req.url!.split("/").pop()!
      if (id === "models") {
        activeAtList = active
        for (const release of waiting.values()) release()
        return res.end(JSON.stringify({ data: ids.map(id => row(id, chat, ["low"])) }))
      }
      const finish = () => id === "m0" ? res.end(JSON.stringify(row(id, chat, ["ultra"]))) : res.writeHead(404).end()
      if (activeAtList) return finish()
      waiting.set(id, finish)
      // At the full first wave, release just one missing detail. The list must
      // take that slot while every other detail stays open, without a timer.
      if (calls.length === expectedPeak) {
        waiting.get("m1")!()
        waiting.delete("m1")
      }
    })
    const p = { options: { baseURL, apiKey: key }, models: {
      ...Object.fromEntries(ids.map(id => [`local-${id}`, { id }])), alias: { id: "m1" }, responses: { id: "m1", provider: { npm: "@ai-sdk/openai" } },
    } }
    const reports = new Map<string, unknown>()
    const result = await discover(p, [...Object.keys(p.models), "alias"], signal, (found, advertised, id, source) => {
      assert.ok(!reports.has(id)); reports.set(id, [found, advertised, source])
    }, true, concurrency)
    assert.equal(peak, expectedPeak)
    assert.equal(activeAtList, expectedPeak)
    assert.deepEqual(calls.sort(), ["/proxy/v1/models", ...ids.map(id => `/proxy/v1/models/${id}`)].sort())
    assert.deepEqual(result.get("local-m0"), { ultra })
    for (const id of ids.slice(1)) assert.deepEqual(result.get(`local-${id}`), { low })
    assert.deepEqual(result.get("alias"), { low }); assert.equal(result.has("responses"), false)
    assert.equal(reports.size, ids.length + 2); assert.deepEqual(reports.get("local-m0"), [true, true, "detail"])
    assert.deepEqual(reports.get("alias"), [true, true, "list"]); assert.deepEqual(reports.get("responses"), [true, false, "list"])
  }
})

test("at width 16, cancellation, 429 or a failed shared list stops pending aliases and all unstarted groups", async t => {
  const ids = "abcdefghijklmnopqr".split(""), models = {
    ...Object.fromEntries(ids.map(id => [id, { id: id.toUpperCase() }])), alias: { id: "B" },
  }
  for (const mode of ["429", "invalid list", "cancel"] as const) {
    const controller = new AbortController(), calls: string[] = [], pending = new Map<string, ServerResponse>()
    const baseURL = await fixture(t, (req, res) => {
      const name = req.url!.split("/").pop()!
      calls.push(name); pending.set(name, res)
      // Only A may complete successfully; its replacement Q is
      // the signal that A's evidence has already been consumed by the caller.
      if (calls.length === 16) pending.get("A")!.end(JSON.stringify(row("A", chat, ["low"])))
      if (name === "Q") {
        if (mode === "429") pending.get("B")!.writeHead(429, { "retry-after": "60" }).end()
        else {
          pending.get("B")!.writeHead(404).end()
          pending.get("C")!.writeHead(405).end()
        }
      }
      if (name === "models") {
        if (mode === "cancel") controller.abort()
        else res.end('{"data":[],"data":[]}') // invalid even when the duplicate fields agree
      }
    })
    const reports = new Map<string, unknown>()
    const additions = await discover({ models, options: { baseURL, apiKey: key } }, [...ids, "alias"], controller.signal,
      (found, advertised, id, source, names, eligible) => {
        assert.ok(!reports.has(id)); reports.set(id, [found, advertised, source, names, eligible])
      }, true, 16)
    const dispatched = ids.slice(0, 17).map(id => id.toUpperCase())
    assert.deepEqual(calls.sort(), mode === "429" ? dispatched : [...dispatched, "models"], mode)
    assert.deepEqual(reports.get("a"), [true, true, "detail", ["low"], false])
    for (const id of [...ids.slice(1), "alias"]) assert.deepEqual(reports.get(id), [false, false, "stop", undefined, false], id)
    // A hard stop retains completed evidence. External cancellation still
    // invalidates the returned additions, as on the public serial path.
    assert.deepEqual(Object.fromEntries(additions), mode === "cancel" ? {} : { a: { low } })
  }
})

test("unauthenticated, ambiguous auth, transport, model or route never makes a request", async t => {
  let reads = 0
  const baseURL = await fixture(t, (_, res) => { reads++; res.end("{}") })
  const options = { baseURL, apiKey: key }, basic = { options, models: { alias: {} } }
  assert.equal(metadataDestination({ ...basic, options: { baseURL } }, "alias"), `${baseURL}/models/alias`)
  for (const p of [
    { ...basic, options: { baseURL } }, { ...basic, options: { baseURL }, env: ["SECRET"] },
    ...[null, "", "********", "{env:SECRET}", "{file:secret}", "${TOKEN}", "$TOKEN", "%TOKEN%", "with\nnewline"].map(apiKey => ({ ...basic, options: { ...options, apiKey } })),
    ...["file:///tmp/example", "http://example.test", `${baseURL}?token=test`, `${baseURL}#test`, `${baseURL}/../other`, `${baseURL}/%2e`, `${baseURL}/{env:HOST}`, baseURL.replace("://", "://name@")].map(v => ({ ...basic, options: { ...options, baseURL: v } })),
    { ...basic, options: { ...options, headers: { authorization: `Bearer ${key}` } } },
    { ...basic, options: { ...options, queryParams: { tenant: "a" } } }, { ...basic, options: { ...options, authToken: "x" } },
    { ...basic, npm: "another-sdk" }, { ...basic, unusual: true }, { ...basic, blacklist: ["alias"] }, { ...basic, whitelist: ["other"] },
    { ...basic, models: { alias: { id: "other" }, other: { headers: { host: "example.test" } } } },
    ...[{ headers: { "x-api-key": key } }, { options: { model: "other" } }, { provider: { api: baseURL + "/else" } },
      { provider: { origin: baseURL } }, { id: "../other" }, { id: "{env:SECRET}" }, { reasoning: false }, { unusual: true },
    ].map(model => ({ ...basic, models: { alias: model } })),
  ]) assert.equal((await discover(p, ["alias"], signal)).size, 0)
  assert.equal(reads, 0)
})

test("transport failure, rate limits, model-specific denial and nested errors stop the batch without fallback or redirects", async t => {
  let leaks = 0, reads = 0
  const other = await fixture(t, (_, res) => { leaks++; res.end("{}") })
  const handlers: RequestListener[] = [
    (_, res) => res.writeHead(307, { Location: other }).end(), (_, res) => res.writeHead(429, { "retry-after": "0" }).end(),
    (_, res) => res.writeHead(404).end('{"error":{"code":"model_not_found"}}'), (_, res) => res.writeHead(405).end('{"success":false}'),
    (_, res) => res.writeHead(401).end(), (_, res) => res.writeHead(503).end(), (_, res) => res.end("{not json"),
    (_, res) => res.end('{"id":"wrong","id":"a","supported_endpoints":["/chat/completions"],"capabilities":{"supports":{"reasoning_effort":["ultra"]}}}'),
    (_, res) => res.end(JSON.stringify({ ...row("a", chat, ["ultra"]), details: { nested: [{ error: "denied" }] } })),
    (_, res) => { res.write(" ".repeat(4 * 1024 * 1024)); res.end("{}") }, (req) => req.socket.destroy(),
  ]
  const count = handlers.length
  const baseURL = await fixture(t, (req, res) => { reads++; handlers.shift()!(req, res) })
  const p = { options: { baseURL, apiKey: key }, models: { a: {}, b: {} } }
  for (let i = 1; i <= count; i++) {
    const statuses: unknown[] = []
    assert.equal((await discover(p, ["a", "b"], signal, (found, efforts, id, source, names) => statuses.push([id, found, efforts, source, names]))).size, 0)
    assert.equal(reads, i)
    assert.deepEqual(statuses, [["a", false, false, "stop", undefined], ["b", false, false, "stop", undefined]])
  }
  assert.equal(leaks, 0)
})

test("cancellation and hanging detail or fallback reads produce no evidence and no subsequent request", async t => {
  const controller = new AbortController()
  let fallback = false, reads: string[] = []
  const baseURL = await fixture(t, (req, res) => {
    reads.push(req.url!)
    if (fallback && req.url?.endsWith("/a")) return res.writeHead(404).end()
    res.write("{")
    if (!controller.signal.aborted) controller.abort()
  })
  const p = { options: { baseURL, apiKey: key, timeout: 120 }, models: { a: {}, b: {} } }
  assert.equal((await discover(p, ["a", "b"], AbortSignal.abort())).size, 0)
  assert.deepEqual(reads, [])
  for (const active of [controller.signal, signal]) {
    reads = []
    assert.equal((await discover(p, ["a", "b"], active)).size, 0)
    assert.deepEqual(reads, ["/proxy/v1/models/a"])
  }
  reads = []; fallback = true
  assert.equal((await discover(p, ["a", "b"], signal)).size, 0)
  assert.deepEqual(reads, ["/proxy/v1/models/a", "/proxy/v1/models"])
})
