/** PaperAgent settings for write-only external-service credentials. */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { Button, IconEditOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PaperAgentApi } from './api-types.ts'
import css from './Settings.module.css'

export const MINERU_TOKEN_REF = 'MINERU_API_TOKEN'
export const ELASTICSEARCH_API_KEY_REF = 'PAPERAGENT_ES_API_KEY'
export const DASHSCOPE_API_KEY_REF = 'DASHSCOPE_API_KEY'

export interface PaperAgentSettingsInjected {
  readonly api: Pick<IApiClient, 'credentials'>
  /** PaperAgent Host BFF; it performs network checks without revealing secrets. */
  readonly paperAgentApi: Pick<PaperAgentApi, 'testElasticsearch' | 'getVectorSettings' | 'setVectorSettings'>
  /** The settings page can be opened without a selected chat; the Host test itself is not workspace-sensitive. */
  readonly currentSessionId: () => string | undefined
  /** Subscribe to credential changes without ever exposing their values. */
  readonly onCredentialUpdated: (listener: () => void) => () => void
}

export type PaperAgentSettingsProps = Partial<PaperAgentSettingsInjected>

type CredentialState = { readonly status: 'loading' | 'ready' | 'error'; readonly configured: boolean; readonly writable: boolean; readonly source?: string; readonly error?: string }
type ValidationResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly message: string }
const INITIAL: CredentialState = { status: 'loading', configured: false, writable: false }
type VectorSettings = { readonly embeddingEnabled: boolean; readonly elasticsearchEnabled: boolean; readonly rerankerEnabled: boolean }
const VectorSettingsContext = createContext<{ readonly value: VectorSettings; readonly rerankerAvailable: boolean; readonly busy: boolean; readonly error: string | undefined; readonly change: (key: keyof VectorSettings) => void } | undefined>(undefined)

/** Renders PaperAgent's write-only credentials; values are never requested from the Host. */
export function PaperAgentSettings(props: PaperAgentSettingsProps) {
  const { api, paperAgentApi, currentSessionId, onCredentialUpdated } = props
  const [vectorSettings, setVectorSettings] = useState<VectorSettings>({ embeddingEnabled: false, elasticsearchEnabled: false, rerankerEnabled: false })
  const [rerankerAvailable, setRerankerAvailable] = useState(false)
  const [vectorSettingsBusy, setVectorSettingsBusy] = useState(false)
  const [vectorSettingsError, setVectorSettingsError] = useState<string | undefined>()
  const vectorSettingsVersion = useRef(0)
  const sessionId = currentSessionId?.()
  useEffect(() => {
    if (paperAgentApi === undefined || sessionId === undefined) return
    const version = ++vectorSettingsVersion.current
    void paperAgentApi.getVectorSettings(sessionId).then(result => {
      if (version !== vectorSettingsVersion.current) return
      if (result.ok) {
        setVectorSettings({ embeddingEnabled: result.value.embeddingEnabled, elasticsearchEnabled: result.value.elasticsearchEnabled, rerankerEnabled: result.value.rerankerEnabled })
        setRerankerAvailable(result.value.rerankerAvailable === true)
        setVectorSettingsError(undefined)
      }
      else setVectorSettingsError(result.error.message)
    }).catch(error => { if (version === vectorSettingsVersion.current) setVectorSettingsError(messageOf(error)) })
  }, [paperAgentApi, sessionId])
  const changeVectorSetting = async (key: keyof VectorSettings) => {
    if (paperAgentApi === undefined || vectorSettingsBusy) return
    if (sessionId === undefined) { setVectorSettingsError('请先打开一个对话，再修改向量索引设置。'); return }
    ++vectorSettingsVersion.current
    const previous = vectorSettings
    const next = { ...vectorSettings, [key]: !vectorSettings[key] }
    // Keep the switch responsive. A failed Host write is the only path that
    // rolls the visual value back to the preceding durable state.
    setVectorSettings(next)
    setVectorSettingsBusy(true)
    setVectorSettingsError(undefined)
    try {
      const result = await paperAgentApi.setVectorSettings(sessionId, next)
      if (!result.ok) throw new Error(result.error.message)
      if (result.value[key] !== next[key]) throw new Error('PaperAgent 未保存该开关状态；请检查当前 DSH 会话和插件日志。')
      setVectorSettings({ embeddingEnabled: result.value.embeddingEnabled, elasticsearchEnabled: result.value.elasticsearchEnabled, rerankerEnabled: result.value.rerankerEnabled })
      setRerankerAvailable(result.value.rerankerAvailable === true)
    } catch (error) { setVectorSettings(previous); setVectorSettingsError(messageOf(error)) } finally { setVectorSettingsBusy(false) }
  }
  if (api === undefined || paperAgentApi === undefined || currentSessionId === undefined || onCredentialUpdated === undefined) return null
  return <VectorSettingsContext.Provider value={{ value: vectorSettings, rerankerAvailable, busy: vectorSettingsBusy, error: vectorSettingsError, change: key => { void changeVectorSetting(key) } }}><section className={css.section} aria-label="PaperAgent 设置">
    <h2 className={css.title}>PaperAgent</h2>
    <CredentialEditor api={api} onCredentialUpdated={onCredentialUpdated} credentialRef={MINERU_TOKEN_REF} inputId="paperagent-mineru-token" title="MinerU Token" label="API Token" emptyPlaceholder="粘贴 MinerU Token" configuredPlaceholder="已配置；输入新 Token 以替换" hint={<>仅粘贴 MinerU API 管理页创建的 Token 本身，不要包含 <code>Bearer</code> 或 <code>MINERU_API_TOKEN=</code>。</>} clearConfirm="确认清除 MinerU Token 吗？后续论文解析将无法启动。" validate={validateMineruToken}/>
    <CredentialEditor api={api} onCredentialUpdated={onCredentialUpdated} credentialRef={DASHSCOPE_API_KEY_REF} inputId="paperagent-dashscope-api-key" title="DashScope API Key" label="API Key" emptyPlaceholder="粘贴 DashScope API Key" configuredPlaceholder="已配置；输入新 API Key 以替换" hint={<>用于后续生成论文文本、图表和公式的多模态向量；请只粘贴 DashScope API Key 本身。</>} clearConfirm="确认清除 DashScope API Key 吗？启用向量索引后将无法生成 embedding。" validate={validateDashScopeApiKey}/>
    <CredentialEditor api={api} onCredentialUpdated={onCredentialUpdated} credentialRef={ELASTICSEARCH_API_KEY_REF} inputId="paperagent-elasticsearch-api-key" title="Elasticsearch API Key" label="API Key" emptyPlaceholder="粘贴 Elasticsearch encoded API Key" configuredPlaceholder="已配置；输入新 API Key 以替换" hint={<>粘贴 Elasticsearch 创建 API Key 后返回的 <code>encoded</code> 值，不要粘贴 <code>id</code>、<code>api_key</code>、<code>ApiKey</code> 前缀或 JSON 响应。</>} clearConfirm="确认清除 Elasticsearch API Key 吗？后续启用向量检索后将无法连接本地 Elasticsearch。" validate={validateElasticsearchApiKey} testConnection={async () => {
      const response = await paperAgentApi.testElasticsearch(currentSessionId() ?? 'paperagent-settings')
      if (!response.ok) throw new Error(response.error.message)
      return `连接成功：${response.value.clusterName} / ${response.value.nodeName} / ${response.value.version}`
    }}/>
  </section></VectorSettingsContext.Provider>
}

interface CredentialEditorProps extends Pick<PaperAgentSettingsInjected, 'api' | 'onCredentialUpdated'> {
  readonly credentialRef: string; readonly inputId: string; readonly title: string; readonly label: string
  readonly emptyPlaceholder: string; readonly configuredPlaceholder: string; readonly hint: ReactNode
  readonly clearConfirm: string; readonly validate: (draft: string) => ValidationResult
  /** Optional Host-only health check for this credential's service. */
  readonly testConnection?: () => Promise<string>
}

function CredentialEditor(props: CredentialEditorProps) {
  const { api, onCredentialUpdated, credentialRef, inputId, title, label, emptyPlaceholder, configuredPlaceholder, hint, clearConfirm, validate } = props
  const vectorSettings = useContext(VectorSettingsContext)
  const vectorSettingsForCredential = credentialRef === DASHSCOPE_API_KEY_REF
    ? [
      { key: 'embeddingEnabled' as const, label: '启用 Embedding' },
      ...(vectorSettings?.rerankerAvailable === true ? [{ key: 'rerankerEnabled' as const, label: '启用 DashScope Reranker' }] : []),
    ]
    : credentialRef === ELASTICSEARCH_API_KEY_REF
      ? [{ key: 'elasticsearchEnabled' as const, label: '启用 Elasticsearch 索引' }]
      : []
  const [credential, setCredential] = useState<CredentialState>(INITIAL)
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  const refresh = useCallback(async () => {
    setCredential(({ error: _error, ...previous }) => ({ ...previous, status: 'loading' }))
    try {
      const response = await api.credentials.describe({ refs: [credentialRef] })
      if (!response.result.ok) throw new Error(response.result.error.message)
      const next = response.result.value.credentials[credentialRef]
      if (next === undefined) throw new Error(`凭据服务未返回 ${title} 状态。`)
      setCredential({ status: 'ready', configured: next.configured, writable: next.writable, ...next.source === undefined ? {} : { source: next.source } })
    } catch (error) { setCredential({ status: 'error', configured: false, writable: false, error: messageOf(error) }) }
  }, [api, credentialRef, title])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => onCredentialUpdated(() => { void refresh() }), [onCredentialUpdated, refresh])

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (saving || !credential.writable) return
    // The feature switch is persisted independently. When a credential is
    // already stored, an empty draft means “keep the existing secret”, not
    // “replace it with an empty value”.
    if (value.trim() === '' && credential.configured) {
      setNotice('已保留当前配置的凭据。')
      setEditing(false)
      return
    }
    const result = validate(value)
    if (!result.ok) { setNotice(result.message); return }
    setSaving(true); setNotice(undefined)
    try {
      const response = await api.credentials.set({ ref: credentialRef, value: result.value })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setValue(''); setNotice(`${title} 已保存。`); setEditing(false); await refresh()
    } catch (error) { setNotice(`保存失败：${messageOf(error)}`) } finally { setSaving(false) }
  }
  const clear = async () => {
    if (saving || !credential.writable || !credential.configured || !window.confirm(clearConfirm)) return
    setSaving(true); setNotice(undefined)
    try {
      const response = await api.credentials.unset({ ref: credentialRef })
      if (!response.result.ok) throw new Error(response.result.error.message)
      setNotice(`${title} 已清除。`); await refresh()
    } catch (error) { setNotice(`清除失败：${messageOf(error)}`) } finally { setSaving(false) }
  }
  const testConnection = async () => {
    if (props.testConnection === undefined || testing || credential.status === 'loading') return
    setTesting(true); setNotice(undefined)
    try {
      setNotice(await props.testConnection())
    } catch (error) { setNotice(`连接失败：${messageOf(error)}`) } finally { setTesting(false) }
  }
  const disabled = saving || credential.status === 'loading' || !credential.writable
  const state = credential.status === 'loading'
    ? { className: css.credentialDotLoading, label: '正在读取配置' }
    : credential.status === 'error'
      ? { className: css.credentialDotMissing, label: '无法读取配置' }
      : credential.configured
        ? { className: css.credentialDotConfigured, label: `已配置${credential.source === undefined ? '' : `（${credential.source}）`}` }
        : { className: css.credentialDotMissing, label: '未配置' }
  return <form className={css.editor} onSubmit={event => { void save(event) }}>
    <div className={css.editorHeader}>
      <span className={css.editorIdentity}>
        <span className={css.editorTitle}>{title}</span>
        <span className={`${css.credentialDot} ${state.className}`} role="img" aria-label={state.label} title={state.label}/>
      </span>
      <Button
        variant="ghost"
        size="sm"
        icon={<IconEditOutline16/>}
        aria-expanded={editing}
        aria-controls={`${inputId}-editor`}
        onClick={() => { setNotice(undefined); setEditing(open => !open) }}
      >编辑</Button>
    </div>
    {editing && <div id={`${inputId}-editor`} className={css.editorBody}>
      <div className={css.field}>
        <label className={css.fieldLabel} htmlFor={inputId}>{label}</label>
        <input id={inputId} className={css.input} type="password" autoComplete="off" value={value} placeholder={credential.configured ? configuredPlaceholder : emptyPlaceholder} onChange={event => setValue(event.currentTarget.value)} disabled={disabled}/>
        <p className={css.hint}>{hint}</p>
      </div>
      {vectorSettingsForCredential.map(vectorSetting => vectorSettings !== undefined && <button key={vectorSetting.key} type="button" role="switch" aria-checked={vectorSettings.value[vectorSetting.key]} disabled={vectorSettings.busy} className={`${css.featureToggle} ${vectorSettings.value[vectorSetting.key] ? css.featureToggleOn : ''}`} onClick={() => vectorSettings.change(vectorSetting.key)}><span className={css.featureToggleTrack} aria-hidden="true"/><span>{vectorSetting.label}</span></button>)}
      {vectorSettingsForCredential.length > 0 && vectorSettings?.error !== undefined && <p className={css.error}>{vectorSettings.error}</p>}
      {!credential.writable && credential.status === 'ready' && <p className={css.hint}>当前凭据来自启动环境，不能在页面中修改；请修改启动环境后重启 DSH。</p>}
      {credential.error !== undefined && <p className={css.error}>{credential.error}</p>}
      {notice !== undefined && <p className={css.notice}>{notice}</p>}
      <div className={css.editorActions}>
        {props.testConnection !== undefined && <Button variant="outline" size="sm" onClick={() => { void testConnection() }} disabled={testing || credential.status === 'loading'}>{testing ? '测试中…' : '测试连接'}</Button>}
        {credential.configured && <Button variant="outline" size="sm" className={css.clearButton} onClick={() => { void clear() }} disabled={disabled}>清除</Button>}
        <Button variant="outline" size="sm" onClick={() => { setValue(''); setNotice(undefined); setEditing(false) }} disabled={saving}>取消</Button>
        <Button type="submit" variant="primary" size="sm" disabled={disabled}>{saving ? '保存中…' : '保存'}</Button>
      </div>
    </div>}
  </form>
}

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function validateMineruToken(draft: string): ValidationResult {
  const value = draft.trim()
  if (value === '') return { ok: false, message: '请输入 MinerU Token。' }
  if (/^bearer\s+/i.test(value)) return { ok: false, message: '请只输入 Token 本身，不要包含 Bearer 前缀。' }
  if (/^[A-Z_][A-Z0-9_]*\s*=/.test(value)) return { ok: false, message: '请只输入 Token 值，不要粘贴 MINERU_API_TOKEN= 整行。' }
  if (/^(['"]).*\1$/.test(value)) return { ok: false, message: '请移除 Token 两侧的引号后再保存。' }
  return /\s/.test(value) ? { ok: false, message: 'MinerU Token 不能包含空白字符。' } : { ok: true, value }
}
function validateElasticsearchApiKey(draft: string): ValidationResult {
  const value = draft.trim()
  if (value === '') return { ok: false, message: '请输入 Elasticsearch API Key。' }
  if (/^apikey\s+/i.test(value)) return { ok: false, message: '请只输入 encoded 值，不要包含 ApiKey 前缀。' }
  if (/^[A-Z_][A-Z0-9_]*\s*=/.test(value)) return { ok: false, message: '请只输入 API Key 值，不要粘贴 PAPERAGENT_ES_API_KEY= 整行。' }
  if (/^(['"]).*\1$/.test(value)) return { ok: false, message: '请移除 API Key 两侧的引号后再保存。' }
  if (/\s/.test(value)) return { ok: false, message: 'Elasticsearch API Key 不能包含空白字符。' }
  return value.length < 16 ? { ok: false, message: 'API Key 长度异常；请粘贴 Elasticsearch 返回的 encoded 值。' } : { ok: true, value }
}

function validateDashScopeApiKey(draft: string): ValidationResult {
  const value = draft.trim()
  if (value === '') return { ok: false, message: '请输入 DashScope API Key。' }
  if (/^bearer\s+/i.test(value)) return { ok: false, message: '请只输入 API Key 本身，不要包含 Bearer 前缀。' }
  if (/^[A-Z_][A-Z0-9_]*\s*=/.test(value)) return { ok: false, message: '请只输入 API Key 值，不要粘贴 DASHSCOPE_API_KEY= 整行。' }
  if (/^(['"]).*\1$/.test(value)) return { ok: false, message: '请移除 API Key 两侧的引号后再保存。' }
  return /\s/.test(value) ? { ok: false, message: 'DashScope API Key 不能包含空白字符。' } : { ok: true, value }
}
