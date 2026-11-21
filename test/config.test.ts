import assert from 'node:assert/strict';
import test from 'node:test';
import { parse } from 'jsonc-parser';
import { analyzeConfig, applyVariants, reconcileOwnership, type ConfigSnapshot } from '../src/config.js';

const empty = analyzeConfig('{}')!.snapshot;
const url = 'https://original.invalid/v1';
const key = 'dummy-original-secret';
const options = { baseURL: url, apiKey: key };
const levels = { low: { reasoningEffort: 'low' }, ultra: { reasoningEffort: 'ultra' } };
const wrap = (model: string) => `{ "provider": { "custom": {"models": {"alias": ${model}}} } }`;
const config = (models: Record<string, unknown>, opts: Record<string, unknown> = options) =>
  JSON.stringify({ provider: { custom: { options: opts, models } } });
function analyze(text: string, prior?: ConfigSnapshot) {
  const result = analyzeConfig(text, prior);
  assert.ok(result);
  return result;
}
const ids = (s: string, p: ConfigSnapshot) => analyze(s, p).candidates.map(c => c.modelID);
function apply(text: string) {
  const c = analyze(text, empty).candidates[0];
  assert.ok(c);
  return applyVariants(text, c, levels);
}

test('rejects invalid, ambiguous, unsafe and excessively deep JSONC before constructing an object', () => {
  for (const text of [
    '/* only a comment */', '{"a":}', 'null', '[]', '{"provider":1}', '{"a":0,"\\u0061":1}',
    '{"unrelated":[{"prototype":1}]}', '{"__PrOtO__":0}', '{"z":{"constructor":{}}}',
    '{"n":1e999}', '{"x":' + '['.repeat(300) + '3' + ']'.repeat(300) + '}',
  ]) assert.equal(analyzeConfig(text), undefined, text.slice(0, 80));
  assert.ok(analyzeConfig('\uFEFF{// comment\r\n"provider":{},}'));
});

test('only first additions after baseline produce candidates; edits, retries and re-adds never do', () => {
  const base = analyze(config({ existing: {} }));
  assert.deepEqual(base.candidates, []);
  assert.ok(!JSON.stringify(base.snapshot).includes(key));
  assert.ok(!JSON.stringify(base.snapshot).includes(url));
  const text = config({ existing: { name: 'rename' }, alias: { id: 'opaque' } });
  const next = analyze(text, base.snapshot);
  assert.deepEqual(next.candidates.map(c => c.modelID), ['alias']);
  assert.deepEqual(next.candidates[0].model, Object.assign(Object.create(null), { id: 'opaque' }));
  const patched = applyVariants(text, next.candidates[0], levels);
  assert.deepEqual(ids(patched.text, next.snapshot), []);
  assert.deepEqual(ids(text, next.snapshot), []); // user removed the entire generated map
  const deleted = analyze(config({}), next.snapshot);
  assert.deepEqual(ids(text, deleted.snapshot), []);
  const withoutProvider = analyze('{}', deleted.snapshot);
  assert.deepEqual(ids(config({ newID: {} }), withoutProvider.snapshot), []);
});

test('records disabled/malformed model IDs and never queries them upon repair or re-enable', () => {
  const s = JSON.stringify({ disabled_providers: ['custom'], provider: { custom: { options, models: { a: {} } } } });
  const off = analyze(s, empty);
  assert.deepEqual(off.candidates, []);
  assert.deepEqual(ids(config({ a: {}, b: null, c: { reasoning: false }, d: { variants: false }, e: {} }), off.snapshot), ['e']);
  for (const cfg of [
    { enabled_providers: [], provider: { custom: { options, models: { a: {} } } } },
    { plugin: ['overrides'], provider: { custom: { options, models: { a: {} } } } },
    { provider: { custom: { options, blacklist: ['a'], models: { a: {} } } } },
    { provider: { custom: { options, whitelist: [], models: { a: {} } } } },
    { provider: { custom: { options, models: { a: { options: { forceReasoning: false } } } } } },
  ]) assert.deepEqual(ids(JSON.stringify(cfg), empty), []);
});

test('lifetime binding survives rename/delete/restart and burns a retained key at a changed destination', () => {
  const base = analyze(config({ a: {} })).snapshot;
  const retarget = { ...options, baseURL: 'https://changed.invalid/v1' };
  const changed = analyze(config({ b: {} }, retarget), base);
  assert.deepEqual(changed.candidates, []);
  assert.deepEqual(ids(config({ b: {}, c: {} }, retarget), changed.snapshot), []);
  const removed = analyze('{}', base);
  const readd = analyze(config({ d: {} }, retarget), JSON.parse(JSON.stringify(removed.snapshot)));
  assert.deepEqual(readd.candidates, []);
  assert.deepEqual(ids(config({ e: {} }, retarget), readd.snapshot), []);
  const renamed = JSON.stringify({ provider: { other: { options: retarget, models: { f: {} } } } });
  assert.deepEqual(ids(renamed, removed.snapshot), []);
  const two = { provider: { first: { options, models: { a: {} } }, second: { options: retarget, models: { b: {} } } } };
  assert.deepEqual(ids(JSON.stringify(two), empty), []); // independent of object order
  const rotated = { ...retarget, apiKey: 'another-dummy-key' };
  const rotation = analyze(config({ g: {} }, rotated), readd.snapshot);
  assert.deepEqual(rotation.candidates, []);
  assert.deepEqual(ids(config({ h: {} }, rotated), rotation.snapshot), ['h']);
  assert.deepEqual(ids(config({ withConsent: {} }, { baseURL: url }), empty), ['withConsent']);
});

test('exact round-trip across BOM, CRLF, tabs, empty/manual containers, comments and trailing commas', () => {
  for (const model of [
    '{}', '{ }', '{"name":"x"}', '{ "name": "x", }', '{ /* before */ }',
    '{\r\n\t// outside\r\n\t"name": "x", // original trailing comma\r\n}',
    '{ "variants": {} }', '{ "variants": { } }', '{ "variants": {\r\n\t// empty by design\r\n} }',
    '{ "variants": { "manual":{"keep":true} /* block, comma */, } }',
    '{ "variants": { "manual":{"keep":true} /* block, comma */ } }',
    '{ "variants": { "manual":{}, // user comment\n} }',
    '{\r\n\t"variants": {\r\n\t\t"high": { "disabled": true }, // keep,\r\n\t},\r\n}',
  ]) {
    const text = '\uFEFF' + wrap(model);
    const patch = apply(text);
    assert.deepEqual(patch.ownership.map(e => e.level), ['low', 'ultra']);
    const comment = model.match(/\/\/ [^\r\n]*|\/\*[^*]*\*\//)?.[0];
    if (comment) assert.ok(patch.text.indexOf(comment) < patch.text.indexOf('"low"'), 'do not attach an existing comment to a generated row');
    assert.deepEqual(reconcileOwnership(patch.text, patch.ownership).ownership, patch.ownership);
    assert.deepEqual(reconcileOwnership(patch.text, patch.ownership, true), { text, ownership: [] }, model);
  }
});

test('never replace, own, or roll back a preexisting manual/disabled key, even for different casing', () => {
  const text = wrap('{ "variants": { "LOW": {"disabled":true}, "manual": {"effort":"user"} } }');
  const patch = apply(text);
  assert.deepEqual(patch.ownership.map(e => e.level), ['ultra']);
  assert.equal(reconcileOwnership(patch.text, patch.ownership, true).text, text);
  const candidate = analyze(text, empty).candidates[0];
  const invalid: Record<string, Record<string, unknown>>[] = [{ default: { effort: 'default' } }, { x: { effort: 'y' } }, { x: { apiKey: key } }];
  for (const value of invalid) {
    assert.equal(applyVariants(text, candidate, value).text, text);
  }
});

test('one new variant preserves exact stock and manual payloads; a stock-only result needs no config', () => {
  const stock = {low:{reasoningEffort:'low'}, medium:{reasoningEffort:'medium'}, high:{thinking:{type:'adaptive'},effort:'high'}}
  const clean = wrap('{}')
  assert.equal(applyVariants(clean, analyze(clean, empty).candidates[0], {low: stock.low}, stock).text, clean)
  const text = wrap('{ "variants": { "LOW": {"temperature":0.5}, "medium": {"disabled":true} } }')
  const patch = applyVariants(text, analyze(text, empty).candidates[0], {ultra:{reasoningEffort:'ultra'}}, stock)
  assert.deepEqual(parse(patch.text).provider.custom.models.alias.variants, {LOW:{temperature:0.5},medium:{disabled:true},high:stock.high,ultra:{reasoningEffort:'ultra'}})
  assert.deepEqual(patch.ownership.map(r => [r.level, r.evidence]), [['high','kilo-default'],['ultra','gateway-model']])
  assert.equal(reconcileOwnership(patch.text, patch.ownership, true).text, text)
});

test('selective rollback leaves edited values, user deletions, and newly authored keys alone', () => {
  const patch = apply(wrap('{ "name": "alias" }'));
  const data = parse(patch.text);
  const map = data.provider.custom.models.alias.variants;
  map.low = { reasoningEffort: 'my-low' };
  map.manual = { disabled: true };
  const edited = patch.text.replace('{"reasoningEffort":"low"}', '{"reasoningEffort":"my-low"}')
    .replace('"ultra":', '"manual": {"disabled":true}, /* my,comment */ "ultra":');
  const reconciled = reconcileOwnership(edited, patch.ownership);
  assert.deepEqual(reconciled.ownership.map(e => e.level), ['ultra']);
  const removed = reconcileOwnership(edited, reconciled.ownership, true);
  assert.ok(removed.text.includes('/* my,comment */'));
  delete map.ultra;
  assert.deepEqual(parse(removed.text), data);

  const noRows = wrap('{ "name": "alias", "variants": {} }');
  const forgotten = reconcileOwnership(noRows, patch.ownership);
  assert.deepEqual(forgotten, { text: noRows, ownership: [] });
  assert.equal(reconcileOwnership(patch.text, forgotten.ownership, true).text, patch.text);
  const malformed = reconcileOwnership('{', patch.ownership, true);
  assert.deepEqual(malformed, { text: '{', ownership: patch.ownership });
});

test('relinquishes user-formatted rows, retargeted credentials, base URLs, model aliases and disabled providers', () => {
  const text = config({ alias: { id: 'remote-A' } });
  const patch = apply(text);
  for (const changed of [patch.text.replace(key, 'other-key'), patch.text.replace(url, url + '/new'),
    patch.text.replace('remote-A', 'remote-B'), patch.text.replace('{', '{"disabled_providers":["custom"],')]) {
    assert.deepEqual(reconcileOwnership(changed, patch.ownership, true), { text: changed, ownership: [] });
  }
  const protectedText = patch.text.replace('{"reasoningEffort":"low"}', '{ /* selected manually */ "reasoningEffort": "low"}');
  const changed = reconcileOwnership(protectedText, patch.ownership, true);
  assert.ok(changed.text.includes('/* selected manually */'));
  assert.ok(!changed.text.includes('ultra'));
  const before = analyze(text, empty).candidates[0];
  assert.equal(applyVariants(text.replace('remote-A', 'remote-B'), before, levels).ownership.length, 0);
  const withManual = wrap('{"variants":{"high":{}}}');
  assert.equal(applyVariants(wrap('{}'), analyze(withManual, empty).candidates[0], levels).ownership.length, 0);
});
