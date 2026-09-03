import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { Button, IconEditOutline16, IconTrashOutline16, Input, MarkdownText, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Library, NewPaperDraft, Paper, PaperChunkPreview, PaperDetail, PaperImportCandidate, PaperIndexingStatus, PaperParseStructure, PaperSectionNode, ParseJob } from './api-types.ts'
import type { MainViewProps } from './Views.tsx'
import type { PdfPreview } from './Pdf.tsx'
import { errorMessage } from './ui-utils.ts'
import css from './Library.module.css'

type LibraryDialog = { readonly kind: 'create' } | { readonly kind: 'rename' | 'delete'; readonly library: Library }
type PaperDeleteTarget = Pick<Paper, 'id' | 'title'>
type PaperMetadataValues = Pick<PaperDetail, 'title' | 'authors' | 'year' | 'doi' | 'citationKey' | 'journal' | 'volume' | 'issue' | 'pages' | 'url' | 'abstract' | 'keywords' | 'bibtex'>

export function Library({ kind, api, useSessions, preview }: MainViewProps) {
  const current = useSessions(state => state.current)
  /** undefined = all papers; null = unclassified papers; string = one library. */
  const [selectedLibrary, setSelectedLibrary] = useState<string | null | undefined>()
  const [selectedPaper, setSelectedPaper] = useState<PaperDetail | undefined>()
  const [editingPaper, setEditingPaper] = useState<PaperDetail | undefined>()
  const [creatingPaper, setCreatingPaper] = useState(false)
  const [newPaperLibraryId, setNewPaperLibraryId] = useState<string | null>(null)
  const [arxivUrl, setArxivUrl] = useState('')
  const [paperReference, setPaperReference] = useState('')
  const [paperCandidates, setPaperCandidates] = useState<PaperImportCandidate[]>([])
  const [newPaperPdf, setNewPaperPdf] = useState<File | undefined>()
  const [newPaperDraft, setNewPaperDraft] = useState<NewPaperDraft>(emptyNewPaperDraft)
  const [paperDeleteTarget, setPaperDeleteTarget] = useState<PaperDeleteTarget | undefined>()
  const [libraryDialog, setLibraryDialog] = useState<LibraryDialog | undefined>()
  const [libraryName, setLibraryName] = useState('')
  const uploadInput = useRef<HTMLInputElement>(null)
  const bibtexInput = useRef<HTMLInputElement>(null)
  const replacementPdfInput = useRef<HTMLInputElement>(null)
  const replacementBibtexInput = useRef<HTMLInputElement>(null)
  const [libraries, setLibraries] = useState<Library[]>([])
  const [papers, setPapers] = useState<Paper[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [selectedPaperIds, setSelectedPaperIds] = useState<string[]>([])
  const [parseJobs, setParseJobs] = useState<Record<string, ParseJob>>({})
  const [structurePaperId, setStructurePaperId] = useState<string>()
  const [parseStructure, setParseStructure] = useState<PaperParseStructure>()
  const [parseStructureLoading, setParseStructureLoading] = useState(false)
  const [parseStructureError, setParseStructureError] = useState<string>()
  const parseGenerations = useRef(new Map<string, number>())
  const indexingGenerations = useRef(new Map<string, number>())
  const structureGeneration = useRef(0)
  const refreshGeneration = useRef(0)

  const refresh = useCallback(async (librarySelection: string | null | undefined = selectedLibrary) => {
    if (kind !== 'papers' || current === undefined) return
    const generation = ++refreshGeneration.current
    setLoading(true)
    setError(undefined)
    try {
      const [libraryResult, paperResult] = await Promise.all([
        api.listLibraries(current),
        api.listPapers(current, librarySelection === undefined ? {} : { libraryId: librarySelection }),
      ])
      if (generation !== refreshGeneration.current) return
      if (!libraryResult.ok) throw new Error(`${libraryResult.error.code}: ${libraryResult.error.message}`)
      if (!paperResult.ok) throw new Error(`${paperResult.error.code}: ${paperResult.error.message}`)
      setLibraries(libraryResult.value)
      if (typeof librarySelection === 'string' && !libraryResult.value.some(library => library.id === librarySelection)) setSelectedLibrary(undefined)
      setPapers(paperResult.value)
    } catch (cause) {
      if (generation !== refreshGeneration.current) return
      setError(errorMessage(cause))
    } finally {
      if (generation === refreshGeneration.current) setLoading(false)
    }
  }, [api, current, kind, selectedLibrary])

  useEffect(() => {
    refreshGeneration.current += 1
    parseGenerations.current.clear()
    indexingGenerations.current.clear()
    setSelectedLibrary(undefined)
    setSelectedPaper(undefined)
    setEditingPaper(undefined)
    setSelectedPaperIds([])
    setParseJobs({})
    structureGeneration.current += 1
    setStructurePaperId(undefined)
    setParseStructure(undefined)
    setParseStructureError(undefined)
    return () => { parseGenerations.current.clear(); indexingGenerations.current.clear(); structureGeneration.current += 1 }
  }, [current])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    const visibleIds = new Set(papers.map(paper => paper.id))
    setSelectedPaperIds(ids => ids.filter(id => visibleIds.has(id)))
  }, [papers])

  const selectLibrary = (librarySelection: string | null | undefined) => {
    setSelectedLibrary(librarySelection)
    setSelectedPaper(undefined)
    setSelectedPaperIds([])
    closeParseStructure()
  }

  const togglePaperSelection = (paperId: string) => {
    setSelectedPaperIds(ids => ids.includes(paperId) ? ids.filter(id => id !== paperId) : [...ids, paperId])
  }
  const toggleVisiblePaperSelection = () => {
    setSelectedPaperIds(ids => {
      const selected = new Set(ids)
      const everyVisibleSelected = papers.length > 0 && papers.every(paper => selected.has(paper.id))
      return everyVisibleSelected
        ? ids.filter(id => !papers.some(paper => paper.id === id))
        : [...new Set([...ids, ...papers.map(paper => paper.id)])]
    })
  }

  const closeParseStructure = useCallback(() => {
    structureGeneration.current += 1
    setStructurePaperId(undefined)
    setParseStructure(undefined)
    setParseStructureError(undefined)
    setParseStructureLoading(false)
  }, [])

  const openParseStructure = useCallback(async (paperId: string) => {
    if (current === undefined) return
    const generation = ++structureGeneration.current
    setStructurePaperId(paperId)
    setParseStructure(undefined)
    setParseStructureError(undefined)
    setParseStructureLoading(true)
    try {
      const result = await api.getPaperParseStructure(current, paperId)
      if (generation !== structureGeneration.current) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setParseStructure(result.value)
    } catch (cause) {
      if (generation === structureGeneration.current) setParseStructureError(errorMessage(cause))
    } finally {
      if (generation === structureGeneration.current) setParseStructureLoading(false)
    }
  }, [api, current])

  const loadFigureImage = useCallback(async (figureId: string) => {
    if (current === undefined) throw new Error('当前没有可用的工作区会话')
    const result = await api.getPaperFigureImage(current, figureId)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return result.value
  }, [api, current])

  /** Poll only the paper being indexed; the durable SQLite job remains the source of truth. */
  const observeIndexing = useCallback(async (paperId: string) => {
    if (current === undefined) return
    const version = (indexingGenerations.current.get(paperId) ?? 0) + 1
    indexingGenerations.current.set(paperId, version)
    const applyStatus = (status: PaperIndexingStatus) => {
      setPapers(rows => rows.map(paper => paper.id === paperId ? { ...paper, indexing: status } : paper))
      setEditingPaper(paper => paper === undefined || paper.id !== paperId ? paper : { ...paper, indexing: status })
      setSelectedPaper(paper => paper === undefined || paper.id !== paperId ? paper : { ...paper, indexing: status })
    }
    for (;;) {
      const result = await api.getPaperIndexingStatus(current, paperId)
      if (indexingGenerations.current.get(paperId) !== version) return
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return }
      applyStatus(result.value)
      if (result.value.status !== 'queued' && result.value.status !== 'processing') {
        indexingGenerations.current.delete(paperId)
        return
      }
      await new Promise<void>(resolve => window.setTimeout(resolve, 700))
      if (indexingGenerations.current.get(paperId) !== version) return
    }
  }, [api, current])

  /** Active parse jobs by paper. Progress belongs to each paper row, not the page header. */
  const observeParse = useCallback(async (paperId: string, jobId: string) => {
    const generation = (parseGenerations.current.get(paperId) ?? 0) + 1
    parseGenerations.current.set(paperId, generation)
    for (;;) {
      await new Promise<void>(resolve => window.setTimeout(resolve, 700))
      if (parseGenerations.current.get(paperId) !== generation || current === undefined) return
      const result = await api.getParseJob(current, jobId)
      if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); parseGenerations.current.delete(paperId); return }
      if (parseGenerations.current.get(paperId) !== generation) return
      setParseJobs(jobs => ({ ...jobs, [paperId]: result.value }))
      if (result.value.status === 'queued' || result.value.status === 'parsing') continue
      parseGenerations.current.delete(paperId)
      await refresh()
      if (result.value.status === 'ready') void observeIndexing(paperId)
      return
    }
  }, [api, current, refresh, observeIndexing])

  const submitLibraryDialog = async () => {
    if (current === undefined || libraryDialog === undefined) return
    const name = libraryName.trim()
    if (libraryDialog.kind !== 'delete' && name === '') { setError('论文库名称不能为空'); return }
    setLoading(true)
    setError(undefined)
    let nextLibrarySelection = selectedLibrary
    try {
      if (libraryDialog.kind === 'create') {
        const result = await api.createLibrary(current, name)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        setSelectedLibrary(result.value.id)
        nextLibrarySelection = result.value.id
      } else if (libraryDialog.kind === 'rename') {
        const result = await api.renameLibrary(current, libraryDialog.library.id, name)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      } else {
        const result = await api.deleteLibrary(current, libraryDialog.library.id)
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (selectedLibrary === libraryDialog.library.id) {
          setSelectedLibrary(undefined)
          nextLibrarySelection = undefined
        }
        setSelectedPaper(undefined)
      }
      setLibraryDialog(undefined)
      await refresh(nextLibrarySelection)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const openCreateLibrary = () => { setLibraryName(''); setLibraryDialog({ kind: 'create' }) }
  const openRenameLibrary = (library: Library) => { setLibraryName(library.name); setLibraryDialog({ kind: 'rename', library }) }
  const openDeleteLibrary = (library: Library) => { setLibraryName(library.name); setLibraryDialog({ kind: 'delete', library }) }
  const openNewPaper = () => {
    setNewPaperLibraryId(typeof selectedLibrary === 'string' ? selectedLibrary : null)
    setArxivUrl('')
    setPaperReference('')
    setPaperCandidates([])
    setNewPaperPdf(undefined)
    setNewPaperDraft(emptyNewPaperDraft())
    setCreatingPaper(true)
  }
  const selectNewPaperPdf = (file: File | undefined) => { if (file !== undefined) setNewPaperPdf(file) }
  const selectNewPaperBibtex = async (file: File | undefined) => {
    if (file === undefined) return
    const bibtex = await file.text()
    setNewPaperDraft(draft => draftFromBibtex(bibtex, draft))
  }
  const patchNewPaperDraft = (patch: Partial<NewPaperDraft>) => setNewPaperDraft(draft => ({ ...draft, ...patch }))
  const importArxivPaper = async () => {
    if (current === undefined) return
    if (arxivUrl.trim() === '') { setError('请输入 arXiv 论文 URL'); return }
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.importArxivPaper(current, { url: arxivUrl.trim(), libraryId: newPaperLibraryId })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.value.duplicate) throw new Error('该 arXiv PDF 已存在于当前工作区')
      if (result.value.jobId !== null) {
        setParseJobs(jobs => ({ ...jobs, [result.value.id]: {
          id: result.value.jobId!, paperId: result.value.id, status: 'queued', currentPage: null, totalPages: null,
          chunkCount: null, error: null,
        } }))
      }
      setCreatingPaper(false)
      setArxivUrl('')
      await refresh()
      if (result.value.jobId !== null) void observeParse(result.value.id, result.value.jobId)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const resolvePaperImportReference = async () => {
    if (current === undefined) return
    if (paperReference.trim() === '') { setError('请输入 DOI、论文 URL 或公开 PDF URL'); return }
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.resolvePaperReference(current, paperReference.trim())
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.value.length === 0) throw new Error('未找到可导入的论文候选')
      setPaperCandidates(result.value)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const importPaperReference = async (candidateId?: string) => {
    if (current === undefined) return
    if (paperReference.trim() === '') { setError('请输入 DOI、论文 URL 或公开 PDF URL'); return }
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.importPaperReference(current, { reference: paperReference.trim(), libraryId: newPaperLibraryId, ...(candidateId === undefined ? {} : { candidateId }) })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.value.jobId !== null) {
        setParseJobs(jobs => ({ ...jobs, [result.value.id]: {
          id: result.value.jobId!, paperId: result.value.id, status: 'queued', currentPage: null, totalPages: null,
          chunkCount: null, error: null,
        } }))
      }
      setCreatingPaper(false)
      setPaperReference('')
      setPaperCandidates([])
      await refresh()
      if (result.value.jobId !== null) void observeParse(result.value.id, result.value.jobId)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const submitNewPaper = async () => {
    if (current === undefined) return
    if (newPaperPdf === undefined && newPaperDraft.bibtex.trim() === '') { setError('请上传 PDF 或 BibTeX'); return }
    setLoading(true)
    setError(undefined)
    try {
      let paperId: string
      if (newPaperDraft.bibtex.trim() !== '') {
        const imported = await api.uploadBibtex(current, { bibtex: newPaperDraft.bibtex, libraryId: newPaperLibraryId })
        if (!imported.ok) throw new Error(`${imported.error.code}: ${imported.error.message}`)
        paperId = imported.value.id
        if (imported.value.duplicate) throw new Error('该 BibTeX 对应的论文已存在')
        if (newPaperPdf !== undefined) {
          await uploadPdf(current, newPaperPdf, paperId)
        }
      } else {
        const imported = await uploadPdf(current, newPaperPdf!, undefined, newPaperLibraryId)
        paperId = imported.id
        if (imported.duplicate) throw new Error('该 PDF 已存在')
      }
      const saved = await api.updatePaperMetadata(current, paperId, {
        title: newPaperDraft.title.trim() === '' ? (newPaperDraft.bibtex.trim() === '' ? newPaperPdf!.name.replace(/\.pdf$/i, '') : '未命名文献') : newPaperDraft.title,
        authors: [...newPaperDraft.authors], year: newPaperDraft.year, doi: nullableText(newPaperDraft.doi), bibtex: nullableText(newPaperDraft.bibtex),
        citationKey: nullableText(newPaperDraft.citationKey), journal: nullableText(newPaperDraft.journal), volume: nullableText(newPaperDraft.volume),
        issue: nullableText(newPaperDraft.issue), pages: nullableText(newPaperDraft.pages), url: nullableText(newPaperDraft.url), abstract: nullableText(newPaperDraft.abstract), keywords: nullableText(newPaperDraft.keywords),
      })
      if (!saved.ok) throw new Error(`${saved.error.code}: ${saved.error.message}`)
      setCreatingPaper(false)
      await refresh()
      await openPaperEditor(paperId)
      if (newPaperPdf !== undefined) await startParse(paperId)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const replacePaperPdf = async (file: File | undefined) => {
    if (file === undefined || current === undefined || editingPaper === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      await uploadPdf(current, file, editingPaper.id)
      await refresh()
      await startParse(editingPaper.id)
    } catch (cause) { setError(errorMessage(cause)) } finally {
      setLoading(false)
      if (replacementPdfInput.current !== null) replacementPdfInput.current.value = ''
    }
  }
  const replacePaperBibtex = async (file: File | undefined) => {
    if (file === undefined || current === undefined || editingPaper === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.updatePaperMetadata(current, editingPaper.id, { bibtex: await file.text() })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setEditingPaper(result.value)
      await refresh()
    } catch (cause) { setError(errorMessage(cause)) } finally {
      setLoading(false)
      if (replacementBibtexInput.current !== null) replacementBibtexInput.current.value = ''
    }
  }
  const startParse = async (paperId: string) => {
    if (current === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.startParse(current, paperId)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setParseJobs(jobs => ({ ...jobs, [paperId]: result.value }))
      await refresh()
      void observeParse(paperId, result.value.id)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const reindexPaper = async (paperId: string) => {
    if (current === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.reindexPaper(current, paperId)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setEditingPaper(paper => paper === undefined || paper.id !== paperId ? paper : { ...paper, indexing: result.value })
      await refresh()
      void observeIndexing(paperId)
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const cancelParse = async (paperId: string) => {
    const parseJob = parseJobs[paperId]
    if (current === undefined || parseJob === undefined) return
    const result = await api.cancelParse(current, parseJob.id)
    if (!result.ok) { setError(`${result.error.code}: ${result.error.message}`); return }
    setParseJobs(jobs => ({ ...jobs, [paperId]: result.value }))
    await refresh()
  }
  const loadPaper = async (paperId: string): Promise<PaperDetail | undefined> => {
    if (current === undefined) return
    setLoading(true)
    setError(undefined)
    try {
      const result = await api.getPaper(current, paperId)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    } catch (cause) {
      setError(errorMessage(cause))
      return undefined
    } finally { setLoading(false) }
  }
  const openPaper = async (paperId: string) => {
    const paper = await loadPaper(paperId)
    if (paper !== undefined) setSelectedPaper(paper)
  }
  const openPaperEditor = async (paperId: string) => {
    const paper = await loadPaper(paperId)
    if (paper !== undefined) setEditingPaper(paper)
  }
  const patchEditingPaper = (patch: Partial<PaperDetail>) => setEditingPaper(paper => paper === undefined ? paper : { ...paper, ...patch })
  const savePaperMetadata = async () => {
    if (current === undefined || editingPaper === undefined) return
    const yearText = editingPaper.year === null ? '' : String(editingPaper.year)
    const parsedYear = yearText.trim() === '' ? null : Number(yearText)
    if (parsedYear !== null && (!Number.isInteger(parsedYear) || parsedYear < 0 || parsedYear > 9999)) {
      setError('年份必须是四位整数')
      return
    }
    setLoading(true)
    try {
      const result = await api.updatePaperMetadata(current, editingPaper.id, {
        title: editingPaper.title,
        authors: [...editingPaper.authors],
        year: parsedYear,
        doi: editingPaper.doi, bibtex: editingPaper.bibtex, citationKey: editingPaper.citationKey,
        journal: editingPaper.journal, volume: editingPaper.volume, issue: editingPaper.issue,
        pages: editingPaper.pages, url: editingPaper.url, abstract: editingPaper.abstract, keywords: editingPaper.keywords,
      })
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      if (result.value.libraryId !== editingPaper.libraryId) {
        const moved = await api.movePaper(current, editingPaper.id, editingPaper.libraryId)
        if (!moved.ok) throw new Error(`${moved.error.code}: ${moved.error.message}`)
      }
      setEditingPaper(undefined)
      await refresh()
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const deletePaper = async () => {
    if (current === undefined || paperDeleteTarget === undefined) return
    setLoading(true)
    try {
      const result = await api.deletePaper(current, paperDeleteTarget.id)
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      setPaperDeleteTarget(undefined)
      await refresh()
    } catch (cause) { setError(errorMessage(cause)) } finally { setLoading(false) }
  }
  const exportSelectedPaperBibtex = useCallback(async () => {
    if (current === undefined || selectedPaperIds.length === 0) return
    setLoading(true)
    setError(undefined)
    try {
      const details = await Promise.all(selectedPaperIds.map(id => api.getPaper(current, id)))
      const failed = details.find((result): result is Extract<typeof result, { readonly ok: false }> => !result.ok)
      if (failed !== undefined) throw new Error(`${failed.error.code}: ${failed.error.message}`)
      const bibtex = details
        .flatMap(result => result.ok && result.value.bibtex !== null ? [result.value.bibtex.trim()] : [])
        .filter(Boolean)
        .join('\n\n')
      if (bibtex === '') throw new Error('所选论文中没有可导出的 BibTeX')
      downloadText('paperagent-selected-papers.bib', bibtex, 'application/x-bibtex;charset=utf-8')
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [api, current, selectedPaperIds])
  const label = '论文库'

  return <section className={css.page} aria-label={label}>
    <header className={css.header}>
      <div><strong>{label}</strong><small>当前 DSH 工作区</small></div>
      <div className={css.actions}>
        {kind === 'papers' && <><Button variant="ghost" className={css.newPaperButton} disabled={loading || current === undefined || selectedPaperIds.length === 0} onClick={() => void exportSelectedPaperBibtex()}>导出bibtex</Button><Button variant="ghost" className={css.newPaperButton} onClick={openNewPaper} disabled={loading || current === undefined}>新建论文</Button></>}
        <Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>刷新</Button>
      </div>
    </header>
    {current === undefined
      ? <div className={css.emptyState}><h2>请选择项目后开始管理</h2><p>请先在左侧创建或选择项目并打开一个对话；论文将保存到该项目的本地工作区。</p></div>
      : kind === 'papers'
        ? <div className={css.paperLayout}>
            <aside className={css.libraryList}>
              <div className={css.listHead}><strong>论文库</strong><span><Button variant="toolbar" size="sm" onClick={openCreateLibrary} disabled={loading}>新建</Button></span></div>
              <Button variant="toolbar" size="sm" className={`${css.libraryFilter} ${selectedLibrary === undefined ? css.selected : ''}`} aria-pressed={selectedLibrary === undefined} onClick={() => selectLibrary(undefined)}>全部论文</Button>
              <Button variant="toolbar" size="sm" className={`${css.libraryFilter} ${selectedLibrary === null ? css.selected : ''}`} aria-pressed={selectedLibrary === null} onClick={() => selectLibrary(null)}>未分类</Button>
              {libraries.map(library => <div key={library.id} className={`${css.libraryItem} ${selectedLibrary === library.id ? css.selected : ''}`}><button type="button" className={css.librarySelect} aria-pressed={selectedLibrary === library.id} onClick={() => selectLibrary(library.id)}><span>{library.name}</span><small>{library.paperCount} 篇</small></button><span className={css.libraryItemActions}><Button variant="toolbar" size="sm" icon={<IconEditOutline16 />} aria-label={`重命名 ${library.name}`} title="重命名" onClick={() => openRenameLibrary(library)} /><Button variant="toolbar" size="sm" icon={<IconTrashOutline16 />} aria-label={`删除 ${library.name}`} title="删除" className={css.dangerAction} onClick={() => openDeleteLibrary(library)} /></span></div>)}
            </aside>
            <main className={css.paperMain}>
              {papers.length === 0 ? <p className={css.empty}>此范围内暂无论文。</p> : <PaperTable
                papers={papers}
                selectedPaperIds={selectedPaperIds}
                parseJobs={parseJobs}
                onToggleVisiblePaperSelection={toggleVisiblePaperSelection}
                onTogglePaperSelection={togglePaperSelection}
                onOpenPaper={paperId => { void openPaper(paperId) }}
                onOpenParseStructure={paperId => { void openParseStructure(paperId) }}
                onCancelParse={paperId => { void cancelParse(paperId) }}
                onDeletePaper={paper => setPaperDeleteTarget({ id: paper.id, title: paper.title })}
                onEditPaper={paperId => { void openPaperEditor(paperId) }}
              />}
              {structurePaperId !== undefined && <ParseStructureDialog
                open
                paper={papers.find(paper => paper.id === structurePaperId)}
                structure={parseStructure}
                loading={parseStructureLoading}
                error={parseStructureError}
                loadFigureImage={loadFigureImage}
                onClose={closeParseStructure}
                onStartParse={() => { if (structurePaperId !== undefined) void startParse(structurePaperId) }}
                onReindex={() => { if (structurePaperId !== undefined) void reindexPaper(structurePaperId) }}
              />}
              {selectedPaper !== undefined && <PaperDetails
                paper={selectedPaper}
                preview={preview}
                onClose={() => setSelectedPaper(undefined)}
                onOpenPreview={() => setSelectedPaper(undefined)}
              />}
              {creatingPaper && <NewPaperDialog
                open
                loading={loading}
                libraries={libraries}
                libraryId={newPaperLibraryId}
                arxivUrl={arxivUrl}
                paperReference={paperReference}
                candidates={paperCandidates}
                pdf={newPaperPdf}
                draft={newPaperDraft}
                uploadInput={uploadInput}
                bibtexInput={bibtexInput}
                onClose={() => setCreatingPaper(false)}
                onLibraryChange={setNewPaperLibraryId}
                onArxivUrlChange={setArxivUrl}
                onImportArxiv={() => void importArxivPaper()}
                onPaperReferenceChange={value => { setPaperReference(value); setPaperCandidates([]) }}
                onResolveReference={() => void resolvePaperImportReference()}
                onImportReference={candidateId => void importPaperReference(candidateId)}
                onSelectPdf={selectNewPaperPdf}
                onSelectBibtex={file => void selectNewPaperBibtex(file)}
                onDraftChange={patchNewPaperDraft}
                onSubmit={() => void submitNewPaper()}
              />}
              <EditPaperDialog
                paper={editingPaper}
                loading={loading}
                libraries={libraries}
                replacementPdfInput={replacementPdfInput}
                replacementBibtexInput={replacementBibtexInput}
                onClose={() => setEditingPaper(undefined)}
                onLibraryChange={libraryId => patchEditingPaper({ libraryId })}
                onReplacePdf={file => void replacePaperPdf(file)}
                onReplaceBibtex={file => void replacePaperBibtex(file)}
                onChange={patchEditingPaper}
                onSave={() => void savePaperMetadata()}
              />
            </main>
          </div> : null}
    <ConfirmDialogs
      libraryDialog={libraryDialog}
      libraryName={libraryName}
      paperDeleteTarget={paperDeleteTarget}
      loading={loading}
      onLibraryNameChange={setLibraryName}
      onCloseLibraryDialog={() => setLibraryDialog(undefined)}
      onSubmitLibraryDialog={() => void submitLibraryDialog()}
      onClosePaperDelete={() => setPaperDeleteTarget(undefined)}
      onDeletePaper={() => void deletePaper()}
    />
    {error !== undefined && <p className={css.error}>{error}</p>}
  </section>
}

interface PaperTableProps {
  readonly papers: readonly Paper[]
  readonly selectedPaperIds: readonly string[]
  readonly parseJobs: Readonly<Record<string, ParseJob>>
  readonly onToggleVisiblePaperSelection: () => void
  readonly onTogglePaperSelection: (paperId: string) => void
  readonly onOpenPaper: (paperId: string) => void
  readonly onOpenParseStructure: (paperId: string) => void
  readonly onCancelParse: (paperId: string) => void
  readonly onDeletePaper: (paper: Paper) => void
  readonly onEditPaper: (paperId: string) => void
}

function PaperTable({ papers, selectedPaperIds, parseJobs, onToggleVisiblePaperSelection, onTogglePaperSelection, onOpenPaper, onOpenParseStructure, onCancelParse, onDeletePaper, onEditPaper }: PaperTableProps) {
  return <table><colgroup><col className={css.selectionColumn}/><col className={css.titleColumn}/><col className={css.authorsColumn}/><col className={css.yearColumn}/><col className={css.statusColumn}/><col className={css.statusColumn}/><col className={css.updatedColumn}/><col className={css.actionsColumn}/></colgroup><thead><tr><th><input type="checkbox" aria-label="选择当前列表全部论文" checked={papers.length > 0 && papers.every(paper => selectedPaperIds.includes(paper.id))} onChange={onToggleVisiblePaperSelection}/></th><th>论文标题</th><th>作者</th><th>年份</th><th>解析状态</th><th>索引状态</th><th>更新时间</th><th className={css.actionCell}>操作</th></tr></thead><tbody>{papers.map(paper => {
    const job = parseJobs[paper.id]
    const active = job?.status === 'queued' || job?.status === 'parsing'
    const status = job?.status === 'cancelled' ? 'cancelled' : active ? job.status : paper.parseStatus
    const statusLabel = status === 'metadata' ? '仅 BibTeX' : status === 'queued' ? '等待解析' : status === 'parsing' ? job?.currentPage === null || job?.currentPage === undefined ? '解析中' : `解析中：第 ${job.currentPage}/${job.totalPages ?? '?'} 页` : status === 'ready' ? '解析完成' : status === 'cancelled' ? '已取消' : '解析失败'
    const failure = job?.status === 'failed' || job?.status === 'cancelled' ? job.error ?? paper.parseError : paper.parseError
    const indexing = paper.indexing
    const openStructure = status === 'ready' ? () => onOpenParseStructure(paper.id) : undefined
    const indexLabel = indexing.status === 'not_indexed' ? '未索引' : indexing.status === 'queued' ? '等待索引' : indexing.status === 'processing' ? `索引中：${indexing.completedItems}/${indexing.totalItems}` : indexing.status === 'ready' ? '已索引' : indexing.status === 'failed' ? '索引失败' : '未知'
    return <tr key={paper.id}><td><input type="checkbox" aria-label={`选择 ${paper.title}`} checked={selectedPaperIds.includes(paper.id)} onChange={() => onTogglePaperSelection(paper.id)}/></td><td><button type="button" className={css.paperTitle} onClick={() => onOpenPaper(paper.id)}><strong>{paper.title}</strong></button></td><td>{paper.authors.join(', ') || '—'}</td><td>{paper.year ?? '—'}</td><td><div className={css.parseStateCell}><span className={`${css.status} ${css[status]}`} onClick={openStructure} role={openStructure === undefined ? undefined : 'button'} tabIndex={openStructure === undefined ? undefined : 0} onKeyDown={openStructure === undefined ? undefined : event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openStructure() } }}>{statusLabel}</span>{active && <Button variant="toolbar" size="sm" onClick={() => onCancelParse(paper.id)}>取消</Button>}{failure !== null && failure !== undefined && <small>{failure}</small>}</div></td><td><div className={css.parseStateCell}><span className={`${css.status} ${css[indexing.status]}`}>{indexLabel}</span>{indexing.status === 'failed' && indexing.error !== null && <small>{indexing.error}</small>}</div></td><td>{new Date(paper.updatedAt).toLocaleString()}</td><td className={css.actionCell}><div className={css.rowActions}><Button variant="toolbar" size="sm" icon={<IconTrashOutline16 />} aria-label={`删除 ${paper.title}`} title="删除" className={css.dangerAction} onClick={() => onDeletePaper(paper)} /><Button variant="toolbar" size="sm" icon={<IconEditOutline16 />} aria-label={`编辑 ${paper.title}`} title="编辑" onClick={() => onEditPaper(paper.id)} /></div></td></tr>
  })}</tbody></table>
}

type FigureImageLoader = (figureId: string) => Promise<{ readonly mimeType: string; readonly base64: string }>

function ParseStructureDialog({ open, paper, structure, loading, error, loadFigureImage, onClose, onStartParse, onReindex }: { readonly open: boolean; readonly paper: Paper | undefined; readonly structure: PaperParseStructure | undefined; readonly loading: boolean; readonly error: string | undefined; readonly loadFigureImage: FigureImageLoader; readonly onClose: () => void; readonly onStartParse: () => void; readonly onReindex: () => void }) {
  const title = structure === undefined ? '解析结构' : `${structure.title}`
  return <Modal open={open} onClose={onClose} title={title} closeLabel="关闭" className={css.parseStructureDialog ?? ''} contentClassName={css.parseStructureDialogContent ?? ''}>
    <div className={css.parseStructureToolbar}>
      {paper !== undefined && paper.parseStatus !== 'metadata' && <Button variant="toolbar" size="sm" onClick={onStartParse} disabled={loading || paper.parseStatus === 'queued' || paper.parseStatus === 'parsing'}>重新解析</Button>}
      {paper !== undefined && paper.parseStatus === 'ready' && <Button variant="toolbar" size="sm" onClick={onReindex} disabled={loading || paper.indexing.status === 'processing' || paper.indexing.status === 'queued'}>重新索引</Button>}
    </div>
    {loading && <div className={css.parseStructureMessage}>正在加载解析结构…</div>}
    {!loading && error !== undefined && <div className={css.parseStructureError}>{error}</div>}
    {!loading && error === undefined && structure !== undefined && <section className={css.parseStructureContent}>
      <div className={css.parseStructureSummary}><span>Section {structure.sectionCount}</span><span>Chunk {structure.chunkCount}</span><span>Revision {structure.revisionId.slice(0, 8)}</span>{structure.parsedAt !== null && <span>{new Date(structure.parsedAt).toLocaleString()}</span>}</div>
      {structure.sections.length === 0 ? <div className={css.parseStructureMessage}>没有可展示的章节结构。</div> : <div className={css.parseStructureTree}><ParseStructureRoots sections={structure.sections} loadFigureImage={loadFigureImage}/></div>}
    </section>}
  </Modal>
}

function ParseStructureRoots({ sections, loadFigureImage }: { readonly sections: readonly PaperSectionNode[]; readonly loadFigureImage: FigureImageLoader }) {
  return <>{sections.map(section => {
    // Document is an internal parser root. Hide that container in the UI and
    // start the tree at the paper's actual section headings.
    if (section.level === 0 && section.parentId === null) {
      return <div key={section.id} className={css.parseDocumentContents}>{section.chunks.map(chunk => <ParseChunkPreview key={chunk.id} chunk={chunk} loadFigureImage={loadFigureImage}/>)}{section.children.map(child => <ParseSectionNode key={child.id} section={child} loadFigureImage={loadFigureImage}/>)}</div>
    }
    return <ParseSectionNode key={section.id} section={section} loadFigureImage={loadFigureImage}/>
  })}</>
}

function ParseSectionNode({ section, loadFigureImage }: { readonly section: PaperSectionNode; readonly loadFigureImage: FigureImageLoader }) {
  const defaultOpen = section.level <= 1
  return <details className={css.parseSection} open={defaultOpen}>
    <summary className={css.parseSectionSummary}><span className={css.parseSectionTitle}>{section.title}</span><span className={css.parseSectionMeta}>{section.chunkCount} chunks · PDF {pageRange(section.pdfPageStart, section.pdfPageEnd)}</span></summary>
    <div className={css.parseSectionBody}>
      {section.chunks.map(chunk => <ParseChunkPreview key={chunk.id} chunk={chunk} loadFigureImage={loadFigureImage}/>) }
      {section.children.map(child => <ParseSectionNode key={child.id} section={child} loadFigureImage={loadFigureImage}/>) }
      {section.chunks.length === 0 && section.children.length === 0 && <div className={css.parseStructureEmpty}>此章节没有正文 chunk。</div>}
    </div>
  </details>
}

function ParseChunkPreview({ chunk, loadFigureImage }: { readonly chunk: PaperChunkPreview; readonly loadFigureImage: FigureImageLoader }) {
  return <article className={css.parseChunk}>
    <div className={css.parseChunkMeta}><span>Chunk {chunk.sequence + 1}</span><span>{chunk.charCount} 字符</span><span>PDF {pageRange(chunk.pdfPageStart, chunk.pdfPageEnd)}</span><span>行 {lineRange(chunk.lineStart, chunk.lineEnd)}</span>{chunk.elements.length > 0 && <span>{chunk.elements.length} 个元素</span>}</div>
    <div className={css.parseChunkPreview}>{chunk.content || '（空内容）'}</div>
    {chunk.elements.length > 0 && <div className={css.parseElementList}>{chunk.elements.map(element => <ParseElementPreview key={element.id} element={element} loadFigureImage={loadFigureImage}/>)}</div>}
  </article>
}

function ParseElementPreview({ element, loadFigureImage }: { readonly element: PaperChunkPreview['elements'][number]; readonly loadFigureImage: FigureImageLoader }) {
  const [image, setImage] = useState<{ readonly mimeType: string; readonly base64: string }>()
  const [imageError, setImageError] = useState<string>()
  useEffect(() => {
    if (element.contentFormat !== 'image' || element.figureId === null) return
    let active = true
    setImage(undefined)
    setImageError(undefined)
    void loadFigureImage(element.figureId).then(value => {
      if (active) setImage(value)
    }).catch(error => {
      if (active) setImageError(errorMessage(error))
    })
    return () => { active = false }
  }, [element.contentFormat, element.figureId, loadFigureImage])

  const title = element.caption?.trim() || `${element.elementType} element`
  return <article className={css.parseElement}>
    <div className={css.parseElementHeader}><strong>{title}</strong><span>{element.elementType}</span><span>PDF {pageRange(element.pdfPageStart, element.pdfPageEnd)}</span></div>
    {element.elementType === 'table' && element.contentFormat === 'markdown'
      ? <MarkdownTable source={element.content}/>
      : element.elementType === 'equation' || element.contentFormat === 'latex'
        ? <div className={css.parseElementMath}><MarkdownText text={latexMarkdown(element.content)}/></div>
      : element.contentFormat === 'image' && element.figureId !== null
        ? image !== undefined
          ? <img className={css.parseElementImage} src={`data:${image.mimeType};base64,${image.base64}`} alt={title}/>
          : <div className={css.parseElementFallback}>{imageError === undefined ? '正在加载图片预览…' : `图片预览加载失败：${imageError}`}</div>
        : <pre className={css.parseElementFallback}>{element.content || '（元素无内容）'}</pre>}
  </article>
}

function latexMarkdown(source: string): string {
  const value = source.trim()
  if (value === '') return ''
  // MinerU may return either a delimited formula or a bare TeX expression.
  // MarkdownText handles the former directly; wrap the latter as display math.
  if (/^(?:\$\$[\s\S]*\$\$|\\\[[\s\S]*\\\]|\\\([\s\S]*\\\)|\$[^$]+\$)$/.test(value)) return value
  return `$$\n${value}\n$$`
}

function MarkdownTable({ source }: { readonly source: string }) {
  const rows = source.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  if (rows.length < 2) return <pre className={css.parseElementFallback}>{source}</pre>
  const header = splitMarkdownTableRow(rows[0] ?? '')
  const separator = splitMarkdownTableRow(rows[1] ?? '')
  if (header.length === 0 || separator.length !== header.length || !separator.every(cell => /^:?-{3,}:?$/.test(cell))) return <pre className={css.parseElementFallback}>{source}</pre>
  return <div className={css.parseElementTableWrap}><table className={css.parseElementTable}><thead><tr>{header.map((cell, index) => <th key={`header-${index}`}>{cell}</th>)}</tr></thead><tbody>{rows.slice(2).map((row, rowIndex) => <tr key={`row-${rowIndex}`}>{splitMarkdownTableRow(row).map((cell, cellIndex) => <td key={`cell-${rowIndex}-${cellIndex}`}>{cell}</td>)}</tr>)}</tbody></table></div>
}

function splitMarkdownTableRow(row: string): string[] {
  const normalized = row.replace(/^\|/, '').replace(/\|$/, '')
  return normalized.split(/(?<!\\)\|/).map(cell => cell.replace(/\\\|/g, '|').trim())
}

function pageRange(start: number, end: number): string {
  return start === end ? `p.${start}` : `p.${start}–${end}`
}

function lineRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}–${end}`
}

function PaperDetails({ paper, preview, onClose, onOpenPreview }: { readonly paper: PaperDetail; readonly preview: PdfPreview; readonly onClose: () => void; readonly onOpenPreview: () => void }) {
  return <Modal open onClose={onClose} title="论文详情" closeLabel="关闭" className={css.paperDetailDialog ?? ''} contentClassName={css.readOnlyDialogContent ?? ''}><section className={css.readOnlyContent}>
    {paper.originalFileName.trim() !== '' && <div className={css.actions}><Button variant="outline" onClick={() => { preview.open(paper.id, 1); onOpenPreview() }}>预览 PDF</Button></div>}
    <div className={css.detailGrid}>
      <label>标题<output>{paper.title}</output></label><label>作者<output>{paper.authors.join(', ') || '—'}</output></label><label>年份<output>{paper.year ?? '—'}</output></label><label>DOI<output>{paper.doi ?? '—'}</output></label><label>引用键<output>{paper.citationKey ?? '—'}</output></label><label>期刊 / 会议<output>{paper.journal ?? '—'}</output></label><label>卷 / 期<output>{[paper.volume, paper.issue].filter(Boolean).join(' / ') || '—'}</output></label><label>页码<output>{paper.pages ?? '—'}</output></label><label>解析状态<output>{paper.parseStatus === 'ready' ? '解析完成' : paper.parseStatus === 'metadata' ? '仅 BibTeX' : paper.parseStatus === 'failed' ? `解析失败：${paper.parseError ?? '未知错误'}` : '等待或正在解析'}</output></label><label>原始论文<output>{paper.url === null ? '未提供' : <a href={paper.url} target="_blank" rel="noreferrer">打开原始论文链接</a>}</output></label><label>导入来源<output>{paper.sourceAdapter ?? '本地上传'}</output></label><label>PDF 来源<output>{paper.pdfSourceUrl === null ? '本地上传或未提供' : <a href={paper.pdfSourceUrl} target="_blank" rel="noreferrer">打开下载来源</a>}</output></label>
    </div>
    <label className={css.detailWide}>摘要<output>{paper.abstract ?? '—'}</output></label><label className={css.detailWide}>关键词<output>{paper.keywords ?? '—'}</output></label>
    {paper.metadataProvenance.length > 0 && <label className={css.detailWide}>元数据来源<output>{paper.metadataProvenance.map((item, index) => <span key={`${item.source}-${item.url}`}>{index > 0 && ' · '}<a href={item.url} target="_blank" rel="noreferrer">{item.source}</a></span>)}</output></label>}
    <label className={css.detailWide}>BibTeX 原文<pre className={css.bibtex}>{paper.bibtex ?? '—'}</pre></label>
  </section></Modal>
}

function ConfirmDialogs({ libraryDialog, libraryName, paperDeleteTarget, loading, onLibraryNameChange, onCloseLibraryDialog, onSubmitLibraryDialog, onClosePaperDelete, onDeletePaper }: { readonly libraryDialog: LibraryDialog | undefined; readonly libraryName: string; readonly paperDeleteTarget: PaperDeleteTarget | undefined; readonly loading: boolean; readonly onLibraryNameChange: (name: string) => void; readonly onCloseLibraryDialog: () => void; readonly onSubmitLibraryDialog: () => void; readonly onClosePaperDelete: () => void; readonly onDeletePaper: () => void }) {
  return <>{libraryDialog !== undefined && <Modal open onClose={onCloseLibraryDialog} title={libraryDialog.kind === 'delete' ? '删除论文库' : libraryDialog.kind === 'rename' ? '重命名论文库' : '新建论文库'} closeLabel="关闭" footer={<><Button variant="outline" onClick={onCloseLibraryDialog}>取消</Button><Button variant={libraryDialog.kind === 'delete' ? 'outline' : 'primary'} className={libraryDialog.kind === 'delete' ? css.dangerAction : undefined} onClick={onSubmitLibraryDialog} disabled={loading}>{libraryDialog.kind === 'delete' ? '删除' : '确认'}</Button></>}>
    {libraryDialog.kind === 'delete' ? <p>确定删除“{libraryDialog.library.name}”吗？其中 {libraryDialog.library.paperCount} 篇论文将保留，并移动到“未分类”。</p> : <label className={css.dialogField}>名称<Input autoFocus value={libraryName} onChange={event => onLibraryNameChange(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') onSubmitLibraryDialog() }}/></label>}
  </Modal>}{paperDeleteTarget !== undefined && <Modal open onClose={onClosePaperDelete} title="删除论文" closeLabel="关闭" description={`删除“${paperDeleteTarget.title}”后，PDF、Markdown、图片和检索索引将被永久移除。`} footer={<><Button variant="outline" onClick={onClosePaperDelete}>取消</Button><Button variant="primary" className={css.dangerAction} disabled={loading} onClick={onDeletePaper}>删除</Button></>} />}</>
}

function MetadataFields({ values, onChange }: { readonly values: PaperMetadataValues; readonly onChange: (patch: Partial<PaperMetadataValues>) => void }) {
  const text = (value: string | null) => value ?? ''
  return <section className={css.metadataSection}><h3>论文原信息</h3><div className={css.detailGrid}>
    <label>标题<Input value={values.title} onChange={event => onChange({ title: event.currentTarget.value })}/></label><label>作者（逗号分隔）<Input value={values.authors.join(', ')} onChange={event => onChange({ authors: event.currentTarget.value.split(',').map(author => author.trim()).filter(Boolean) })}/></label><label>年份<Input type="number" min="0" max="9999" value={values.year ?? ''} onChange={event => onChange({ year: event.currentTarget.value === '' ? null : Number(event.currentTarget.value) })}/></label><label>DOI<Input value={text(values.doi)} onChange={event => onChange({ doi: event.currentTarget.value || null })}/></label><label>引用键<Input value={text(values.citationKey)} onChange={event => onChange({ citationKey: event.currentTarget.value || null })}/></label><label>期刊 / 会议<Input value={text(values.journal)} onChange={event => onChange({ journal: event.currentTarget.value || null })}/></label><label>卷<Input value={text(values.volume)} onChange={event => onChange({ volume: event.currentTarget.value || null })}/></label><label>期<Input value={text(values.issue)} onChange={event => onChange({ issue: event.currentTarget.value || null })}/></label><label>页码<Input value={text(values.pages)} onChange={event => onChange({ pages: event.currentTarget.value || null })}/></label><label>原始论文 URL<Input value={text(values.url)} onChange={event => onChange({ url: event.currentTarget.value || null })}/></label>
  </div><label className={css.detailWide}>摘要<textarea value={text(values.abstract)} onChange={event => onChange({ abstract: event.currentTarget.value || null })}/></label><label className={css.detailWide}>关键词<textarea value={text(values.keywords)} onChange={event => onChange({ keywords: event.currentTarget.value || null })}/></label><label className={css.detailWide}>BibTeX 原文<textarea value={text(values.bibtex)} onChange={event => onChange({ bibtex: event.currentTarget.value || null })}/></label></section>
}

interface NewPaperDialogProps {
  readonly open: boolean
  readonly loading: boolean
  readonly libraries: readonly Library[]
  readonly libraryId: string | null
  readonly arxivUrl: string
  readonly paperReference: string
  readonly candidates: readonly PaperImportCandidate[]
  readonly pdf: File | undefined
  readonly draft: NewPaperDraft
  readonly uploadInput: RefObject<HTMLInputElement>
  readonly bibtexInput: RefObject<HTMLInputElement>
  readonly onClose: () => void
  readonly onLibraryChange: (value: string | null) => void
  readonly onArxivUrlChange: (value: string) => void
  readonly onImportArxiv: () => void
  readonly onPaperReferenceChange: (value: string) => void
  readonly onResolveReference: () => void
  readonly onImportReference: (candidateId: string) => void
  readonly onSelectPdf: (file: File | undefined) => void
  readonly onSelectBibtex: (file: File | undefined) => void
  readonly onDraftChange: (patch: Partial<NewPaperDraft>) => void
  readonly onSubmit: () => void
}

function NewPaperDialog(props: NewPaperDialogProps) {
  const values: PaperMetadataValues = { ...props.draft, doi: props.draft.doi || null, citationKey: props.draft.citationKey || null, journal: props.draft.journal || null, volume: props.draft.volume || null, issue: props.draft.issue || null, pages: props.draft.pages || null, url: props.draft.url || null, abstract: props.draft.abstract || null, keywords: props.draft.keywords || null, bibtex: props.draft.bibtex || null }
  const onMetadataChange = (patch: Partial<PaperMetadataValues>) => props.onDraftChange(Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value ?? ''])) as Partial<NewPaperDraft>)
  return <Modal open={props.open} onClose={props.onClose} title="新建论文" closeLabel="关闭" className={css.paperEditorDialog ?? ''} contentClassName={css.editDialogContent ?? ''} footer={<><Button variant="outline" onClick={props.onClose}>取消</Button><Button variant="primary" disabled={props.loading} onClick={props.onSubmit}>创建论文</Button></>}><section className={css.editContent}>
    <input ref={props.uploadInput} className={css.fileInput} type="file" accept="application/pdf,.pdf" onChange={event => { props.onSelectPdf(event.currentTarget.files?.[0]); event.currentTarget.value = '' }}/><input ref={props.bibtexInput} className={css.fileInput} type="file" accept=".bib,text/plain" onChange={event => { props.onSelectBibtex(event.currentTarget.files?.[0]); event.currentTarget.value = '' }}/>
    <label>选择论文库<select className={css.librarySelectInput} value={props.libraryId ?? ''} onChange={event => props.onLibraryChange(event.currentTarget.value === '' ? null : event.currentTarget.value)}><option value="">未分类</option>{props.libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>
    <ImportFromArxiv {...props}/><ImportFromReference {...props}/>
    <div className={css.newPaperUploads}><button type="button" className={css.dropZone} onClick={() => props.uploadInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); props.onSelectPdf(event.dataTransfer.files[0]) }}><strong>上传 PDF</strong><small>{props.pdf === undefined ? '点击或拖拽 PDF 到此处' : props.pdf.name}</small></button><button type="button" className={css.dropZone} onClick={() => props.bibtexInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); props.onSelectBibtex(event.dataTransfer.files[0]) }}><strong>上传 BibTeX</strong><small>{props.draft.bibtex === '' ? '点击或拖拽 .bib 文件到此处' : 'BibTeX 已解析'}</small></button></div>
    <MetadataFields values={values} onChange={onMetadataChange}/>
  </section></Modal>
}

function ImportFromArxiv(props: NewPaperDialogProps) {
  return <section className={css.arxivImportSection}><span className={css.arxivImportLabel}>从 arXiv URL 导入</span><section className={css.arxivImport}><Input value={props.arxivUrl} placeholder="https://arxiv.org/abs/2501.01234" onChange={event => props.onArxivUrlChange(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onImportArxiv() } }}/><Button variant="outline" disabled={props.loading || props.arxivUrl.trim() === ''} onClick={props.onImportArxiv}>一键导入 arXiv</Button><small>自动下载官方 PDF、读取 arXiv 元数据并生成 BibTeX，然后开始 MinerU 解析。</small></section></section>
}

function ImportFromReference(props: NewPaperDialogProps) {
  return <section className={css.arxivImportSection}><span className={css.arxivImportLabel}>从 DOI / 论文 URL 导入</span><section className={css.arxivImport}><Input value={props.paperReference} placeholder="10.48550/arXiv.1706.03762 或 https://…" onChange={event => props.onPaperReferenceChange(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); props.onResolveReference() } }}/><Button variant="outline" disabled={props.loading || props.paperReference.trim() === ''} onClick={props.onResolveReference}>查找候选</Button><small>先展示可验证的来源和可用资源；确认后才下载并导入。</small>{props.candidates.length > 0 && <div className={css.arxivImportSection}>{props.candidates.map(candidate => <article key={candidate.id} className={css.hint}><div><strong>{candidate.title}</strong><small>{candidate.authors.join(', ') || '作者信息未提供'}{candidate.year === null ? '' : ` · ${candidate.year}`} · {candidate.source}</small><small>PDF：{candidate.pdfUrl === null ? '不可用' : '可用'} · BibTeX：{candidate.bibtexAvailable ? '可用' : '不可用'} · 置信度：{candidate.confidence === 'high' ? '高' : '中'}</small></div><Button variant="outline" disabled={props.loading} onClick={() => props.onImportReference(candidate.id)}>确认导入</Button></article>)}</div>}</section></section>
}

function EditPaperDialog({ paper, loading, libraries, replacementPdfInput, replacementBibtexInput, onClose, onLibraryChange, onReplacePdf, onReplaceBibtex, onChange, onSave }: { readonly paper: PaperDetail | undefined; readonly loading: boolean; readonly libraries: readonly Library[]; readonly replacementPdfInput: RefObject<HTMLInputElement>; readonly replacementBibtexInput: RefObject<HTMLInputElement>; readonly onClose: () => void; readonly onLibraryChange: (value: string | null) => void; readonly onReplacePdf: (file: File | undefined) => void; readonly onReplaceBibtex: (file: File | undefined) => void; readonly onChange: (patch: Partial<PaperDetail>) => void; readonly onSave: () => void }) {
  if (paper === undefined) return null
  return <Modal open onClose={onClose} title="编辑论文" closeLabel="关闭" className={css.paperEditorDialog ?? ''} contentClassName={css.editDialogContent ?? ''} footer={<><Button variant="outline" onClick={onClose}>取消</Button><Button variant="primary" disabled={loading} onClick={onSave}>保存论文</Button></>}><section className={css.editContent}>
    <input ref={replacementPdfInput} className={css.fileInput} type="file" accept="application/pdf,.pdf" onChange={event => onReplacePdf(event.currentTarget.files?.[0])}/><input ref={replacementBibtexInput} className={css.fileInput} type="file" accept=".bib,text/plain" onChange={event => onReplaceBibtex(event.currentTarget.files?.[0])}/>
    <label>选择论文库<select className={css.librarySelectInput} value={paper.libraryId ?? ''} onChange={event => onLibraryChange(event.currentTarget.value === '' ? null : event.currentTarget.value)}><option value="">未分类</option>{libraries.map(library => <option key={library.id} value={library.id}>{library.name}</option>)}</select></label>
    <div className={css.newPaperUploads}><button type="button" className={css.dropZone} onClick={() => replacementPdfInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onReplacePdf(event.dataTransfer.files[0]) }}><strong>上传 PDF</strong><small>{paper.originalFileName === '' ? '点击或拖拽 PDF 到此处' : paper.originalFileName}</small></button><button type="button" className={css.dropZone} onClick={() => replacementBibtexInput.current?.click()} onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); onReplaceBibtex(event.dataTransfer.files[0]) }}><strong>上传 BibTeX</strong><small>{paper.bibtex === null ? '点击或拖拽 .bib 文件到此处' : 'BibTeX 已保存'}</small></button></div>
    <MetadataFields values={paper} onChange={onChange}/>
  </section></Modal>
}

function downloadText(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.style.display = 'none'
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 0)
}

async function uploadPdf(sessionId: string, file: File, paperId?: string, libraryId?: string | null): Promise<{ id: string; title: string; duplicate: boolean; parseStatus: string }> {
  const query = new URLSearchParams({ sessionId, ...(paperId === undefined ? {} : { paperId }) })
  const response = await fetch(`/api/paperagent/upload?${query}`, { method: 'POST', headers: { 'content-type': 'application/pdf', 'x-paperagent-file-name': file.name, ...(libraryId === null || libraryId === undefined ? {} : { 'x-paperagent-library-id': libraryId }) }, body: file })
  const payload = await response.json() as { id?: string; title?: string; duplicate?: boolean; parseStatus?: string; error?: string }
  if (!response.ok || payload.id === undefined || payload.title === undefined || payload.duplicate === undefined || payload.parseStatus === undefined) throw new Error(payload.error ?? 'PDF 上传失败')
  return { id: payload.id, title: payload.title, duplicate: payload.duplicate, parseStatus: payload.parseStatus }
}

function nullableText(value: string): string | null { return value.trim() === '' ? null : value.trim() }
function emptyNewPaperDraft(): NewPaperDraft { return { title: '', authors: [], year: null, doi: '', citationKey: '', journal: '', volume: '', issue: '', pages: '', url: '', abstract: '', keywords: '', bibtex: '' } }
function bibtexValue(source: string, field: string): string {
  const match = new RegExp(`\\b${field}\\s*=\\s*`, 'i').exec(source)
  if (match === null) return ''
  const start = match.index + match[0].length
  const opener = source[start]
  let value = ''
  if (opener === '{') { let depth = 0; for (let index = start; index < source.length; index += 1) { if (source[index] === '{') depth += 1; else if (source[index] === '}' && --depth === 0) { value = source.slice(start + 1, index); break } } } else if (opener === '"') { for (let index = start + 1; index < source.length; index += 1) { if (source[index] === '"' && source[index - 1] !== '\\') { value = source.slice(start + 1, index); break } } } else { const end = source.slice(start).search(/[,\r\n}]/); value = end === -1 ? source.slice(start) : source.slice(start, start + end) }
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}
function draftFromBibtex(bibtex: string, previous: NewPaperDraft): NewPaperDraft {
  const entry = bibtex.match(/@\w+\s*\{\s*([^,\s]+)/i)?.[1] ?? previous.citationKey
  const yearText = bibtexValue(bibtex, 'year')
  const parsedYear = /^\d{1,4}$/.test(yearText) ? Number(yearText) : null
  const authors = bibtexValue(bibtex, 'author').split(/\s+and\s+/i).map(author => author.trim()).filter(Boolean)
  return { ...previous, bibtex, citationKey: entry, title: bibtexValue(bibtex, 'title') || previous.title, authors: authors.length > 0 ? authors : previous.authors, year: parsedYear ?? previous.year, doi: bibtexValue(bibtex, 'doi') || previous.doi, journal: bibtexValue(bibtex, 'journal') || bibtexValue(bibtex, 'booktitle') || previous.journal, volume: bibtexValue(bibtex, 'volume') || previous.volume, issue: bibtexValue(bibtex, 'number') || previous.issue, pages: bibtexValue(bibtex, 'pages') || previous.pages, url: bibtexValue(bibtex, 'url') || previous.url, abstract: bibtexValue(bibtex, 'abstract') || previous.abstract, keywords: bibtexValue(bibtex, 'keywords') || previous.keywords }
}
