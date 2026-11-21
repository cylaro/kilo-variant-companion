import { createHash } from 'node:crypto';
import { findNodeAtLocation, getNodeValue, parseTree, type Node, type ParseError } from 'jsonc-parser';

type Obj = Record<string, unknown>;
type History = { id: string; present: boolean; identity: string; models: string[] };

/** Per-file, persistent history. Absence is not evidence that an ID or a key is new. */
export interface ConfigSnapshot {
  version: 1;
  providers: History[];
  // Hash of literal credential -> hash of destination; null permanently means ambiguous.
  bindings: [string, string | null][];
}

/** Event-local: unlike the snapshot and ownership records, this CAN contain secrets. */
export interface Candidate {
  providerID: string;
  modelID: string;
  provider: Obj;
  model: Obj;
  context: string;
  stockLevels?: ReadonlySet<string>;
}

export interface Ownership {
  evidence?: 'gateway-model' | 'gateway-accepted' | 'kilo-default';
  providerID: string;
  modelID: string;
  level: string;
  context: string;
  row: string; // hash of exact property source, including its value
  wrapper?: string; // hash of variants property, only if we created it
}

interface Patch { text: string; ownership: Ownership[] }
const unsafe = new Set(['prototype', ...Object.getOwnPropertyNames(Object.prototype)].map(k => k.toLowerCase()));
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function digest(v: unknown) {
  return hash(JSON.stringify(v, (_key, value: unknown) => obj(value)
    ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value));
}

function safe(node: Node, depth = 0): boolean {
  if (depth > 128 || (node.type === 'number' && !Number.isFinite(node.value))) return false;
  if (node.type === 'object') {
    const keys = new Set<string>();
    return (node.children ?? []).every(p => {
      const k: string = p.children![0].value;
      if (unsafe.has(k.toLowerCase()) || keys.has(k)) return false;
      keys.add(k);
      return safe(p.children![1], depth + 1);
    });
  }
  return (node.children ?? []).every(n => safe(n, depth + 1));
}

function document(text: string) {
  try {
    const errors: ParseError[] = [];
    const root = parseTree(text.replace(/^\uFEFF/, ' '), errors, { allowTrailingComma: true });
    if (!root || errors.length || root.type !== 'object' || !safe(root)) return;
    const config: Obj = getNodeValue(root);
    if (config.provider !== undefined && !obj(config.provider)) return;
    return { config, root };
  } catch { return undefined; } // parseTree is recursive on untrusted input.
}

function permits(list: unknown, id: string, allow: boolean) {
  return list === undefined || (Array.isArray(list) && list.every(k => typeof k === 'string') && list.includes(id) === allow);
}

function enabled(config: Obj, p: string, m: string, provider: Obj, model: Obj) {
  return (config.plugin === undefined || (Array.isArray(config.plugin) && !config.plugin.length)) &&
    /^[\w.@~-]{1,128}$/.test(p) && /^[\w.:@~/-]{1,512}$/.test(m) &&
    !provider.disabled && !model.disabled && model.reasoning !== false &&
    (!obj(model.options) || model.options.forceReasoning !== false) &&
    (model.variants === undefined || obj(model.variants)) &&
    permits(config.enabled_providers, p, true) && permits(config.disabled_providers, p, false) &&
    permits(provider.whitelist, m, true) && permits(provider.blacklist, m, false);
}

function providerHash(provider: Obj) {
  const { models: _, ...rest } = provider;
  return digest(rest);
}

function modelContext(config: Obj, identity: string, model: Obj) {
  const { variants: _, ...rest } = model;
  return digest([identity, rest, config.plugin, config.enabled_providers, config.disabled_providers]);
}

export function analyzeConfig(text: string, prior?: ConfigSnapshot, existing = false): { snapshot: ConfigSnapshot; candidates: Candidate[]; defaultModel?: string } | undefined {
  const doc = document(text);
  if (!doc || (prior && prior.version !== 1)) return;
  const { config } = doc;
  const providers = Object.entries(config.provider ?? {}) as [string, unknown][];
  const before = new Map(prior?.providers.map(p => [p.id, p]));
  const history = new Map([...before].map(([id, p]) => [id, { ...p, present: false }]));
  const bindings = new Map(prior?.bindings);
  const auth = new Map<string, string>();
  // Bind every observed literal key, even on disabled providers or those without
  // models. Use two passes so order cannot authorize two competing destinations.
  for (const [id, provider] of providers) {
    if (!obj(provider) || !obj(provider.options) || typeof provider.options.apiKey !== 'string' || !provider.options.apiKey) continue;
    const key = digest(['credential', provider.options.apiKey]);
    const dest = digest([provider.options.baseURL, provider.api, provider.npm]);
    bindings.set(key, !bindings.has(key) || bindings.get(key) === dest ? dest : null);
    auth.set(id, key);
  }
  const candidates: Candidate[] = [];
  for (const [providerID, raw] of providers) {
    const old = before.get(providerID);
    const provider = obj(raw) ? raw : {};
    const models = obj(provider.models) ? provider.models : {};
    const identity = providerHash(provider);
    const seen = new Set(old?.models);
    const key = auth.get(providerID);
    const eligible = prior && (!old || (old.present && old.identity === identity)) && (!key || bindings.get(key) !== null);
    for (const [modelID, model] of Object.entries(models)) {
      if (eligible && (existing || !seen.has(modelID)) && obj(model) && enabled(config, providerID, modelID, provider, model)) {
        candidates.push({ providerID, modelID, provider, model, context: modelContext(config, identity, model) });
      }
      seen.add(modelID);
    }
    history.set(providerID, { id: providerID, present: true, identity, models: [...seen] });
  }
  return { candidates, defaultModel: typeof config.model === 'string' ? config.model : undefined,
    snapshot: { version: 1, providers: [...history.values()], bindings: [...bindings] } };
}

function target(doc: NonNullable<ReturnType<typeof document>>, ref: Pick<Candidate, 'providerID' | 'modelID' | 'context'>) {
  const { providerID, modelID } = ref;
  if (!obj(doc.config.provider)) return;
  const provider = doc.config.provider[providerID];
  if (!obj(provider) || !obj(provider.models)) return;
  const model = provider.models[modelID];
  if (!obj(model) || !enabled(doc.config, providerID, modelID, provider, model) ||
      modelContext(doc.config, providerHash(provider), model) !== ref.context) return;
  return findNodeAtLocation(doc.root, ['provider', providerID, 'models', modelID]);
}

const end = (n: Node) => n.offset + n.length;
const source = (s: string, n: Node) => s.slice(n.offset, end(n));
const property = (n: Node, key: string) => n.children?.find(p => p.children?.[0].value === key);

function layout(text: string, n: Node) {
  const sample = n.children?.[0];
  const indent = (offset: number) => text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset).match(/^[\t ]*/)?.[0] ?? '';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const gap = sample ? text.slice(n.offset + 1, sample.offset) : source(text, n);
  const unit = text.match(/\n([\t ]+)"/)?.[1] ?? '  ';
  return gap.includes('\n') ? eol + (sample ? indent(sample.offset) : indent(n.offset) + unit) : (sample || /\s/.test(gap) ? ' ' : '');
}

// Insert without reformatting any preexisting token. All surrounding whitespace,
// comments and trailing commas remain in the document; manual row order is stable.
function append(text: string, parent: Node, fields: string[]) {
  const last = parent.children?.at(-1);
  const at = last ? end(last) : parent.offset + 1;
  const gap = layout(text, parent);
  // A trailing comment belongs to the previous row (or to the empty object),
  // not to the newly inserted last row. Keep it where the user put it.
  const tail = text.slice(at, end(parent) - 1);
  const comment = [...tail.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g)].at(-1);
  if (comment) {
    const separator = comma(tail);
    const cut = at + Math.max(comment.index! + comment[0].length, (separator ?? -1) + 1);
    const padding = comment[0].startsWith('//') && !gap.includes('\n')
      ? (text.includes('\r\n') ? '\r\n' : '\n') + gap : gap;
    return text.slice(0, at) + (last && separator === undefined ? ',' : '') + text.slice(at, cut) +
      padding + fields.join(',' + padding) + (separator === undefined ? '' : ',') + text.slice(cut);
  }
  return text.slice(0, at) + (last ? ',' : '') + gap + fields.join(',' + gap) + text.slice(at);
}

export function validLevel(level: string) {
  return /^[a-z][a-z0-9_-]{0,31}$/i.test(level) && !unsafe.has(level.toLowerCase()) && !['default', 'provider-default'].includes(level.toLowerCase());
}

export function applyVariants(text: string, candidate: Candidate, variants: Record<string, Obj>, stock?: Record<string, Obj>): Patch {
  const unchanged = { text, ownership: [] };
  const doc = document(text);
  const model = doc && target(doc, candidate);
  if (!model) return unchanged;
  const container = property(model, 'variants')?.children?.[1];
  // Revalidate the manual map too, so a stale result cannot restore user deletions.
  if (digest([container && getNodeValue(container)]) !== digest([candidate.model.variants])) return unchanged;
  const taken = new Set(container?.children?.map(p => String(p.children![0].value).toLowerCase()));
  const fields: string[] = [];
  const levels: string[] = [];
  // A nonempty map replaces Kilo's menu on compatible transports. Never create
  // it for an already-visible level. For a genuine addition, preserve the exact
  // stock payloads, including nested SDK settings. Manual rows always win.
  if (stock && !container && Object.keys(variants).every(name => Object.hasOwn(stock, name))) return unchanged;
  const defaults = new Set<string>();
  for (const [level, value] of Object.entries({ ...stock, ...variants })) {
    if (!validLevel(level) || taken.has(level.toLowerCase()) || !obj(value)) continue;
    const payload = stock && Object.hasOwn(stock, level) ? stock[level] : value;
    if (stock && Object.hasOwn(stock, level)) defaults.add(level);
    else {
      const keys = Object.keys(value);
      if (keys.length !== 1 || !['effort', 'reasoningEffort'].includes(keys[0]) || value[keys[0]] !== level) continue;
    }
    fields.push(`${JSON.stringify(level)}: ${JSON.stringify(payload)}`);
    levels.push(level);
    taken.add(level.toLowerCase());
  }
  if (!fields.length) return unchanged;
  const updated = container ? append(text, container, fields) : append(text, model, [`"variants": {${fields.join(', ')}}`]);
  const after = document(updated);
  const dest = after && target(after, candidate);
  const wrapper = dest && property(dest, 'variants');
  if (!wrapper) return unchanged;
  const wrapperHash = container ? undefined : hash(source(updated, wrapper));
  const { providerID, modelID, context } = candidate;
  const ownership: Ownership[] = levels.map(level => ({ providerID, modelID, level, context, evidence: defaults.has(level) ? 'kilo-default' : 'gateway-model',
    row: hash(source(updated, property(wrapper.children![1], level)!)), wrapper: wrapperHash }));
  return { text: updated, ownership };
}

// Remove only a property, one separator, and whitespace we inserted. Never
// consume comments, including comments the user placed around an owned row.
function erase(text: string, parent: Node, prop: Node) {
  const children = parent.children!;
  const i = children.indexOf(prop);
  const left = i ? end(children[i - 1]) : parent.offset + 1;
  const right = children[i + 1]?.offset ?? end(parent) - 1;
  const prefix = text.slice(left, prop.offset);
  const suffix = text.slice(end(prop), right);
  const gap = layout(text, parent);
  // Ignore commas inside comments, not just whitespace around a separator.
  const before = comma(prefix);
  const after = comma(suffix);
  let start = prop.offset;
  const lineGap = /\/\/[^\r\n]*(\r?\n[\t ]*)$/.exec(prefix)?.[1];
  if (lineGap) start -= lineGap.length;
  else if (gap && prefix.endsWith(gap)) start -= gap.length;
  let head = text.slice(0, start);
  let tail = text.slice(end(prop));
  if (after !== undefined && (before === undefined || prefix.includes('/'))) tail = tail.slice(0, after) + tail.slice(after + 1);
  else if (before !== undefined) head = head.slice(0, left + before) + head.slice(left + before + 1);
  return head + tail;
}

function comma(trivia: string) {
  // Trivia between DOM properties consists solely of whitespace, comments and at most one comma.
  return [...trivia.matchAll(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|,/g)].find(m => m[0] === ',')?.index;
}

export function reconcileOwnership(text: string, entries: readonly Ownership[], remove = false): Patch {
  let doc = document(text);
  if (!doc) return { text, ownership: [...entries] };
  const groups = new Map<string, Ownership[]>();
  for (const entry of entries) {
    const id = JSON.stringify([entry.providerID, entry.modelID]);
    const group = groups.get(id) ?? [];
    group.push(entry);
    groups.set(id, group);
  }
  const kept: Ownership[] = [];
  for (const group of groups.values()) {
    const model = target(doc, group[0]);
    const wrapper = model && property(model, 'variants');
    if (!wrapper || !model) continue;
    const map = wrapper.children![1];
    const rows = group.filter(entry => {
      const row = property(map, entry.level);
      return entry.context === group[0].context && row && hash(source(text, row)) === entry.row;
    });
    if (!remove) { kept.push(...rows); continue; }
    if (!rows.length) continue;
    const whole = new Set(rows.map(e => e.level)).size === map.children?.length && rows.every(e => e.wrapper === hash(source(text, wrapper)));
    let next = text;
    if (whole) next = erase(text, model, wrapper);
    else {
      // Each removal changes following offsets. Reparse; a preceding comma may
      // now belong to the next sibling. Never use stale ranges to erase a row.
      for (const entry of rows) {
        const current = document(next);
        const dest = current && target(current, entry);
        const parent = dest && property(dest, 'variants')?.children?.[1];
        const row = parent && property(parent, entry.level);
        if (row && parent && hash(source(next, row)) === entry.row) next = erase(next, parent, row);
      }
    }
    const checked = document(next);
    if (!checked) { kept.push(...rows); continue; }
    text = next;
    doc = checked;
  }
  return { text, ownership: kept };
}
