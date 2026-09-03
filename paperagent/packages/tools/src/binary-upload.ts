import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { workspaceDataPath, type PaperAgentStore } from '@paperagent/domain'
import { validatePdfBytes, validatePdfFileName } from './pdf-upload-validation.ts'

export async function handleBinaryPdfUpload(
  store: PaperAgentStore,
  workspace: string,
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes: number,
  beforeReplace?: (paperId: string) => Promise<void>,
) {
  if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
  const name = req.headers['x-paperagent-file-name']
  if (typeof name !== 'string') throw new Error('only .pdf files can be uploaded')
  validatePdfFileName(name)
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > maxBytes) throw new Error('uploaded PDF exceeds the configured size limit'); chunks.push(bytes) }
  const bytes = Buffer.concat(chunks)
  validatePdfBytes(bytes, maxBytes)
  const temp = workspaceDataPath(workspace, `uploads/${randomUUID()}.pdf`); await mkdir(workspaceDataPath(workspace, 'uploads'), { recursive: true }); await writeFile(temp, bytes, { flag: 'wx' })
  const url = new URL(req.url ?? '/', 'http://localhost'); const paperId = url.searchParams.get('paperId'); const libraryId = req.headers['x-paperagent-library-id']
  try {
    const imported = paperId === null
      ? await store.importPaper({ workspacePath: workspace, sourcePath: temp, originalFileName: name, ...(typeof libraryId === 'string' && libraryId !== '' ? { libraryId } : {}) })
      : { paper: await replacePaperPdf(store, workspace, paperId, temp, name, beforeReplace), duplicate: false }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: imported.paper.id, title: imported.paper.title, duplicate: imported.duplicate, parseStatus: imported.paper.parseStatus }))
  } finally {
    await rm(temp, { force: true })
  }
}

async function replacePaperPdf(
  store: PaperAgentStore,
  workspace: string,
  paperId: string,
  sourcePath: string,
  originalFileName: string,
  beforeReplace?: (paperId: string) => Promise<void>,
) {
  await beforeReplace?.(paperId)
  return store.replacePaperPdf({ workspacePath: workspace, paperId, sourcePath, originalFileName })
}
