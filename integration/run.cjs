// Run from the checkout with a local playwright-core and the freshly built VSIX (see README).
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fixture = require('./fixture.cjs');
const pkg = require('../package.json');

function environment(root) {
  const dir = name => path.join(root, name);
  const blocked = 'http://127.0.0.1:1';
  // Allowlist, never spread process.env: no real credentials, profiles, IPC handles or CLI overrides.
  const env = {};
  for (const name of ['SystemRoot', 'windir', 'Path', 'ComSpec', 'PATHEXT', 'SystemDrive', 'ProgramFiles', 'ProgramFiles(x86)', 'CommonProgramFiles', 'PROCESSOR_ARCHITECTURE']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return { ...env, HOME: dir('home'), USERPROFILE: dir('home'), HOMEDRIVE: root.slice(0, 2), HOMEPATH: dir('home').slice(2),
    APPDATA: dir('roaming'), LOCALAPPDATA: dir('local'), ProgramData: dir('managed'), ALLUSERSPROFILE: dir('managed'),
    USERNAME: 'fixture', USERDOMAIN: 'fixture', LOGONSERVER: 'fixture', USERDNSDOMAIN: 'fixture',
    TEMP: dir('tmp'), TMP: dir('tmp'), TMPDIR: dir('tmp'), XDG_CONFIG_HOME: dir('home/.config'),
    XDG_DATA_HOME: dir('data'), XDG_STATE_HOME: dir('state'), XDG_CACHE_HOME: dir('cache'),
    KILO_TEST_HOME: dir('home'), KILO_TEST_MANAGED_CONFIG_DIR: dir('managed'), KILO_DISABLE_MODELS_FETCH: 'true',
    KILO_DISABLE_DEFAULT_PLUGINS: 'true', KILO_DISABLE_AUTOUPDATE: 'true', KILO_DISABLE_EXTERNAL_SKILLS: 'true',
    KILO_DISABLE_LSP_DOWNLOAD: 'true', KILO_DISABLE_CLAUDE_CODE: 'true', KILO_DISABLE_SHARE: 'true',
    KILO_API_URL: blocked, KILO_AI_GATEWAY_URL: blocked, KILO_TELEMETRY_LEVEL: 'off', DO_NOT_TRACK: '1',
    HTTP_PROXY: blocked, HTTPS_PROXY: blocked, ALL_PROXY: blocked, NO_PROXY: '127.0.0.1,localhost,::1', NODE_USE_ENV_PROXY: '1',
    NPM_CONFIG_OFFLINE: 'true', GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_NOSYSTEM: '1',
    PLAYWRIGHT_CORE: require.resolve(path.resolve(process.env.PLAYWRIGHT_CORE)), VARIANT_TEST_ROOT: root };
}

async function workbench(binary, root, env, stage) {
  const file = name => path.join(root, name);
  await fs.writeFile(file('phase'), stage);
  await fs.rm(file('evidence.json'), { force: true });
  const args = [`--user-data-dir=${file('profile')}`, `--extensions-dir=${file('extensions')}`, '--new-window', '--locale=en',
    '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--disable-sync', '--disable-background-networking',
    '--proxy-server=http://127.0.0.1:1', '--use-inmemory-secretstorage', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', file('workspace')];
  const child = spawn(binary, args, { cwd: file('workspace'), env: { ...env, FIXTURE_STAGE: stage }, stdio: 'ignore', windowsHide: true });
  const timeout = setTimeout(() => child.kill(), 150_000);
  try {
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, `VS Code failed or timed out in ${stage}`);
    const text = await fs.readFile(file('evidence.json'), 'utf8');
    assert(![fixture.key(root), fixture.key(root, true)].some(key => text.includes(key)), 'Key appeared in evidence');
    const result = JSON.parse(text);
    if (result.error) throw Error(`${stage}: ${result.error}`);
    assert.equal(result.stage, stage);
    console.log(`${stage}:`, result);
    return result;
  } finally { clearTimeout(timeout); }
}

async function main() {
  assert.equal(process.argv.length, 5, 'Usage: node integration/run.cjs <Code.exe> <official Kilo extension directory> <built companion VSIX>');
  assert(process.platform === 'win32' && process.arch === 'x64', 'The stock resolver requires Windows x64');
  assert(process.env.PLAYWRIGHT_CORE, 'Set PLAYWRIGHT_CORE to a local playwright-core package directory');
  const [binary, official, vsix] = await Promise.all(process.argv.slice(2).map(p => fs.realpath(p)));
  assert.equal(path.basename(binary).toLowerCase(), 'code.exe');
  // Portable VS Code can ignore --user-data-dir and use its own adjacent profile.
  assert(!await fs.stat(path.join(path.dirname(binary), 'data')).then(() => true, e => { if (e.code !== 'ENOENT') throw e; return false; }), 'Use a non-portable Code.exe');
  const officialDir = 'kilocode.kilo-code-7.8.32-win32-x64';
  assert.equal(path.basename(official).toLowerCase(), officialDir);
  const readManifest = async dir => JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  const manifest = await readManifest(official);
  assert.equal(`${manifest.publisher}.${manifest.name}`, 'kilocode.kilo-code');
  assert.equal(manifest.version, '7.8.32');
  assert.equal(manifest.__metadata?.targetPlatform, 'win32-x64', 'Expected the official Windows x64 extension with installation metadata');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'variant-companion-'));
  const dir = s => path.join(root, s);
  const requests = [], violations = [];
  const server = http.createServer((req, res) => {
    fixture.handle(root, req, res, requests).catch(error => { violations.push(error.message); res.writeHead(403).end(); });
  });
  try {
    const env = environment(root);
    for (const d of ['workspace', 'extensions/fixture.smoke', 'profile/User', 'home/.config/kilo', 'tmp', 'roaming', 'local', 'managed', 'data/kilo', 'cache', 'state']) {
      await fs.mkdir(dir(d), { recursive: true });
    }
    await fs.cp(official, dir(`extensions/${officialDir}`), { recursive: true });
    // Extract only into the disposable extensions directory. Never invoke --install-extension.
    await fs.copyFile(vsix, dir('package.vsix'));
    execFileSync('tar.exe', ['-xf', dir('package.vsix'), '-C', dir('extensions'), 'extension'], { windowsHide: true });
    const release = await readManifest(dir('extensions/extension'));
    assert.equal(`${release.publisher}.${release.name}@${release.version}`, `${pkg.publisher}.${pkg.name}@${pkg.version}`);
    await fs.rename(dir('extensions/extension'), dir(`extensions/${pkg.publisher}.${pkg.name}-${pkg.version}`));
    console.log(`Testing ${pkg.name}@${pkg.version}, VSIX SHA-256:`, createHash('sha256').update(await fs.readFile(dir('package.vsix'))).digest('hex'));

    await fs.writeFile(dir('extensions/fixture.smoke/package.json'), JSON.stringify({ name: 'smoke', publisher: 'fixture', version: '0.0.1',
      engines: { vscode: '^1.105.1' }, main: './driver.cjs', activationEvents: ['onStartupFinished'] }));
    await fs.writeFile(dir('extensions/fixture.smoke/driver.cjs'), `exports.activate = () => { setImmediate(() => require(${JSON.stringify(path.join(__dirname, 'host.cjs'))}).run()); };`);
    await fs.writeFile(dir('profile/User/settings.json'), JSON.stringify({ 'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false,
      'update.mode': 'none', 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none', 'window.dialogStyle': 'custom', 'git.enabled': false,
      'kiloVariantCompanion.reloadAfterCheck': false }));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    env.FIXTURE_PORT = String(server.address().port);
    await fs.writeFile(dir('home/.config/kilo/kilo.jsonc'), JSON.stringify(fixture.config(server.address().port), null, 2));
    await fs.writeFile(dir('data/kilo/auth.json'), JSON.stringify({ fixture: { type: 'api', key: fixture.key(root) },
      unselected: { type: 'api', key: fixture.key(root, true) } }));
    const setup = await workbench(binary, root, env, 'setup');
    await workbench(binary, root, env, 'restart');
    assert.deepEqual(violations, [], 'Unexpected loopback traffic');
    assert(Number.isSafeInteger(setup.approvedAt));
    assert(requests.every(r => r.at >= setup.approvedAt), 'Request preceded the trusted address-consent click');
    assert.deepEqual(requests.map(r => r.id).sort(), ['no-efforts', 'sample-reasoner']);
    console.log('PASS: two authenticated metadata GETs after approval; no other fixture requests. Files checked for fixture keys:', await fixture.audit(root));
  } catch (error) {
    console.error('Loopback observations:', { received: requests.map(r => r.id), violations });
    throw error;
  } finally {
    if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await fs.rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
