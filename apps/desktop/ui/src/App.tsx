import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import { confirm, open } from '@tauri-apps/plugin-dialog'
import { Bubble, Sender, XProvider } from '@ant-design/x'
import {
  Badge,
  Button,
  Collapse,
  ConfigProvider,
  Drawer,
  Layout,
  List,
  Menu,
  Space,
  Spin,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  DeleteOutlined,
  EditOutlined,
  FolderAddOutlined,
  FolderOutlined,
  MessageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import {
  GATEWAY_SPECS,
  PRIMARY_MODEL_FIELDS,
  SSE_INACTIVITY_MS,
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
  getGitBranch,
} from './api'
import { Markdown } from './markdown'
import {
  createProject,
  createSession,
  formatDuration,
  formatUpdatedAt,
  parseListValue,
  parseSse,
  streamBuffer,
} from './utils'
import type {
  DiagnosticsPayload,
  FieldSpec,
  LlmOption,
  SettingsState,
  TimelineStep,
  UiMessage,
} from './types'

function ThoughtBubble({ children }: { children: string }): ReactElement {
  const [open, setOpen] = useState(false)
  return (
    <div className="thought-bubble">
      <button className="thought-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '隐藏思考' : '思考中…'}
      </button>
      {open && (
        <div className="thought-content">
          <Typography.Text type="secondary">{children}</Typography.Text>
        </div>
      )}
    </div>
  )
}

function ToolGroup({ turn, steps }: { turn: number; steps: TimelineStep[] }): ReactElement {
  const [open, setOpen] = useState(false)
  const running = steps.some((s) => s.status === 'running')
  const done = steps.every((s) => s.status === 'done')
  const status = running ? 'running' : done ? 'done' : 'error'
  return (
    <div className={`tool-group tool-group--${status}`}>
      <button className="tool-group-toggle" onClick={() => setOpen((v) => !v)}>
        {running && <Spin size="small" style={{ marginRight: 8 }} />}
        Turn {turn} · {steps.length} 次操作 · {status}
      </button>
      {open && (
        <div className="tool-group-body">
          {steps.map((step) => (
            <div key={step.id} className="tool-step">
              <Space size={8}>
                <Typography.Text code>{step.toolName}</Typography.Text>
                <Typography.Text type="secondary">{formatDuration(step.durationMs)}</Typography.Text>
              </Space>
              <div>
                <Typography.Text type="secondary">参数：</Typography.Text>
                <Typography.Text code>{JSON.stringify(step.args)}</Typography.Text>
              </div>
              {step.resultSummary && (
                <div>
                  <Typography.Text type="secondary">结果：</Typography.Text>
                  <Typography.Text>{step.resultSummary}</Typography.Text>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function renderMessageContent(message: UiMessage, isStreaming: boolean): ReactNode {
  type Group =
    | { kind: 'text'; content: string }
    | { kind: 'thought'; content: string }
    | { kind: 'tool_group'; turn: number; steps: TimelineStep[] }

  const groups: Group[] = []
  for (const unit of message.units) {
    if (unit.kind === 'text') {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'text') {
        last.content += unit.content
      } else {
        groups.push({ kind: 'text', content: unit.content })
      }
    } else if (unit.kind === 'thought') {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'thought') {
        last.content += unit.content
      } else {
        groups.push({ kind: 'thought', content: unit.content })
      }
    } else if (unit.kind === 'tool') {
      const last = groups[groups.length - 1]
      if (last && last.kind === 'tool_group' && last.turn === unit.step.turn) {
        last.steps.push(unit.step)
      } else {
        groups.push({ kind: 'tool_group', turn: unit.step.turn, steps: [unit.step] })
      }
    }
  }

  if (groups.length === 0 && message.text) {
    groups.push({ kind: 'text', content: message.text })
  }

  return (
    <>
      {groups.map((group, idx) => {
        if (group.kind === 'text') {
          return <Markdown key={`text-${idx}`} text={group.content} isStreaming={isStreaming} />
        }
        if (group.kind === 'thought') {
          return <ThoughtBubble key={`thought-${idx}`}>{group.content}</ThoughtBubble>
        }
        return <ToolGroup key={`tool-${idx}`} turn={group.turn} steps={group.steps} />
      })}
    </>
  )
}

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

  const currentProject = useMemo(
    () => chatState.projects.find((project) => project.id === session?.projectId) ?? null,
    [chatState.projects, session]
  )

  const projectsSorted = useMemo(
    () => [...chatState.projects].sort((left, right) => right.updatedAt - left.updatedAt),
    [chatState.projects]
  )

  const standaloneSessions = useMemo(
    () =>
      chatState.sessions
        .filter((item) => !item.projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
    [chatState.sessions]
  )

  const projectSessions = useCallback(
    (projectId: string) =>
      chatState.sessions
        .filter((item) => item.projectId === projectId)
        .sort((left, right) => right.updatedAt - left.updatedAt),
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

  const handleCreateProjectSession = useCallback(
    async (projectId: string) => {
      if (streamingRef.current) {
        addSystemMessage('当前正在生成中，请先停止后再新建会话。')
        return
      }
      await persistActiveBackendState()
      dispatch({ type: 'createSession', projectId })
      if (port && sidecarReady && agentReady) {
        await importBackendSnapshot(null)
        await loadModelsAndPing()
      }
    },
    [addSystemMessage, loadModelsAndPing, persistActiveBackendState, port, sidecarReady, agentReady]
  )

  const handleDeleteProject = useCallback(
    async (projectId: string) => {
      const project = chatState.projects.find((p) => p.id === projectId)
      if (!project) return
      const confirmed = await confirm(`删除 Project“${project.name}”？关联会话将变为独立会话。`, {
        title: '删除 Project',
        kind: 'warning',
      })
      if (!confirmed) return
      dispatch({ type: 'deleteProject', projectId })
    },
    [chatState.projects]
  )

  const handleRenameProject = useCallback(async (projectId: string) => {
    const project = chatState.projects.find((p) => p.id === projectId)
    if (!project) return
    let nextName: string | null = null
    try {
      nextName = window.prompt('输入新的 Project 名', project.name)
    } catch {
      addSystemMessage('当前环境不支持系统输入框，请稍后再试。')
      return
    }
    if (!nextName) return
    dispatch({ type: 'renameProject', projectId, name: nextName })
  }, [chatState.projects, addSystemMessage])

  const handleToggleExpandProject = useCallback((projectId: string) => {
    dispatch({ type: 'toggleExpandProject', projectId })
  }, [])

  const handleUnbindCurrentProject = useCallback(() => {
    dispatch({ type: 'unbindCurrentProject' })
  }, [])

  const handleAddProjectDirectory = useCallback(async () => {
    let selected: string | string[] | null
    try {
      selected = await open({ directory: true, multiple: false })
    } catch (error) {
      addSystemMessage(`选择目录失败: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const projectPath = Array.isArray(selected) ? selected[0] : selected
    if (!projectPath) return
    console.log('[UI] selected project path:', projectPath)

    const existing = chatState.projects.find((p) => p.path === projectPath)
    if (existing) {
      console.log('[UI] binding to existing project:', existing.id, existing.path)
      dispatch({ type: 'bindCurrentProject', projectId: existing.id })
      return
    }

    let gitBranch: string | null = null
    try {
      gitBranch = await getGitBranch(projectPath)
    } catch {
      gitBranch = null
    }
    const project = createProject(projectPath, gitBranch)
    console.log('[UI] creating and binding project:', project.id, project.path)
    dispatch({ type: 'createProject', project })
    dispatch({ type: 'bindCurrentProject', projectId: project.id })
  }, [addSystemMessage, chatState.projects])

  const handleRefreshProjectBranch = useCallback(async (projectId: string) => {
    const project = chatState.projects.find((p) => p.id === projectId)
    if (!project) return
    try {
      const branch = await getGitBranch(project.path)
      dispatch({ type: 'setProjectGitBranch', projectId, gitBranch: branch })
    } catch {
      dispatch({ type: 'setProjectGitBranch', projectId, gitBranch: null })
    }
  }, [chatState.projects])

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
      text: '',
      thoughts: [],
      units: [],
      createdAt: Date.now(),
    }
    const currentSessionId = session.id
    const currentMessageId = assistantMessage.id
    dispatch({
      type: 'addMessage',
      sessionId: currentSessionId,
      role: 'assistant',
      text: assistantMessage.text,
      extras: { id: currentMessageId, thoughts: [], units: [] },
    })
    closeStream()

    setStreamingMessageId(currentMessageId)
    setStreaming(true)

    const params = new URLSearchParams()
    if (text) params.set('q', text)
    if (currentProject) {
      params.set('cwd', currentProject.path)
      console.log('[UI] sending with cwd:', currentProject.path)
    } else {
      console.log('[UI] sending without cwd, currentProject is null')
    }

    const resetSseTimeout = () => {
      if (sseTimeoutRef.current !== null) window.clearTimeout(sseTimeoutRef.current)
      sseTimeoutRef.current = window.setTimeout(() => {
        if (streamingRef.current && currentMessageId) {
          dispatch({
            type: 'appendText',
            sessionId: currentSessionId,
            id: currentMessageId,
            delta: '响应超时，连接已关闭',
          })
        }
        closeStream()
        void ping()
      }, SSE_INACTIVITY_MS)
    }

    const controller = new AbortController()
    sourceRef.current = controller

    const finishWithError = () => {
      if (streamingRef.current && currentMessageId) {
        dispatch({
          type: 'appendText',
          sessionId: currentSessionId,
          id: currentMessageId,
          delta: '连接中断',
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
        for await (const event of streamBuffer(parseSse(reader))) {
          if (sourceRef.current !== controller) break
          resetSseTimeout()
          if (!currentMessageId) continue
          try {
            if (event.event === 'text') {
              const { delta } = JSON.parse(event.data)
              dispatch({
                type: 'appendText',
                sessionId: currentSessionId,
                id: currentMessageId,
                delta,
              })
            } else if (event.event === 'thought') {
              const { delta } = JSON.parse(event.data)
              dispatch({
                type: 'appendThought',
                sessionId: currentSessionId,
                id: currentMessageId,
                delta,
              })
            } else if (event.event === 'tool_call') {
              const { id, turn, toolName, args } = JSON.parse(event.data)
              dispatch({
                type: 'addToolUnit',
                sessionId: currentSessionId,
                id: currentMessageId,
                step: {
                  id,
                  toolName,
                  turn,
                  args: args ?? {},
                  status: 'running',
                  startedAt: Date.now(),
                },
              })
            } else if (event.event === 'tool_result') {
              const { id, status, summary } = JSON.parse(event.data)
              dispatch({
                type: 'updateToolUnit',
                sessionId: currentSessionId,
                messageId: currentMessageId,
                id,
                patch: { status, resultSummary: summary },
              })
            } else if (event.event === 'error') {
              const { message } = JSON.parse(event.data)
              dispatch({
                type: 'appendText',
                sessionId: currentSessionId,
                id: currentMessageId,
                delta: `\n\`\`\`\n${message}\n\`\`\``,
              })
            } else if (event.event === 'done') {
              streamCompleted = true
              closeStream()
              void persistActiveBackendState()
              void ping()
              break
            }
          } catch {
            // ignore malformed event payloads
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
    currentProject,
    sidecarReady,
    agentReady,
    addSystemMessage,
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

  const orionTheme = {
    algorithm: theme.darkAlgorithm,
    token: {
      colorBgBase: '#0f1117',
      colorBgContainer: '#161922',
      colorBgElevated: '#1c1f2a',
      colorTextBase: '#f1f5f9',
      colorTextSecondary: '#64748b',
      colorBorder: 'rgba(148, 163, 184, 0.12)',
      colorPrimary: '#f59e0b',
      colorPrimaryHover: '#fbbf24',
      colorPrimaryActive: '#d97706',
      colorLink: '#f59e0b',
      colorLinkHover: '#fbbf24',
      borderRadius: 10,
      fontFamily:
        '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyCode: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
    },
    components: {
      Button: {
        colorPrimaryBg: '#f59e0b',
        colorPrimaryText: '#0f1117',
      },
      Badge: {
        colorInfo: '#3b82f6',
      },
    },
  }

  return (
    <ConfigProvider theme={orionTheme}>
      <XProvider>
        <Layout className="shell">
          <div className="ambient ambient-a" />
          <div className="ambient ambient-b" />
          <Layout className="chat-layout">
            <Layout.Sider className="chat-sidebar" width={260}>
            <div className="sidebar-brand">
              <div className="brand-mark" aria-hidden="true">
                <span className="brand-star brand-star--a" />
                <span className="brand-star brand-star--b" />
                <span className="brand-star brand-star--c" />
                <span className="brand-star brand-star--d" />
                <span className="brand-orbit" />
              </div>
              <div className="brand-text">
                <Typography.Text className="brand-name">Orion</Typography.Text>
                <Typography.Text className="brand-tag">本地 Agent</Typography.Text>
              </div>
            </div>

            <Space className="sidebar-toolbar" size={4}>
              <Tooltip title="新建独立会话">
                <Button type="text" size="small" icon={<PlusOutlined />} onClick={handleCreateSession} />
              </Tooltip>
              <Tooltip title="添加 Project 目录">
                <Button type="text" size="small" icon={<FolderAddOutlined />} onClick={() => void handleAddProjectDirectory()} />
              </Tooltip>
              <Tooltip title="设置">
                <Button type="text" size="small" icon={<SettingOutlined />} onClick={() => setSettings({ open: true })} />
              </Tooltip>
            </Space>

            <div className="sidebar-scroll">
              {projectsSorted.length > 0 && (
                <div className="sidebar-section">
                  <Typography.Text className="sidebar-section-title">Projects</Typography.Text>
                  <Collapse
                    bordered={false}
                    activeKey={chatState.expandedProjectIds}
                    onChange={(keys) => {
                      const opened = Array.isArray(keys) ? keys : [keys]
                      const changed = projectsSorted.find((p) =>
                        opened.includes(p.id)
                          ? !chatState.expandedProjectIds.includes(p.id)
                          : chatState.expandedProjectIds.includes(p.id)
                      )
                      if (changed) handleToggleExpandProject(changed.id)
                    }}
                    expandIcon={({ isActive }) => (
                      <span className={`collapse-arrow ${isActive ? 'active' : ''}`}>▸</span>
                    )}
                    items={projectsSorted.map((project) => {
                      const sessionsOfProject = projectSessions(project.id)
                      return {
                        key: project.id,
                        label: (
                          <div className="project-collapse-header">
                            <Space size={4}>
                              <FolderOutlined className="project-icon" />
                              <span className="project-name-text">{project.name}</span>
                              {project.gitBranch && (
                                <Badge count={project.gitBranch} color="blue" style={{ backgroundColor: '#3b82f6' }} />
                              )}
                            </Space>
                            <Space size={2} className="project-header-actions">
                              <Button
                                type="text"
                                size="small"
                                icon={<ReloadOutlined />}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleRefreshProjectBranch(project.id)
                                }}
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<EditOutlined />}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleRenameProject(project.id)
                                }}
                              />
                              <Button
                                type="text"
                                size="small"
                                icon={<PlusOutlined />}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleCreateProjectSession(project.id)
                                }}
                              />
                              <Button
                                type="text"
                                size="small"
                                danger
                                icon={<DeleteOutlined />}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void handleDeleteProject(project.id)
                                }}
                              />
                            </Space>
                          </div>
                        ),
                        children: (
                          <List
                            size="small"
                            dataSource={sessionsOfProject}
                            locale={{ emptyText: '该 Project 下暂无会话' }}
                            renderItem={(item) => (
                              <List.Item
                                key={item.id}
                                className={`session-list-item ${item.id === session?.id ? 'active' : ''}`}
                                onClick={() => void handleSwitchSession(item.id)}
                              >
                                <List.Item.Meta
                                  title={<span className="session-item-title">{item.title}</span>}
                                  description={<span className="session-item-desc">{sessionPreview(item)}</span>}
                                />
                                <span className="session-item-time">{formatUpdatedAt(item.updatedAt)}</span>
                              </List.Item>
                            )}
                          />
                        ),
                      }
                    })}
                  />
                </div>
              )}

              <div className="sidebar-section">
                <Typography.Text className="sidebar-section-title">独立会话</Typography.Text>
                <Menu
                  mode="inline"
                  selectedKeys={session?.projectId ? [] : [session?.id]}
                  items={standaloneSessions.map((item) => ({
                    key: item.id,
                    icon: <MessageOutlined />,
                    label: (
                      <div className="standalone-session-item" onClick={() => void handleSwitchSession(item.id)}>
                        <span className="session-item-title">{item.title}</span>
                        <span className="session-item-time">{formatUpdatedAt(item.updatedAt)}</span>
                      </div>
                    ),
                  }))}
                />
              </div>
            </div>

            <div className="sidebar-footer">
              <Typography.Text type="secondary" className="current-session-label">当前会话</Typography.Text>
              <Typography.Text className="current-session-name" ellipsis>{session?.title || '未命名会话'}</Typography.Text>
              <Space size={4}>
                <Tooltip title="重命名">
                  <Button type="text" size="small" icon={<EditOutlined />} onClick={() => void handleRenameSession()} />
                </Tooltip>
                <Tooltip title="删除">
                  <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={() => void handleDeleteSession()} />
                </Tooltip>
              </Space>
            </div>
          </Layout.Sider>

          <Layout.Content className="chat-main">
            <header className="window-bar">
              <div className="window-controls">
                <button
                  className="window-btn"
                  title="最小化"
                  aria-label="最小化"
                  onClick={() => void minimizeWindow()}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <rect x="1" y="5.5" width="10" height="1" rx="0.5" fill="currentColor" />
                  </svg>
                </button>
                <button
                  className="window-btn"
                  title={maximized ? '还原' : '最大化'}
                  aria-label={maximized ? '还原' : '最大化'}
                  onClick={async () => {
                    try {
                      const next = await toggleMaximizeWindow()
                      setMaximized(next)
                    } catch (error) {
                      addSystemMessage(`窗口缩放失败: ${error instanceof Error ? error.message : String(error)}`)
                    }
                  }}
                >
                  {maximized ? (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <path
                        d="M3.5 1.5h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1Z"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                      <path
                        d="M2 3.5V9a1 1 0 0 0 1 1h5.5"
                        stroke="currentColor"
                        strokeWidth="1.2"
                        strokeLinecap="round"
                      />
                    </svg>
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                      <rect
                        x="1.5"
                        y="1.5"
                        width="9"
                        height="9"
                        rx="1"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                    </svg>
                  )}
                </button>
                <button
                  className="window-btn close"
                  title="关闭"
                  aria-label="关闭"
                  onClick={() => void closeWindow()}
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path
                      d="M2.5 2.5 9.5 9.5M9.5 2.5 2.5 9.5"
                      stroke="currentColor"
                      strokeWidth="1.3"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
            </header>

            <section ref={messagesRef} className="messages">
              {session && session.messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-constellation" aria-hidden="true">
                    <span className="empty-star empty-star--1" />
                    <span className="empty-star empty-star--2" />
                    <span className="empty-star empty-star--3" />
                    <span className="empty-star empty-star--4" />
                    <span className="empty-star empty-star--5" />
                    <span className="empty-star empty-star--6" />
                    <span className="empty-line empty-line--1" />
                    <span className="empty-line empty-line--2" />
                    <span className="empty-line empty-line--3" />
                  </div>
                  <h2>设定航线</h2>
                  <p>输入任务、命令或问题，Orion 会在本地 sidecar 中执行。会话会绑定到当前 Project 目录。</p>
                </div>
              )}
              <Bubble.List
                rootClassName="orion-bubble-list"
                role={{
                  user: { placement: 'end', variant: 'shadow' },
                  ai: { placement: 'start', variant: 'borderless' },
                  system: { placement: 'start', variant: 'borderless' },
                }}
                items={
                  session?.messages.map((message) => {
                    const isStreamingMessage = streaming && message.id === streamingMessageId
                    return {
                      key: message.id,
                      role: message.role === 'assistant' ? 'ai' : message.role,
                      content: message.text,
                      contentRender: () => renderMessageContent(message, isStreamingMessage),
                    }
                  }) ?? []
                }
              />
            </section>

            <div className="composer-area">
              <Sender
                rootClassName="orion-sender"
                value={session?.draft || ''}
                onChange={(value) => {
                  if (!session) return
                  dispatch({ type: 'setDraft', sessionId: session.id, draft: value })
                }}
                onSubmit={() => void handleSend()}
                onCancel={handleStop}
                loading={streaming}
                disabled={!sidecarReady}
                submitType="enter"
                placeholder={sidecarReady ? '输入任务、命令或问题' : 'sidecar 启动中…'}
                footer={
                  <div className="project-binding-bar">
                    <Space>
                      {currentProject ? (
                        <>
                          <span>📁 {currentProject.name}</span>
                          {currentProject.gitBranch && <Badge count={currentProject.gitBranch} color="blue" />}
                          <Button size="small" onClick={handleUnbindCurrentProject}>解除绑定</Button>
                        </>
                      ) : (
                        <Button size="small" onClick={() => void handleAddProjectDirectory()}>
                          + 添加 Project 目录
                        </Button>
                      )}
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
                    </Space>
                  </div>
                }
              />
            </div>
          </Layout.Content>
        </Layout>

        <Drawer
          title={
            <div>
              <div className="eyebrow settings-eyebrow">Desktop Settings</div>
              <Typography.Title level={4} style={{ margin: 0 }}>模型配置、网关配置与运行诊断</Typography.Title>
              <Typography.Text type="secondary">
                直接在桌面端维护 <code>.env</code>、<code>mykey.json</code>，并查看 sidecar 当前诊断状态。
              </Typography.Text>
            </div>
          }
          placement="right"
          width={760}
          open={settings.open}
          onClose={() => setSettings({ open: false })}
          extra={
            <Space>
              <span className="settings-state-label">{settingsStateLabel}</span>
              <Button onClick={() => void loadSettings(true)} disabled={settings.loading || settings.saving || !port}>刷新</Button>
            </Space>
          }
          footer={
            <div className="drawer-footer">
              <Typography.Text type="secondary">
                {settings.error
                  ? `加载失败: ${settings.error}`
                  : settings.saving
                    ? '正在写回 .env 与 mykey.json...'
                    : settings.dirty
                      ? '存在未保存更改。保存后会按当前会话快照重建 agent。'
                      : '保存后 sidecar 会按当前会话快照重建 agent。'}
              </Typography.Text>
              <Button
                type="primary"
                onClick={() => void handleSaveSettings()}
                disabled={settings.loading || settings.saving || !port}
              >保存配置</Button>
            </div>
          }
        >
          <div className="settings-body">{renderSettingsBody()}</div>
        </Drawer>
      </Layout>
      </XProvider>
    </ConfigProvider>
  )
}

function renderDiagnostics(diagnostics: DiagnosticsPayload): ReactElement {
  const fileRows = [
    ['.env', diagnostics.files.envExists ? diagnostics.files.envPath : `${diagnostics.files.envPath} (不存在)`],
    ['.env.example', diagnostics.files.envExampleExists ? diagnostics.files.envExamplePath : `${diagnostics.files.envExamplePath} (不存在)`],
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
