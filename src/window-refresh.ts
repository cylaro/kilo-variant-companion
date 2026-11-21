import * as vscode from 'vscode'

/** In-memory ticket: a fresh host must never reload again because of its own previous write. */
export function afterCheck(ctx: vscode.ExtensionContext, drain: () => Promise<void>) {
  let requested = false, checking = false, disposed = false
  const project = () => {
    if (vscode.extensions.getExtension('kilocode.kilo-code')?.isActive) void vscode.commands.executeCommand('kilo-code.new.reload').then(undefined, () => {})
  }
  const attempt = async () => {
    if (!requested || checking || disposed) return
    checking = true
    try {
      // A file watcher may have already queued a user's second model addition.
      let tail: Promise<void>
      do { tail = drain(); await tail } while (tail !== drain())
      if (!requested || disposed || !vscode.window.state.focused || !vscode.workspace.isTrusted) return
      if (!vscode.workspace.getConfiguration('kiloVariantCompanion').get('reloadAfterCheck', true)) {
        requested = false; project(); return
      }
      if (vscode.workspace.textDocuments.some(d => d.isDirty) || vscode.workspace.notebookDocuments.some(d => d.isDirty) ||
          vscode.debug.activeDebugSession || vscode.tasks.taskExecutions.length) return
      requested = false
      await vscode.commands.executeCommand('workbench.action.reloadWindow')
    } catch { requested = false; if (!disposed) project() } finally { checking = false }
  }
  ctx.subscriptions.push({ dispose: () => { disposed = true } },
    vscode.window.onDidChangeWindowState(attempt), vscode.workspace.onDidSaveTextDocument(attempt),
    vscode.workspace.onDidCloseTextDocument(attempt), vscode.workspace.onDidSaveNotebookDocument(attempt),
    vscode.workspace.onDidCloseNotebookDocument(attempt), vscode.tasks.onDidEndTask(attempt),
    vscode.debug.onDidTerminateDebugSession(attempt), vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('kiloVariantCompanion.reloadAfterCheck')) void attempt()
    }))
  return { request() { requested = true; void attempt() }, project }
}
