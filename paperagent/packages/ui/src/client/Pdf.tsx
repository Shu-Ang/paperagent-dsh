import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { GlobalWorkerOptions, getDocument, type RenderTask } from 'pdfjs-dist/legacy/build/pdf.mjs'
import workerSource from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?raw'
import type { PaperAgentApi } from './api-types.ts'
import type { MainViewProps } from './Views.tsx'
import { errorMessage } from './ui-utils.ts'
import css from './Pdf.module.css'

GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))

export interface PdfTarget { readonly paperId: string; readonly page: number; readonly presentation: 'drawer' | 'fullscreen' }

export class PdfPreview {
  #target: PdfTarget | undefined
  #listeners = new Set<() => void>()
  get = (): PdfTarget | undefined => this.#target
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener) } }
  open(paperId: string, page: number): void { this.#set(paperId, page, 'drawer') }
  openFullscreen(paperId: string, page: number): void { this.#set(paperId, page, 'fullscreen') }
  close(): void { if (this.#target === undefined) return; this.#target = undefined; this.#emit() }
  #set(paperId: string, page: number, presentation: PdfTarget['presentation']): void { this.#target = { paperId, page: Number.isSafeInteger(page) && page > 0 ? page : 1, presentation }; this.#emit() }
  #emit(): void { for (const listener of this.#listeners) listener() }
}

export interface PdfOverlayInjected { readonly api: PaperAgentApi; readonly preview: PdfPreview; readonly currentSession: () => string | undefined }

export function Pdf({ api, navigation, useSessions }: MainViewProps) {
  const current = useSessions(state => state.current)
  const target = useSyncExternalStore(navigation.subscribe, navigation.getReaderTarget)
  const resource = usePdfResource(api, current, target?.paperId)
  return <section className={css.reader}><header className={css.readerHeader}><div><strong>{resource.title ?? '论文阅读器'}</strong><small>{target === undefined ? '未选择论文' : `定位到 PDF 第 ${target.page} 页`}</small></div><div className={css.actions}><Button variant="outline" onClick={() => navigation.open('chat')}>返回对话</Button><Button variant="outline" onClick={() => navigation.open('papers')}>论文库</Button></div></header>{resource.error !== undefined ? <p className={css.error}>{resource.error}</p> : resource.url === undefined ? <div className={css.empty}><p>正在加载本地 PDF…</p></div> : <Document url={resource.url} initialPage={target?.page ?? 1}/>}</section>
}

export function PdfDrawer({ api, preview, currentSession }: PdfOverlayInjected) {
  const target = useSyncExternalStore(preview.subscribe, preview.get)
  const resource = usePdfResource(api, currentSession(), target?.presentation === 'drawer' ? target.paperId : undefined)
  if (target === undefined || target.presentation !== 'drawer') return null
  return <aside className={css.drawer} aria-label="论文 PDF 预览"><header className={css.drawerHeader}><div><strong>{resource.title ?? '正在加载 PDF…'}</strong><small>PDF 第 {target.page} 页</small></div><div className={css.actions}><Button variant="outline" onClick={() => preview.openFullscreen(target.paperId, target.page)}>全屏阅读</Button><Button variant="outline" onClick={() => preview.close()}>关闭</Button></div></header>{resource.error === undefined ? resource.url === undefined ? <p className={css.loading}>正在申请本地 PDF 访问权限…</p> : <Document url={resource.url} initialPage={target.page}/> : <p className={css.error}>无法打开论文：{resource.error}</p>}</aside>
}

export function PdfFullscreen({ api, preview, currentSession }: PdfOverlayInjected) {
  const target = useSyncExternalStore(preview.subscribe, preview.get)
  const resource = usePdfResource(api, currentSession(), target?.presentation === 'fullscreen' ? target.paperId : undefined)
  if (target === undefined || target.presentation !== 'fullscreen') return null
  return <section className={css.fullscreen} aria-label="论文 PDF 全屏阅读"><header className={css.fullscreenHeader}><strong>{resource.title ?? '正在加载 PDF…'}</strong><Button variant="outline" onClick={() => preview.open(target.paperId, target.page)}>退出全屏</Button></header>{resource.error !== undefined ? <p className={css.error}>无法打开论文：{resource.error}</p> : resource.url === undefined ? <p className={css.loading}>正在申请本地 PDF 访问权限…</p> : <Document url={resource.url} initialPage={target.page}/>}</section>
}

function usePdfResource(api: PaperAgentApi, sessionId: string | undefined, paperId: string | undefined) {
  const [url, setUrl] = useState<string | undefined>()
  const [title, setTitle] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  useEffect(() => {
    let disposed = false
    setUrl(undefined); setTitle(undefined); setError(undefined)
    if (sessionId === undefined || paperId === undefined) return
    void Promise.all([api.getPaper(sessionId, paperId), api.createPaperPdfAccess(sessionId, paperId)]).then(([paper, access]) => {
      if (disposed) return
      if (!paper.ok) { setError(`${paper.error.code}: ${paper.error.message}`); return }
      if (!access.ok) { setError(`${access.error.code}: ${access.error.message}`); return }
      setTitle(paper.value.title); setUrl(access.value.url)
    }).catch(cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true }
  }, [api, paperId, sessionId])
  return { url, title, error }
}

type PdfDocument = Awaited<ReturnType<typeof getDocument>['promise']>

function Document({ url, initialPage }: { readonly url: string; readonly initialPage: number }) {
  const canvases = useRef(new Map<number, HTMLCanvasElement>())
  const [document, setDocument] = useState<PdfDocument | undefined>()
  const [page, setPage] = useState(initialPage)
  const [totalPages, setTotalPages] = useState<number | undefined>()
  const [zoom, setZoom] = useState(1.2)
  const [error, setError] = useState<string | undefined>()
  useEffect(() => { setPage(initialPage) }, [initialPage, url])
  useEffect(() => {
    let disposed = false
    const task = getDocument({ url, rangeChunkSize: 1024 * 1024 })
    setDocument(undefined); setTotalPages(undefined); setError(undefined)
    void task.promise.then(pdf => { if (!disposed) { setDocument(pdf); setTotalPages(pdf.numPages); setPage(value => Math.min(Math.max(1, value), pdf.numPages)) } }).catch(cause => { if (!disposed) setError(errorMessage(cause)) })
    return () => { disposed = true; task.destroy() }
  }, [url])
  useEffect(() => {
    if (document === undefined) return
    let disposed = false
    const tasks: RenderTask[] = []
    void (async () => {
      try {
        for (let number = 1; number <= document.numPages; number += 1) {
          const pdfPage = await document.getPage(number)
          const canvas = canvases.current.get(number)
          if (disposed || canvas === undefined) return
          const viewport = pdfPage.getViewport({ scale: zoom })
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
          const task = pdfPage.render({ canvas, viewport }); tasks.push(task); await task.promise
        }
      } catch (cause) { if (!disposed && (cause as { name?: string }).name !== 'RenderingCancelledException') setError(errorMessage(cause)) }
    })()
    return () => { disposed = true; for (const task of tasks) task.cancel() }
  }, [document, zoom])
  useEffect(() => {
    if (totalPages === undefined) return
    const target = Math.min(Math.max(1, page), totalPages)
    const frame = requestAnimationFrame(() => { canvases.current.get(target)?.scrollIntoView({ behavior: 'auto', block: 'start' }) })
    return () => cancelAnimationFrame(frame)
  }, [page, totalPages])
  const jumpToPage = (requested: number) => { const target = Math.min(Math.max(1, requested), totalPages ?? requested); setPage(target); requestAnimationFrame(() => canvases.current.get(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })) }
  return <section className={css.viewer} aria-label="PDF 阅读器"><header className={css.toolbar}><div className={css.pageControls}><Button variant="outline" disabled={page <= 1} onClick={() => jumpToPage(page - 1)}>上一页</Button><label>页码<input type="number" min="1" max={totalPages} value={page} onChange={event => jumpToPage(Number(event.currentTarget.value) || 1)}/></label><span>/ {totalPages ?? '…'}</span><Button variant="outline" disabled={totalPages === undefined || page >= totalPages} onClick={() => jumpToPage(page + 1)}>下一页</Button></div><div className={css.zoomControls}><Button variant="outline" disabled={zoom <= 0.6} onClick={() => setZoom(value => Math.max(0.6, value - 0.2))}>−</Button><span>{Math.round(zoom * 100)}%</span><Button variant="outline" disabled={zoom >= 2.4} onClick={() => setZoom(value => Math.min(2.4, value + 0.2))}>+</Button></div></header>{error === undefined ? <div className={css.canvasWrap}><div className={css.pageStack}>{totalPages !== undefined && Array.from({ length: totalPages }, (_, index) => <canvas key={index + 1} ref={node => { if (node === null) canvases.current.delete(index + 1); else canvases.current.set(index + 1, node) }}/>)}</div></div> : <p className={css.error}>无法加载本地 PDF：{error}</p>}</section>
}
