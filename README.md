# Kilo Variant Companion

Discover a custom provider's reasoning levels and use them in Kilo's native thinking picker, alongside the choices you already have. Kilo Variant Companion runs in desktop VS Code. It works alongside the official Kilo extension and makes no gateway requests on a fresh install.

## Quick start

1. Install the `.vsix` from [GitHub Releases](https://github.com/cylaro/kilo-variant-companion/releases) using **Extensions: Install from VSIX...** in VS Code. Keep the official Kilo extension installed.
2. Open the Command Palette and run **Kilo Variant Companion: Check Provider (Metadata Only)**. Pick the provider you want to check. If prompted, review its address before authorizing use of its saved key.
3. Open the thinking picker in Kilo. If the gateway advertises an extra level for that model and route, it appears alongside the defaults. The metadata check sends no inference requests.

For example, a gateway might list `low`, `medium`, `high` and `xhigh` for one model, but just `low` and `high` for another. The companion reads each model separately. If a gateway returns only a model ID, you can leave its menu as it is or use **Verify One Reasoning Level** to test a specific value.

## Build and install from source

Use Node.js 24 and npm. From the directory containing `package.json`, run:

```sh
node --version
npm ci
npm test
npm run package
```

The build produces `kilo-variant-companion-0.1.9.vsix`. To install your local build, run `code --install-extension ./kilo-variant-companion-0.1.9.vsix`.

The tested setup is Windows x64 with VS Code 1.147 and Kilo 7.8.32. The companion requires VS Code 1.105.1 or later and a trusted, local workspace. It does not support remote or virtual workspaces.

## Commands and costs

All commands below begin with `Kilo Variant Companion:` in the Command Palette.

| Command | What it does |
| --- | --- |
| Check Provider (Metadata Only) | Checks eligible models for one provider using GET requests, even if you previously approved paid checks. Escape or **No checks** sends nothing. A one-time check does not enable automatic checks. |
| Check Existing Model | Reads metadata for one model. If the gateway gives an explicit list, the command can also remove the companion's unchanged additions that the list no longer includes. |
| Verify One Reasoning Level | Reads metadata first. **Send one request** authorizes a single inference POST for the model, level and endpoint shown. A valid completion means the gateway accepted the value, not that the model applied it. |
| Enable Automatic Checks for One Provider | Checks current models and watches for new ones. Choose **Metadata only** to exclude inference. **Allow 64 requests** permits up to 64 potentially billable POSTs in total for that provider, exact endpoint and key, with no automatic refill. **No checks** stops watching. |
| Disable Automatic Paid Checks | Revokes outstanding automatic grants. It cannot cancel a charge for a request already sent. One-time metadata checks remain available. |
| Remove Unchanged Additions | Removes entries that still match what the companion wrote. Run this in the same VS Code profile **before uninstalling** if you want to undo its changes. |

Metadata checks use the provider's API key to read `GET /models/{id}` under its base URL. If the gateway lacks a model detail endpoint, the companion can read `GET /models` at the same address. Neither GET runs inference.

Each inference POST sends the key, remote model ID, requested effort and the prompt `Reply OK`. It asks for at most 16 output tokens, has a 10-second deadline and does not retry. No check sends chat history, tools or workspace files. A POST can still cost money if it times out or no menu entry changes. The 64-request cap limits calls, not their price. A new grant allows up to eight simultaneous POSTs for one model in a window. Older grants keep their original concurrency and balance.

## What changes locally

The companion watches Kilo's global config files, not your project tree. It edits the model's `variants` there. Kilo 7.8.32 uses an active custom list *instead of* its built-in choices, so the companion first checks which entries it needs to preserve. Your own entries, including `disabled: true`, take precedence. The picker does not distinguish Kilo defaults from levels the gateway advertises or accepts.

Adding levels requires a provider outside Kilo's built-in catalog, a model with `reasoning: true`, and an explicit `@ai-sdk/openai-compatible` adapter. For the defaults, the companion checks the SHA-256 of the official Windows x64 `bin/kilo.exe` against the pin in `src/stock.ts`, then runs it in a temporary profile without credentials. This is not an OS network sandbox. If a Kilo update changes the binary or the companion cannot reproduce the defaults, it skips new additions.

After a check saves changes, VS Code normally reloads the window. The companion waits for clean editors and for tasks and debugging to finish, but cannot detect a running Kilo chat. Set `kiloVariantCompanion.reloadAfterCheck` to `false` to refresh only Kilo's project instead.

## Credentials and permissions

For a key saved by Kilo, the companion asks you to approve the provider's exact base URL before looking up its entry in `auth.json`. It can also use a literal key already in that provider's config. Approve only an address you trust with the key. Requests require verified HTTPS except on loopback and do not follow redirects. The companion skips multiple global configs and unsupported settings such as custom authentication headers.

The companion keeps approvals, request records and fingerprints for undo in the local VS Code profile. It does not store raw keys or response bodies in those records. Uninstalling stops the companion but leaves its saved variants in Kilo's config. To remove them, run **Remove Unchanged Additions** first. It leaves manually edited entries alone.

## Development

`npm test` builds the TypeScript sources and runs the Node test suite. Gateway tests use local HTTP fixtures; you don't need a provider account. To include native stock-menu tests, set `KVC_TEST_KILO_EXTENSION` to the installed Windows x64 Kilo 7.8.32 extension directory. To run the desktop smoke test, point `PLAYWRIGHT_CORE` at a local Playwright Core installation and supply VS Code, Kilo and the VSIX:

```powershell
node integration/run.cjs "<path to Code.exe>" "<path to the Kilo extension>" .\kilo-variant-companion-0.1.9.vsix
```

The smoke test opens a disposable editor profile and checks the native picker against a loopback gateway. It does not install the companion in your usual profile.
