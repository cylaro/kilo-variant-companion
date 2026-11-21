const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

exports.connect = async root => {
  const [port] = (await fs.readFile(path.join(root, 'profile/DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/);
  assert(/^\d+$/.test(port));
  const { chromium } = require(process.env.PLAYWRIGHT_CORE);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 8000 });
  const page = browser.contexts()[0].pages().find(p => p.url().includes('workbench'));
  assert(page, 'Disposable workbench not found');
  return { browser, page };
};

// Inspect Kilo's actual sidebar picker, not a list inferred from the saved variants.
exports.rows = async (vscode, page, expected) => {
  await vscode.commands.executeCommand('kilo-code.SidebarProvider.focus');
  const deadline = Date.now() + 35_000;
  let label;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const model = frame.locator('.model-selector-trigger-label:visible').first();
      if (!await model.count()) continue;
      label = (await model.textContent())?.trim();
      if (!label || label === 'No providers' || !await model.isEnabled()) continue;
      if (label !== 'Sample Reasoner') {
        const choices = frame.locator('.model-selector-item:visible');
        const sample = choices.filter({ hasText: 'Sample Reasoner' }).first();
        if (await sample.count()) await sample.click({ timeout: 2000 });
        else if (!await choices.count()) await model.click({ timeout: 2000 });
        continue;
      }
      const trigger = frame.locator('button:visible').filter({ has: frame.locator('.thinking-selector-trigger-label') }).first();
      if (!await trigger.count()) continue;
      await trigger.press('Enter', { timeout: 3000 });
      const options = frame.locator('.thinking-selector-list [role=option]');
      await options.first().waitFor({ timeout: 3000 });
      const rows = (await options.allTextContents()).map(s => s.trim());
      assert.deepEqual([...rows].sort(), [...expected].sort(), `Native thinking menu for ${label}`);
      await options.first().press('Escape');
      return rows;
    }
    await delay(200);
  }
  throw Error(`No native thinking menu for Sample Reasoner; last model: ${label || '(none)'}`);
};

exports.pick = async (vscode, page, choice) => {
  const command = vscode.commands.executeCommand('kiloVariantCompanion.checkProvider');
  const widget = page.locator('.quick-input-widget:visible');
  const items = widget.locator('.quick-input-list .monaco-list-row');
  await widget.getByText('Check one provider (metadata only)', { exact: true }).waitFor({ timeout: 16000 });
  await items.filter({ hasText: 'unselected' }).waitFor();
  const labels = await items.evaluateAll(nodes => nodes.map(n => n.getAttribute('aria-label')));
  assert.deepEqual(labels, ['No checks', 'fixture', 'unselected']);
  const input = widget.locator('input');
  if (choice === 'Escape') await input.press('Escape');
  else {
    await input.fill(choice);
    await widget.locator(`.quick-input-list .monaco-list-row.focused[aria-label="${choice}"]`).waitFor({ timeout: 12000 });
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
  }
  return async () => {
    await Promise.race([command, delay(45000, undefined, { ref: false }).then(() => { throw Error('Provider check did not finish'); })]);
    await widget.waitFor({ state: 'hidden', timeout: 12000 });
  };
};

exports.approve = async (vscode, page, base) => {
  const name = 'Allow for this address';
  const action = page.getByRole('button', { name, exact: true }).filter({ visible: true }).first();
  if (!await action.waitFor({ timeout: 1800 }).then(() => true, () => false)) {
    await vscode.commands.executeCommand('notifications.showList');
    await action.waitFor({ timeout: 15000 });
  }
  const notice = page.locator('.notification-list-item:visible, .monaco-dialog-box:visible').filter({ has: page.getByRole('button', { name, exact: true }) }).first();
  const text = await notice.innerText();
  for (const term of ['fixture', base]) assert(text.includes(term), `Missing consent scope: ${term}`);
  assert.equal(await notice.getByRole('button', { name: /allow .*requests/i }).count(), 0, 'Manual check offered a paid grant');
  await action.evaluate(el => {
    el.addEventListener('click', event => { if (event.isTrusted) window.__fixtureApproval = Date.now(); }, { capture: true, once: true });
  });
  await action.click();
  const at = await page.evaluate(() => window.__fixtureApproval);
  assert(Number.isSafeInteger(at), 'Missing trusted renderer click');
  return at;
};
