import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
} from 'react'
import { confirm } from '@tauri-apps/plugin-dialog'
import { motion, AnimatePresence } from 'framer-motion'
import {
  GATEWAY_SPECS,
  PRIMARY_MODEL_FIELDS,
  SSE_INACTIVITY_MS,
  MAX_BUFFER_LEN,
} from './constants'
import {
  chatReducer,
  loadState,
  maybeUpdateSessionTitle,
  saveState,
  sessionPreview,
} from './store'
import {
  exportBackendSnapshot,
  importBackendSnapshot,
  loadModels as fetchModels,
  loadSettings as fetchSettings,
  pingSidecar,
  saveSettings as postSettings,
  selectLlm,
  baseUrl,
  setSidecarPort,
  startSidecar as startSidecarCmd,
  stopGeneration as stopGenerationCmd,
  stopSidecar,
  waitForSidecar,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
} from './api'
import { Markdown } from './markdown'
import { Timeline } from './timeline'
import { autoResizeTextarea, createSession, formatTime, formatUpdatedAt, parseListValue, parseSse } from './utils'
import type {
  DiagnosticsPayload,
  FieldSpec,
  LlmOption,
  SettingsState,
  UiMessage,
} from './types'

function settingsReducer(
  state: SettingsState,
  action: Partial<SettingsState> | 'reset' | ((prev: SettingsState) => Partial<SettingsState>)
): SettingsState {
  if (action === 'reset') {
    return {
      open: false,
      loading: false,
      saving: false,
      dirty: false,
      error: '',
      env: {},
      mykey: {},
      diagnostics: null,
    }
  }
  const partial = typeof action === 'function' ? action(state) : action
  return { ...state, ...partial }
}

const initialSettings: SettingsState = {
  open: false,
  loading: false,
  saving: false,
  dirty: false,
  error: '',
  env: {},
  mykey: {},
  diagnostics: null,
}

function FieldInput({
  field,
  value,
  onChange,
}: {
  field: FieldSpec
  value: string
  onChange: (scope: 'env' | 'mykey', key: string, value: string) => void
}): ReactElement {
  return (
    <label className={`form-field ${field.multiline ? 'form-field-wide' : ''}`}>
      <span>{field.label}</span>
      {field.multiline ? (
        <textarea
          className="settings-textarea"
          data-scope={field.scope}
          data-key={field.key}
          data-format={field.multiline ? 'list' : undefined}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => onChange(field.scope, field.key, event.target.value)}
          rows={3}
        />
      ) : (
        <input
          className="settings-input"
          data-scope={field.scope}
          data-key={field.key}
          type={field.secret ? 'password' : 'text'}
          placeholder={field.placeholder}
          value={value}
          onChange={(event) => onChange(field.scope, field.key, event.target.value)}
        />
      )}
      {field.hint && <small>{field.hint}</small>}
    </label>
  )
}

export function App(): ReactElement {
  const [chatState, dispatch] = useReducer(chatReducer, null, () => loadState())
  const [settings, setSettings] = useReducer(settingsReducer, initialSettings)

  const [port, setPort] = useState<number | null>(null)
  const [sidecarReady, setSidecarReady] = useState(false)
  const [agentReady, setAgentReady] = useState(false)
  const [streaming, setStreaming] = useState(false)
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null)
  const [llmOptions, setLlmOptions] = useState<LlmOption[]>([])
  const [selectedLlmLabel, setSelectedLlmLabel] = useState('模型未就绪')
  const [maximized, setMaximized] = useState(false)

  const sourceRef = useRef<AbortController | null>(null)
  const sseTimeoutRef = useRef<number | null>(null)
  const healthTimerRef = useRef<number | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const streamingRef = useRef(streaming)
  const activeSessionIdRef = useRef(chatState.activeSessionId)

  useEffect(() => {
    streamingRef.current = streaming
  }, [streaming])

  useEffect(() => {
    activeSessionIdRef.current = chatState.activeSessionId
  }, [chatState.activeSessionId])

  const session = useMemo(() => {
    const found = chatState.sessions.find((item) => item.id === chatState.activeSessionId)
    return found ?? chatState.sessions[0] ?? createSession()
  }, [chatState])

  const sessionsSorted = useMemo(
    () => [...chatState.sessions].sort((left, right) => right.updatedAt - left.updatedAt),
    [chatState.sessions]
  )

  const closeStream = useCallback(() => {
    if (sseTimeoutRef.current !== null) {
      window.clearTimeout(sseTimeoutRef.current)
      sseTimeoutRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.abort()
      sourceRef.current = null
    }
    setStreamingMessageId(null)
    setStreaming(false)
  }, [])

  const addSystemMessage = useCallback(
    (text: string) => {
      if (!session) return
      dispatch({ type: 'addMessage', sessionId: session.id, role: 'system', text })
    },
    [session]
  )

  const persistActiveBackendState = useCallback(async () => {
    const snapshot = await exportBackendSnapshot()
    if (!snapshot || !session) return
    dispatch({ type: 'setBackendState', sessionId: session.id, backendState: snapshot })
  }, [session])

  const updateStatusFromDiagnostics = useCallback(
    (diagnostics: DiagnosticsPayload) => {
      setSidecarReady(true)
      setAgentReady(diagnostics.agent.ready)
      setSettings({ diagnostics })
      if (diagnostics.agent.ready) {
        const label = diagnostics.agent.llmName || selectedLlmLabel || '模型就绪'
        setSelectedLlmLabel(label)
      } else {
        setSelectedLlmLabel('模型未就绪')
      }
    },
    [selectedLlmLabel]
  )

  const ping = useCallback(async () => {
    if (!port) return
    try {
      const diagnostics = await pingSidecar()
      updateStatusFromDiagnostics(diagnostics)
    } catch (_error) {
      setSidecarReady(false)
      setAgentReady(false)
    }
  }, [port, updateStatusFromDiagnostics])

  const loadBackendForCurrentSession = useCallback(async () => {
    if (!port || !sidecarReady || !agentReady || !session) return
    await importBackendSnapshot(session.backendState)
    try {
      const options = await fetchModels()
      setLlmOptions(options)
      const current = options.find((option) => option.current)
      setSelectedLlmLabel(current?.label || '模型已就绪')
    } catch {
      setSelectedLlmLabel('模型列表加载失败')
    }
    try {
      const diagnostics = await pingSidecar()
      setAgentReady(diagnostics.agent.ready)
    } catch {
      setAgentReady(false)
    }
  }, [port, sidecarReady, agentReady, session])

  const loadModelsAndPing = useCallback(async () => {
    try {
      const options = await fetchModels()
      setLlmOptions(options)
      const current = options.find((option) => option.current)
      setSelectedLlmLabel(current?.label || '模型已就绪')
    } catch {
      setSelectedLlmLabel('模型列表加载失败')
    }
    await ping()
  }, [ping])

  const loadSettings = useCallback(
    async (force = false) => {
      if (!port || (!force && settings.loading)) return
      setSettings({ loading: true, error: '' })
      try {
        const payload = await fetchSettings()
        setSettings({
          env: payload.env,
          mykey: payload.mykey,
          diagnostics: payload.diagnostics,
          dirty: false,
          error: '',
        })
      } catch (error) {
        setSettings({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        setSettings({ loading: false })
      }
    },
    [port, settings.loading]
  )

  const startSidecar = useCallback(
    async (forceRestart = false) => {
      try {
        if (forceRestart) {
          closeStream()
          await persistActiveBackendState()
          await stopSidecar()
          setPort(null)
          setSidecarPort(null)
          setSidecarReady(false)
          setAgentReady(false)
        }

        const nextPort = await startSidecarCmd()
        setPort(nextPort)
        setSidecarPort(nextPort)
        const ready = await waitForSidecar()
        if (!ready) {
          setSidecarReady(false)
          setAgentReady(false)
          return
        }

        const diagnostics = await pingSidecar()
        updateStatusFromDiagnostics(diagnostics)
        await loadSettings(true)
        if (diagnostics.agent.ready) {
          const options = await fetchModels()
          setLlmOptions(options)
          const current = options.find((option) => option.current)
          setSelectedLlmLabel(current?.label || '模型已就绪')
          await loadBackendForCurrentSession()
        }

        if (healthTimerRef.current !== null) window.clearInterval(healthTimerRef.current)
        healthTimerRef.current = window.setInterval(() => {
          void ping()
        }, 5000)
        saveState(chatState)
      } catch (_error) {
        setSidecarReady(false)
        setAgentReady(false)
      }
    },
    [chatState, closeStream, loadBackendForCurrentSession, loadSettings, persistActiveBackendState, ping, updateStatusFromDiagnostics]
  )

  useEffect(() => {
    let attempts = 0
    const maxAttempts = 3
    const tryStart = async () => {
      attempts += 1
      try {
        await startSidecar()
      } catch (_error) {
        if (attempts < maxAttempts) {
          window.setTimeout(() => {
            void tryStart()
          }, 1500 * attempts)
        }
      }
    }
    void tryStart()
    return () => {
      if (healthTimerRef.current !== null) window.clearInterval(healthTimerRef.current)
      closeStream()
      saveState(chatState)
    }
  }, [])

  useEffect(() => {
    saveState(chatState)
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight
    }
  }, [chatState])

  useEffect(() => {
    if (textareaRef.current) autoResizeTextarea(textareaRef.current)
  }, [session?.draft])

  const handleSwitchSession = useCallback(
    async (sessionId: string) => {
      if (streamingRef.current) {
        addSystemMessage('当前正在生成中，请先停止后再切换会话。')
        return
      }
      if (sessionId === activeSessionIdRef.current) return
      await persistActiveBackendState()
      dispatch({ type: 'switchSession', sessionId })
      const target = chatState.sessions.find((item) => item.id === sessionId)
      if (target && port && sidecarReady && agentReady) {
        await importBackendSnapshot(target.backendState)
        await loadModelsAndPing()
      }
    },
    [addSystemMessage, chatState.sessions, loadModelsAndPing, persistActiveBackendState, port, sidecarReady, agentReady]
  )

  const handleCreateSession = useCallback(async () => {
    if (streamingRef.current) {
      addSystemMessage('当前正在生成中，请先停止后再新建会话。')
      return
    }
    await persistActiveBackendState()
    dispatch({ type: 'createSession' })
    if (port && sidecarReady && agentReady) {
      await importBackendSnapshot(null)
      await loadModelsAndPing()
    }
  }, [addSystemMessage, loadModelsAndPing, persistActiveBackendState, port, sidecarReady, agentReady])

  const handleRenameSession = useCallback(async () => {
    if (!session) return
    let nextTitle: string | null = null
    try {
      nextTitle = window.prompt('输入新的会话名', session.title)
    } catch {
      addSystemMessage('当前环境不支持系统输入框，请稍后再试。')
      return
    }
    if (!nextTitle) return
    dispatch({ type: 'renameCurrent', title: nextTitle })
  }, [session, addSystemMessage])

  const handleDeleteSession = useCallback(async () => {
    if (streamingRef.current) {
      addSystemMessage('当前正在生成中，请先停止后再删除会话。')
      return
    }
    if (!session) return
    const confirmed = await confirm(`删除会话“${session.title}”？`, {
      title: '删除会话',
      kind: 'warning',
    })
    if (!confirmed) return
    await persistActiveBackendState()
    const remaining = chatState.sessions.filter((item) => item.id !== session.id)
    if (!remaining.length) remaining.push(createSession())
    dispatch({ type: 'deleteCurrent' })
    if (port && sidecarReady && agentReady) {
      await importBackendSnapshot(remaining[0].backendState)
      await loadModelsAndPing()
    }
  }, [addSystemMessage, chatState.sessions, loadModelsAndPing, persistActiveBackendState, port, session, sidecarReady, agentReady])

  const handleSend = useCallback(async () => {
    if (!port || streamingRef.current || !session) return
    const text = session.draft.trim()
    if (!text) return
    if (!sidecarReady) {
      addSystemMessage('当前 sidecar 未就绪，请先等待连接恢复。')
      return
    }
    if (!agentReady) {
      addSystemMessage('当前 agent 未就绪，请打开设置页补齐模型配置后再发送。')
      setSettings({ open: true })
      return
    }

    const titleUpdate = maybeUpdateSessionTitle(session, text)
    if (titleUpdate !== session) {
      dispatch({ type: 'renameCurrent', title: titleUpdate.title })
    }

    dispatch({ type: 'addMessage', sessionId: session.id, role: 'user', text })
    dispatch({ type: 'setDraft', sessionId: session.id, draft: '' })

    const assistantMessage: UiMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'assistant',
      text: '思考中…',
      createdAt: Date.now(),
      timeline: null,
    }
    const currentSessionId = session.id
    const currentMessageId = assistantMessage.id
    dispatch({
      type: 'addMessage',
      sessionId: currentSessionId,
      role: 'assistant',
      text: assistantMessage.text,
      extras: { id: currentMessageId, timeline: null },
    })
    closeStream()

    setStreamingMessageId(currentMessageId)
    setStreaming(true)

    const params = new URLSearchParams()
    if (text) params.set('q', text)

    let buffer = ''
    const resetSseTimeout = () => {
      if (sseTimeoutRef.current !== null) window.clearTimeout(sseTimeoutRef.current)
      sseTimeoutRef.current = window.setTimeout(() => {
        if (streamingRef.current) {
          dispatch({
            type: 'updateMessage',
            sessionId: currentSessionId,
            id: currentMessageId,
            patch: { text: buffer || '响应超时，连接已关闭' },
          })
        }
        closeStream()
        void ping()
      }, SSE_INACTIVITY_MS)
    }

    const controller = new AbortController()
    sourceRef.current = controller

    const finishWithError = () => {
      if (streamingRef.current) {
        dispatch({
          type: 'updateMessage',
          sessionId: currentSessionId,
          id: currentMessageId,
          patch: { text: buffer || '连接中断' },
        })
      }
      closeStream()
      void ping()
    }

    const consumeStream = async () => {
      let streamCompleted = false
      try {
        const response = await fetch(`${baseUrl()}/chat?${params.toString()}`, {
          signal: controller.signal,
          headers: { Accept: 'text/event-stream' },
        })
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`)
        }
        if (!response.body) {
          throw new Error('No response body')
        }
        resetSseTimeout()
        const reader = response.body.getReader()
        for await (const event of parseSse(reader)) {
          if (sourceRef.current !== controller) break
          resetSseTimeout()
          if (event.event === 'timeline') {
            if (!currentMessageId) continue
            try {
              const timeline = JSON.parse(event.data) as UiMessage['timeline']
              dispatch({
                type: 'updateMessage',
                sessionId: currentSessionId,
                id: currentMessageId,
                patch: { timeline },
              })
            } catch {
              // ignore malformed timeline payloads
            }
          } else if (event.event === 'done') {
            const data = event.data || buffer
            if (currentMessageId) {
              dispatch({
                type: 'updateMessage',
                sessionId: currentSessionId,
                id: currentMessageId,
                patch: { text: data },
              })
            }
            streamCompleted = true
            closeStream()
            void persistActiveBackendState()
            void ping()
            break
          } else {
            buffer += event.data
            if (buffer.length > MAX_BUFFER_LEN) buffer = buffer.slice(-MAX_BUFFER_LEN)
            if (currentMessageId) {
              dispatch({
                type: 'updateMessage',
                sessionId: currentSessionId,
                id: currentMessageId,
                patch: { text: buffer },
              })
            }
          }
        }
        if (!streamCompleted && sourceRef.current === controller) {
          finishWithError()
        }
      } catch (_error) {
        if (sourceRef.current !== controller) return
        finishWithError()
      }
    }

    void consumeStream()
  }, [
    port,
    session,
    sidecarReady,
    agentReady,
    addSystemMessage,
    selectedLlmLabel,
    closeStream,
    dispatch,
    persistActiveBackendState,
    ping,
  ])

  const handleStop = useCallback(async () => {
    try {
      await stopGenerationCmd()
    } catch {
      // ignore
    }
    closeStream()
    void ping()
  }, [closeStream, ping])

  const handleLlmChange = useCallback(
    async (event: FormEvent<HTMLSelectElement>) => {
      if (!port || !agentReady) return
      const idx = Number(event.currentTarget.value)
      try {
        await selectLlm(idx)
        const options = await fetchModels()
        setLlmOptions(options)
        const current = options.find((option) => option.current)
        setSelectedLlmLabel(current?.label || '模型已切换')
        addSystemMessage(`已切换到 ${current?.label || '模型已切换'}`)
        const snapshot = await exportBackendSnapshot()
        if (snapshot && session) {
          dispatch({ type: 'setBackendState', sessionId: session.id, backendState: snapshot })
        }
        await ping()
      } catch (error) {
        addSystemMessage(`切换失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [addSystemMessage, agentReady, port, session, ping]
  )

  const handleSaveSettings = useCallback(async () => {
    if (!port || settings.saving) return
    setSettings({ saving: true, error: '' })
    try {
      const payload = await postSettings(settings.env, settings.mykey)
      setSettings({
        env: payload.env,
        mykey: payload.mykey,
        diagnostics: payload.diagnostics,
        dirty: false,
        error: '',
      })
      setAgentReady(payload.diagnostics.agent.ready)
      setSidecarReady(true)
      const options = await fetchModels()
      setLlmOptions(options)
      const current = options.find((option) => option.current)
      setSelectedLlmLabel(current?.label || '模型已就绪')
      await ping()
      addSystemMessage('设置已保存，sidecar 已按当前会话快照重建 agent。')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setSettings({ error: message })
      addSystemMessage(`设置保存失败: ${message}`)
    } finally {
      setSettings({ saving: false })
    }
  }, [addSystemMessage, port, settings.dirty, settings.env, settings.mykey, settings.saving, ping])

  const updateField = useCallback(
    (scope: 'env' | 'mykey', key: string, value: string) => {
      const field = [...PRIMARY_MODEL_FIELDS, ...GATEWAY_SPECS.flatMap((spec) => spec.fields)].find(
        (item) => item.scope === scope && item.key === key
      )
      const nextValue = field?.multiline ? parseListValue(value) : value
      setSettings((prev) => ({
        ...prev,
        [scope]: { ...prev[scope], [key]: nextValue },
        dirty: true,
      }))
    },
    []
  )

  const getFieldValue = useCallback(
    (field: FieldSpec): string => {
      const source = field.scope === 'env' ? settings.env : settings.mykey
      const value = source[field.key]
      if (Array.isArray(value)) return value.map((item) => String(item)).join('\n')
      return value == null ? '' : String(value)
    },
    [settings.env, settings.mykey]
  )

  const renderExtraEnvKeys = useMemo(() => {
    const primaryKeys = new Set([
      ...PRIMARY_MODEL_FIELDS.map((field) => field.key),
      ...GATEWAY_SPECS.flatMap((spec) => spec.fields.filter((field) => field.scope === 'env').map((field) => field.key)),
    ])
    return Object.keys(settings.env)
      .filter((key) => !primaryKeys.has(key))
      .sort()
  }, [settings.env])

  const settingsStateLabel = useMemo(() => {
    if (settings.saving) return '保存中'
    if (settings.loading) return '加载中'
    if (settings.dirty) return '未保存更改'
    if (settings.error) return '加载失败'
    if (settings.diagnostics) return '配置已加载'
    return '未加载'
  }, [settings.dirty, settings.error, settings.loading, settings.saving, settings.diagnostics])

  const renderSettingsBody = () => {
    if (settings.loading && !settings.diagnostics && !Object.keys(settings.env).length) {
      return <div className="settings-loading">正在加载配置与诊断信息…</div>
    }

    return (
      <>
        {settings.error && (
          <div className="settings-error">配置加载失败：{settings.error}</div>
        )}
        <section className="settings-section">
          <div className="section-heading">
            <div>
              <h3>模型配置</h3>
              <p className="settings-copy">
                对应项目根目录下的 <code>.env</code>。保存后 sidecar 会用当前会话快照重建 agent。
              </p>
            </div>
          </div>
          <div className="form-grid">
            {PRIMARY_MODEL_FIELDS.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={getFieldValue(field)}
                onChange={updateField}
              />
            ))}
          </div>
        </section>

        {renderExtraEnvKeys.length > 0 && (
          <section className="settings-section">
            <div className="section-heading">
              <div>
                <h3>其他环境变量</h3>
                <p className="settings-copy">保留已存在但未放进主表单的附加字段，例如多模型或 tracing 配置。</p>
              </div>
            </div>
            <div className="form-grid">
              {renderExtraEnvKeys.map((key) => (
                <FieldInput
                  key={key}
                  field={{ scope: 'env', key, label: key }}
                  value={String(settings.env[key] ?? '')}
                  onChange={updateField}
                />
              ))}
            </div>
          </section>
        )}

        <section className="settings-section">
          <div className="section-heading">
            <div>
              <h3>Gateway 配置</h3>
              <p className="settings-copy">统一维护机器人网关凭证、允许用户和监听端口。</p>
            </div>
          </div>
          <div className="gateway-grid">
            {GATEWAY_SPECS.map((spec) => {
              const diagnostic = settings.diagnostics?.gateways.find((item) => item.id === spec.id)
              const statusText = diagnostic?.configured
                ? '已配置'
                : diagnostic
                  ? `缺少 ${diagnostic.requiredMissing.join(', ')}`
                  : '待检测'
              return (
                <article className="gateway-card" key={spec.id}>
                  <div className="gateway-card-head">
                    <div>
                      <h4>{spec.label}</h4>
                      <p>{spec.description}</p>
                    </div>
                    <span className={`gateway-state ${diagnostic?.configured ? 'ok' : 'warn'}`}>
                      {statusText}
                    </span>
                  </div>
                  <div className="form-grid">
                    {spec.fields.map((field) => (
                      <FieldInput
                        key={field.key}
                        field={field}
                        value={getFieldValue(field)}
                        onChange={updateField}
                      />
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <section className="settings-section">
          <div className="section-heading">
            <div>
              <h3>运行诊断</h3>
              <p className="settings-copy">查看 sidecar、agent 和 gateway 当前运行状态。</p>
            </div>
          </div>
          {settings.diagnostics ? renderDiagnostics(settings.diagnostics) : (
            <p className="settings-copy">尚未获取到诊断信息。</p>
          )}
        </section>
      </>
    )
  }

  return (
    <div className="shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="chat-layout">
        <aside className="chat-sidebar">
          <div className="sidebar-brand">
            <div className="brand-mark">O</div>
            <div className="brand-text">
              <div className="brand-name">Orion</div>
              <div className="brand-tag">本地 Agent</div>
            </div>
          </div>

          <div className="sidebar-card sessions-card">
            <div className="card-header">
              <span className="card-title">会话</span>
              <div className="header-actions">
                <button className="icon-btn" title="新建会话" onClick={handleCreateSession}>+</button>
                <button className="icon-btn" title="重命名" onClick={handleRenameSession}>✎</button>
                <button className="icon-btn danger" title="删除当前会话" onClick={handleDeleteSession}>🗑</button>
              </div>
            </div>
            <div className="session-list">
              {sessionsSorted.map((item) => (
                <button
                  key={item.id}
                  className={`session-item ${item.id === session?.id ? 'active' : ''}`}
                  onClick={() => void handleSwitchSession(item.id)}
                >
                  <div className="session-title">{item.title}</div>
                  <div className="session-preview">{sessionPreview(item)}</div>
                  <div className="session-time">{formatUpdatedAt(item.updatedAt)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="sidebar-actions">
            <button className="action-btn" onClick={() => setSettings({ open: true })}>
              <span className="action-icon">⚙</span>
              <span>设置</span>
            </button>
          </div>
        </aside>

        <div className="chat-main">
          <header className="window-bar">
            <div className="window-controls">
              <button className="window-btn" title="最小化" onClick={() => void minimizeWindow()}>-</button>
              <button
                className="window-btn"
                title="最大化"
                onClick={async () => {
                  try {
                    const next = await toggleMaximizeWindow()
                    setMaximized(next)
                  } catch (error) {
                    addSystemMessage(`窗口缩放失败: ${error instanceof Error ? error.message : String(error)}`)
                  }
                }}
              >
                {maximized ? '◱' : '+'}
              </button>
              <button className="window-btn close" title="关闭" onClick={() => void closeWindow()}>x</button>
            </div>
          </header>

          <section ref={messagesRef} className="messages">
            {session && session.messages.length === 0 && (
              <div className="empty-state">
                <div className="empty-logo">O</div>
                <h2>有什么我能帮你的吗</h2>
                <p>直接输入任务、命令或问题，Orion 会在本地 sidecar 中执行。</p>
              </div>
            )}
            <AnimatePresence initial={false}>
              {session?.messages.map((message) => (
                <motion.article
                  key={message.id}
                  className={`msg ${message.role}`}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                >
                  <div className="msg-meta">
                    <span className="msg-role">
                      {message.role === 'user' ? '你' : message.role === 'assistant' ? 'Orion' : '系统'}
                    </span>
                    <time className="msg-time">{formatTime(message.createdAt)}</time>
                  </div>
                  <div className="bubble">
                    <Markdown text={message.text} isStreaming={streaming && message.id === streamingMessageId} />
                  </div>
                  {message.role === 'assistant' && <Timeline timeline={message.timeline} />}
                </motion.article>
              ))}
            </AnimatePresence>
          </section>

          <div className="input-area">
            <textarea
              ref={textareaRef}
              rows={1}
              placeholder="输入任务、命令或问题"
              autoComplete="off"
              disabled={streaming || !sidecarReady}
              value={session?.draft || ''}
              onChange={(event) => {
                if (!session) return
                dispatch({ type: 'setDraft', sessionId: session.id, draft: event.target.value })
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault()
                  void handleSend()
                }
              }}
            />
            <div className="input-toolbar">
              <div className="composer-model">
                <select
                  className="model-select"
                  value={llmOptions.find((option) => option.current)?.idx ?? ''}
                  onChange={handleLlmChange}
                  disabled={!agentReady || llmOptions.length === 0}
                >
                  {llmOptions.length === 0 && <option value="">未加载</option>}
                  {llmOptions.map((option) => (
                    <option key={option.idx} value={option.idx}>{option.label}</option>
                  ))}
                </select>
              </div>
              <button
                className={`send-btn ${streaming ? 'hidden' : ''}`}
                title="发送"
                onClick={() => void handleSend()}
                disabled={streaming || !sidecarReady}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
              <button
                className={`stop-btn ${streaming ? '' : 'hidden'}`}
                title="停止"
                onClick={() => void handleStop()}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2"></rect>
                </svg>
              </button>
            </div>
          </div>
          <div className="composer-hint">
            {!sidecarReady
              ? 'sidecar 启动中或连接异常，请等待或重启桌面端'
              : streaming
                ? '生成中，可点击停止按钮中断'
                : 'Enter 换行，Cmd/Ctrl + Enter 发送'}
          </div>
        </div>
      </div>

      <div className={`settings-overlay ${settings.open ? '' : 'hidden'}`}>
        <div className="settings-backdrop" onClick={() => setSettings({ open: false })} />
        <section className="settings-panel">
          <header className="settings-header">
            <div>
              <div className="eyebrow settings-eyebrow">Desktop Settings</div>
              <h2>模型配置、网关配置与运行诊断</h2>
              <p className="settings-copy">
                直接在桌面端维护 <code>.env</code>、<code>mykey.json</code>，并查看 sidecar 当前诊断状态。
              </p>
            </div>
            <div className="settings-actions">
              <div className="settings-state-label">{settingsStateLabel}</div>
              <button
                className="mini-btn"
                onClick={() => void loadSettings(true)}
                disabled={settings.loading || settings.saving || !port}
              >刷新</button>
              <button className="mini-btn" onClick={() => setSettings({ open: false })}>关闭</button>
            </div>
          </header>
          <div className="settings-body">{renderSettingsBody()}</div>
          <footer className="settings-footer">
            <p className="settings-footer-note">
              {settings.error
                ? `加载失败: ${settings.error}`
                : settings.saving
                  ? '正在写回 .env 与 mykey.json...'
                  : settings.dirty
                    ? '存在未保存更改。保存后会按当前会话快照重建 agent。'
                    : '保存后 sidecar 会按当前会话快照重建 agent。'}
            </p>
            <button
              className="primary-btn"
              onClick={() => void handleSaveSettings()}
              disabled={settings.loading || settings.saving || !port}
            >保存配置</button>
          </footer>
        </section>
      </div>
    </div>
  )
}

function renderDiagnostics(diagnostics: DiagnosticsPayload): ReactElement {
  const fileRows = [
    ['.env', diagnostics.files.envExists ? diagnostics.files.envPath : `${diagnostics.files.envPath} (不存在)`],
    ['.env.example', diagnostics.files.envExampleExists ? diagnostics.files.envExamplePath : `${diagnostics.files.envExamplePath} (不存在)`],
    ['mykey.json', diagnostics.files.mykeyExists ? diagnostics.files.mykeyPath : `${diagnostics.files.mykeyPath} (不存在)`],
    ['mykey.template.json', diagnostics.files.mykeyTemplateExists ? diagnostics.files.mykeyTemplatePath : `${diagnostics.files.mykeyTemplatePath} (不存在)`],
  ]

  return (
    <>
      <div className="diagnostics-grid">
        <article className="diagnostic-card">
          <h4>Sidecar</h4>
          <dl>
            <div><dt>PID</dt><dd>{diagnostics.pid}</dd></div>
            <div><dt>Node</dt><dd>{diagnostics.nodeVersion}</dd></div>
            <div><dt>端口</dt><dd>{diagnostics.sidecarPort}</dd></div>
            <div><dt>活跃请求</dt><dd>{diagnostics.activeRequests}</dd></div>
          </dl>
        </article>
        <article className="diagnostic-card">
          <h4>Agent</h4>
          <dl>
            <div><dt>状态</dt><dd>{diagnostics.agent.ready ? '就绪' : '未就绪'}</dd></div>
            <div><dt>当前模型</dt><dd>{diagnostics.agent.llmName || '未加载'}</dd></div>
            <div><dt>LLM 索引</dt><dd>{diagnostics.agent.llmIndex ?? '-'}</dd></div>
            <div><dt>模型数</dt><dd>{diagnostics.agent.llms.length}</dd></div>
          </dl>
          {diagnostics.agent.issue && <pre className="diagnostic-pre">{diagnostics.agent.issue}</pre>}
        </article>
        <article className="diagnostic-card diagnostic-card-wide">
          <h4>路径</h4>
          <dl>
            <div><dt>工作目录</dt><dd>{diagnostics.cwd}</dd></div>
            <div><dt>项目根目录</dt><dd>{diagnostics.projectRoot}</dd></div>
            {fileRows.map(([label, value]) => (
              <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
            ))}
          </dl>
        </article>
      </div>
      <div className="gateway-status-grid">
        {diagnostics.gateways.map((gateway) => (
          <article className="gateway-status-card" key={gateway.id}>
            <div className="gateway-status-head">
              <h4>{gateway.label}</h4>
              <span className={`gateway-state ${gateway.configured ? 'ok' : 'warn'}`}>{gateway.configured ? 'ready' : 'incomplete'}</span>
            </div>
            <p>{gateway.requiredMissing.length ? `缺少 ${gateway.requiredMissing.join(', ')}` : '必填字段已齐全'}</p>
            {gateway.portKey ? <p>{gateway.portKey}: {gateway.portValue || '-'}</p> : <p>无本地 webhook 端口</p>}
            <p>允许用户: {gateway.allowedUsers.length ? gateway.allowedUsers.join(', ') : '未限制'}</p>
          </article>
        ))}
      </div>
    </>
  )
}
