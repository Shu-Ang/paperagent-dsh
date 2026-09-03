/** Session-level PaperAgent retrieval inspector. */

import { useEffect, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  PaperRetrievalTraceCandidate, PaperRetrievalTraceEventDataV1, PaperRetrievalTraceStage,
} from '@paperagent/contracts'
import {
  EMPTY_PAPER_AGENT_RETRIEVAL_SNAPSHOT,
  type PaperAgentRetrievalRun,
} from './RetrievalTrace.ts'
import type { PdfPreview } from './Pdf.tsx'
import css from './Retrieval.module.css'

export interface RetrievalInjected {
  readonly preview: PdfPreview
  readonly loadOlder: () => Promise<boolean>
}

type DetailTab = 'overview' | 'sqlite' | 'embedding' | 'elasticsearch' | 'fusion' | 'rerank' | 'final'

const STAGE_LABEL: Record<Exclude<DetailTab, 'overview'>, string> = {
  sqlite: 'SQLite', embedding: 'Embedding', elasticsearch: 'Elasticsearch', fusion: 'RRF', rerank: 'DashScope Rerank', final: 'Final',
}

function isSupported(run: PaperAgentRetrievalRun): run is PaperAgentRetrievalRun & { readonly data: PaperRetrievalTraceEventDataV1 } {
  return !('unsupported' in run.data)
}

function statusLabel(run: PaperAgentRetrievalRun): string {
  if (!isSupported(run)) return '版本不可用'
  if (run.data.stages.some(stage => stage.status === 'failed')) return '失败'
  if (run.data.stages.some(stage => stage.status === 'fallback')) return '降级'
  return '完成'
}

function statusClass(run: PaperAgentRetrievalRun): string {
  const status = statusLabel(run)
  return status === '失败' ? (css.statusFailed ?? '') : status === '降级' ? (css.statusFallback ?? '') : ''
}

function finalCount(run: PaperAgentRetrievalRun): number {
  return isSupported(run) ? run.data.stages.find(stage => stage.kind === 'final')?.candidates.length ?? 0 : 0
}

function stageFor(run: PaperRetrievalTraceEventDataV1, tab: Exclude<DetailTab, 'overview'>): PaperRetrievalTraceStage | undefined {
  return run.stages.find(stage => stage.kind === tab)
}

function score(candidate: PaperRetrievalTraceCandidate): string {
  if (candidate.rerankScore !== undefined) return 'Rerank ' + candidate.rerankScore.toFixed(4)
  if (candidate.fusionScore !== undefined) return `RRF ${candidate.fusionScore.toFixed(4)}`
  if (candidate.score !== undefined) return `kNN ${candidate.score.toFixed(4)}`
  if (candidate.sqliteRank !== undefined) return `FTS #${candidate.sqliteRank}`
  return '—'
}

function timeLabel(timestamp: number, seq: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return `seq ${seq}`
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(timestamp))
}

function CandidateTable({ candidates, preview }: { readonly candidates: readonly PaperRetrievalTraceCandidate[]; readonly preview: PdfPreview }) {
  if (candidates.length === 0) return <p className={css.empty}>该阶段没有候选结果。</p>
  return <div className={css.tableWrap}><table className={css.candidates}><thead><tr><th>排名</th><th>论文 / 定位</th><th>评分 / 排名</th><th>摘要</th></tr></thead><tbody>{candidates.map(candidate => <tr key={`${candidate.sourceId}:${candidate.rank}`}><td>{candidate.rank}</td><td><button type="button" className={css.paperLink} onClick={() => preview.open(candidate.paperId, candidate.pdfPageStart)}><strong>{candidate.title}</strong><span>{candidate.section} · PDF p.{candidate.pdfPageStart}</span></button></td><td>{score(candidate)}</td><td><span className={css.excerpt}>{candidate.excerpt}</span></td></tr>)}</tbody></table></div>
}

function RunDetail({ run, preview }: { readonly run: PaperAgentRetrievalRun; readonly preview: PdfPreview }) {
  const [tab, setTab] = useState<DetailTab>('overview')
  useEffect(() => { setTab('overview') }, [run.seq])
  if (!isSupported(run)) return <section className={css.detail}><h2>检索记录</h2><p className={css.empty}>此记录由更新版本的 PaperAgent 写入，当前版本不能解析其详情。</p></section>
  const stages = run.data.stages
  const availableTabs: readonly DetailTab[] = ['overview', ...stages.map(stage => stage.kind)]
  const stage = tab === 'overview' ? undefined : stageFor(run.data, tab)
  return <section className={css.detail}><header className={css.detailHeader}><div><h2>{run.data.query.text || '空查询'}</h2><p>{run.data.toolName} · Turn {run.data.turn} / Step {run.data.step} · {run.data.totalMs} ms</p></div><span className={`${css.status} ${statusClass(run)}`}>{statusLabel(run)}</span></header><div className={css.tabs} role="tablist">{availableTabs.map(item => <button key={item} type="button" role="tab" aria-selected={tab === item} className={tab === item ? css.activeTab : undefined} onClick={() => setTab(item)}>{item === 'overview' ? '概览' : STAGE_LABEL[item]}</button>)}</div>{tab === 'overview' ? <div className={css.overview}><dl><div><dt>Query</dt><dd>{run.data.query.text}</dd></div><div><dt>结果上限</dt><dd>{run.data.query.limit}</dd></div><div><dt>Call ID</dt><dd>{run.data.callId}</dd></div><div><dt>最终命中</dt><dd>{finalCount(run)}</dd></div><div><dt>筛选条件</dt><dd><pre>{JSON.stringify(run.data.query.filters, null, 2)}</pre></dd></div></dl><div className={css.stageSummary}>{stages.map(item => <button type="button" key={item.kind} onClick={() => setTab(item.kind)}><strong>{STAGE_LABEL[item.kind]}</strong><span>{item.status} · {item.durationMs} ms · {item.candidates.length} 项</span>{item.reason !== undefined && <small>{item.reason}</small>}</button>)}</div></div> : stage === undefined ? <p className={css.empty}>该阶段没有记录。</p> : <div className={css.stage}><header><div><h3>{STAGE_LABEL[stage.kind]}</h3><p>{stage.status} · {stage.durationMs} ms{stage.method === undefined ? '' : ` · ${stage.method}`}</p></div>{stage.reason !== undefined && <p className={css.reason}>{stage.reason}</p>}</header><CandidateTable candidates={stage.candidates} preview={preview}/></div>}</section>
}

/** The third session header tab: all PaperAgent retrieval runs for this session. */
export function Retrieval({ useSession, preview, loadOlder }: ConvViewProps & InjectFace<RetrievalInjected>) {
  const snapshot = useSession(state => state.views.get('paperagent-retrieval') ?? EMPTY_PAPER_AGENT_RETRIEVAL_SNAPSHOT)
  const loading = useSession(state => state.loadingOlder)
  const hasMore = useSession(state => state.hasMore)
  const [query, setQuery] = useState('')
  const [selectedSeq, setSelectedSeq] = useState<number | undefined>()
  useEffect(() => {
    if (!hasMore || loading) return
    void loadOlder()
  }, [hasMore, loading, loadOlder])
  const runs = useMemo(() => snapshot.runs.filter(run => {
    if (query.trim() === '') return true
    const text = isSupported(run) ? `${run.data.query.text} ${run.data.toolName}` : '版本不可用'
    return text.toLowerCase().includes(query.trim().toLowerCase())
  }).sort((left, right) => right.time - left.time || right.seq - left.seq), [query, snapshot.runs])
  const selected = runs.find(run => run.seq === selectedSeq) ?? runs[0]
  return <main className={css.page} data-conversation-composer-overlay=""><aside className={css.list}><header><strong>检索</strong><Input value={query} onChange={event => setQuery(event.currentTarget.value)} placeholder="筛选 query" aria-label="筛选检索记录"/></header>{runs.length === 0 ? <p className={css.empty}>当前会话尚无 PaperAgent 检索记录。</p> : <div className={css.runList}>{runs.map(run => <button type="button" key={run.seq} className={selected?.seq === run.seq ? css.selected : undefined} onClick={() => setSelectedSeq(run.seq)}><strong>{isSupported(run) ? run.data.query.text || '空查询' : '版本不可用的检索记录'}</strong><span>{isSupported(run) ? run.data.toolName : 'paperagent/retrieval-trace'} · {statusLabel(run)}</span><small>{timeLabel(run.time, run.seq)} · {isSupported(run) ? `${run.data.totalMs} ms · ${finalCount(run)} 项` : `seq ${run.seq}`}</small></button>)}</div>}{loading && <p className={css.loading}>正在加载会话检索记录…</p>}</aside>{selected === undefined ? <section className={css.placeholder}><h2>检索记录</h2><p>在对话中调用论文检索工具后，该会话的 SQLite、Embedding、Elasticsearch 与最终排序信息会显示在这里。</p></section> : <RunDetail run={selected} preview={preview}/>}</main>
}
