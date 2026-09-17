import { isTauri, rpc } from './transport'

/** Explicit user download/save action; independent of Agent workspace authorization. */
export async function saveMarkdownReport(content: string): Promise<void> {
  const filename = `catio-report-${new Date().toISOString().slice(0, 10)}.md`
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog')
    const path = await save({ defaultPath: filename, filters: [{ name: 'Markdown', extensions: ['md'] }] })
    if (path) await rpc('export_file', { path, contents: content })
    return
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
