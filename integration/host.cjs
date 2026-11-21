const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { parse, modify, applyEdits } = require('jsonc-parser');
const vscode = require('vscode');
const fixture = require('./fixture.cjs');
const ui = require('./menu.cjs');
const pkg = require('../package.json');

exports.run = async () => {
  const root = process.env.VARIANT_TEST_ROOT;
  assert(root && path.basename(root).startsWith('variant-companion-'));
  assert.equal(process.env.XDG_CONFIG_HOME, path.join(root, 'home/.config'));
  assert.equal(process.env.XDG_DATA_HOME, path.join(root, 'data'));
  assert.equal(path.relative(path.join(root, 'workspace'), vscode.workspace.workspaceFolders[0].uri.fsPath), '');
  const file = path.join(root, 'home/.config/kilo/kilo.jsonc');
  const read = () => fs.readFile(file, 'utf8');
  const stage = process.env.FIXTURE_STAGE;
  const out = { stage, vscode: vscode.version };
  let browser;
  try {
    const kilo = vscode.extensions.getExtension('kilocode.kilo-code');
    const companion = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.equal(kilo?.packageJSON.version, '7.8.32');
    assert.equal(companion?.packageJSON.version, pkg.version);
    for (const extension of [kilo, companion]) assert.equal(path.dirname(extension.extensionPath), path.join(root, 'extensions'));
    const deadline = Date.now() + 25000;
    while (!kilo.isActive || !companion.isActive || !vscode.window.state.focused) {
      assert(Date.now() < deadline, 'Expected both extensions to activate in the focused test window');
      await delay(100);
    }
    const connection = await ui.connect(root);
    browser = connection.browser;
    const { page } = connection;
    const baseline = fixture.config(Number(process.env.FIXTURE_PORT));
    const stock = ['Default', 'Low', 'Medium', 'High'];
    const after = structuredClone(baseline.provider);
    Object.assign(after.fixture.models['sample-reasoner'].variants, { low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' }, high: { reasoningEffort: 'high' }, ultra: { reasoningEffort: 'ultra' } });
    if (stage === 'restart') {
      after.fixture.models.later = { name: 'Later' };
      assert.deepEqual(parse(await read()).provider, after);
      out.menu = await ui.rows(vscode, page, [...stock, 'Ultra']);
    } else {
      assert.equal(stage, 'setup');
      assert.deepEqual(parse(await read()).provider, baseline.provider);
      out.menu = await ui.rows(vscode, page, stock);
      await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
      await page.bringToFront();
      const before = await read();
      for (const choice of ['Escape', 'No checks']) {
        const finish = await ui.pick(vscode, page, choice);
        await finish();
        assert.equal(await read(), before, `${choice} changed the configuration`);
      }
      const finish = await ui.pick(vscode, page, 'fixture');
      await fs.writeFile(path.join(root, 'phase'), 'checking');
      out.approvedAt = await ui.approve(vscode, page, baseline.provider.fixture.options.baseURL);
      await finish();
      await fs.writeFile(path.join(root, 'phase'), 'after-check');
      const saved = await read();
      assert.deepEqual(parse(saved).provider, after, 'Expected only the selected reasoning model to gain rows');
      // A one-time check must not subscribe to later model additions.
      await fs.writeFile(file, applyEdits(saved, modify(saved, ['provider', 'fixture', 'models', 'later'], { name: 'Later' }, {})));
      await delay(1000);
      const cancel = await ui.pick(vscode, page, 'Escape');
      await cancel(); // Drain preceding file watcher work before restart.
      out.noChecks = ['Escape', 'No checks'];
    }
    const ledger = path.join(root, `profile/User/globalStorage/${pkg.publisher}.${pkg.name}/spend-v1`);
    const entries = await fs.readdir(ledger).catch(e => { if (e.code !== 'ENOENT') throw e; return []; });
    assert(!entries.some(n => /^(?:grant|post)\./.test(n)), 'Metadata-only check created a paid grant or reservation');
  } catch (e) {
    out.error = String(e.stack || e).replaceAll(fixture.key(root), '[redacted]').replaceAll(fixture.key(root, true), '[redacted]');
  } finally {
    await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(out));
    try { if (browser) await browser.close(); }
    finally { await vscode.commands.executeCommand('workbench.action.quit'); }
  }
};
