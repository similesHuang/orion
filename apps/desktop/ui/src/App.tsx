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
import { confirm, open } from '@tauri-apps/plugin-dialog'
import { Sender, XProvider } from '@ant-design/x'
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
  flushState,
  loadState,
  maybeUpdateSessionTitle,
  saveState,
  sessionPreview,
} from './store'
import {
  approveTool,
  exportBackendSnapshot,
  importBackendSnapshot,
  loadCommands as fetchCommands,
  loadCost as fetchCost,
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
import {
  createProject,
  createSession,
  createTask,
  createTurn,
  formatTokens,
  formatUpdatedAt,
  parseListValue,
  parseSse,
  streamBuffer,
} from './utils'
import { TaskFeed } from './components/TaskFeed'
import type {
  CommandSpec,
  CostStats,
  DiagnosticsPayload,
  FieldSpec,
  LlmOption,
  SettingsState,
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
  const [streamingTaskId, setStreamingTaskId] = useState<string | null>(null)
  const [streamingTurnId, setStreamingTurnId] = useState<string | null>(null)
  const [llmOptions, setLlmOptions] = useState<LlmOption[]>([])
  const [selectedLlmLabel, setSelectedLlmLabel] = useState('模型未就绪')
  const [maximized, setMaximized] = useState(false)
  const [cost, setCost] = useState<CostStats | null>(null)
  const [commands, setCommands] = useState<CommandSpec[]>([])

  const sourceRef = useRef<AbortController | null>(null)
  const sseTimeoutRef = useRef<number | null>(null)
  const healthTimerRef = useRef<number | null>(null)
  const messagesRef = useRef<HTMLDivElement>(null)
  const stickToBottomRef = useRef(true)
  const rafRef = useRef<number | null>(null)
  // approvalId -> where the approval block lives + which request to answer
  const approvalCtxRef = useRef(
    new Map<string, { requestId: string; sessionId: string; taskId: string; turnId: string }>()
  )

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

  const slashMatches = useMemo(() => {
    const draft = session?.draft ?? ''
    if (!draft.startsWith('/') || draft.includes(' ') || draft.includes('\n')) return []
    const q = draft.toLowerCase()
    return commands.filter((c) => c.command.toLowerCase().startsWith(q)).slice(0, 6)
  }, [session?.draft, commands])

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
    setStreamingTaskId(null)
    setStreamingTurnId(null)
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
    try {
      setCost(await fetchCost())
    } catch {
      // cost is best-effort; leave the last known value in place
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
        try {
          setCommands(await fetchCommands())
        } catch {
          // command hints are optional
        }
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
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      closeStream()
      flushState(chatState)
    }
  }, [])

  useEffect(() => {
    saveState(chatState)
    // Only auto-scroll when the user is already parked near the bottom, so
    // scrolling up to read earlier output during streaming isn't hijacked.
    if (stickToBottomRef.current && messagesRef.current) {
      const el = messagesRef.current
      el.scrollTop = el.scrollHeight
    }
  }, [chatState])

  const handleMessagesScroll = useCallback(() => {
    const el = messagesRef.current
    if (!el) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    stickToBottomRef.current = distanceFromBottom < 80
  }, [])

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

    const task = createTask(text.slice(0, 30) || '新任务', session.projectId)
    const userTurn = createTurn('user')
    userTurn.blocks.push({ kind: 'text', content: text })
    const assistantTurn = createTurn('assistant', 1)
    const taskWithTurns = { ...task, turns: [userTurn, assistantTurn] }

    const currentSessionId = session.id
    const currentTaskId = task.id
    const currentAssistantTurnId = assistantTurn.id

    dispatch({ type: 'addTask', sessionId: currentSessionId, task: taskWithTurns })
    dispatch({ type: 'setActiveTask', sessionId: currentSessionId, taskId: currentTaskId })
    dispatch({ type: 'setDraft', sessionId: currentSessionId, draft: '' })
    stickToBottomRef.current = true
    closeStream()

    setStreamingTaskId(currentTaskId)
    setStreamingTurnId(currentAssistantTurnId)
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
        if (streamingRef.current && currentAssistantTurnId) {
          dispatch({
            type: 'appendBlock',
            sessionId: currentSessionId,
            taskId: currentTaskId,
            turnId: currentAssistantTurnId,
            block: { kind: 'error', content: '响应超时，连接已关闭' },
          })
        }
        closeStream()
        void ping()
      }, SSE_INACTIVITY_MS)
    }

    const controller = new AbortController()
    sourceRef.current = controller

    const agentTurnIds = new Map<number, string>()
    agentTurnIds.set(1, currentAssistantTurnId)
    const stepToTurnId = new Map<string, string>()
    // tracks which turn text/thought output should go to (follows the latest tool_call turn)
    let activeTurnId = currentAssistantTurnId

    // rAF-coalesced delta buffer. SSE emits many tiny text/thought chunks per
    // second; instead of one dispatch per chunk we accumulate per (turn, kind)
    // and flush a single merged dispatch on the next animation frame. This is
    // the main fix for choppy, laggy reply rendering.
    const pending = new Map<string, { turnId: string; kind: 'text' | 'thought'; content: string }>()

    const flushPending = () => {
      rafRef.current = null
      if (pending.size === 0) return
      for (const { turnId, kind, content } of pending.values()) {
        dispatch({
          type: 'appendBlock',
          sessionId: currentSessionId,
          taskId: currentTaskId,
          turnId,
          block: { kind, content },
        })
      }
      pending.clear()
    }

    const scheduleFlush = () => {
      if (rafRef.current === null) {
        rafRef.current = requestAnimationFrame(flushPending)
      }
    }

    const enqueueDelta = (kind: 'text' | 'thought', turnId: string, content: string) => {
      const key = `${turnId}:${kind}`
      const existing = pending.get(key)
      if (existing) existing.content += content
      else pending.set(key, { turnId, kind, content })
      scheduleFlush()
    }

    const ensureAgentTurn = (turnNumber: number): string => {
      const existing = agentTurnIds.get(turnNumber)
      if (existing) return existing
      const newTurn = createTurn('assistant', turnNumber)
      agentTurnIds.set(turnNumber, newTurn.id)
      dispatch({ type: 'addTurn', sessionId: currentSessionId, taskId: currentTaskId, turn: newTurn })
      return newTurn.id
    }

    const finishWithError = () => {
      flushPending()
      if (streamingRef.current && currentAssistantTurnId) {
        dispatch({
          type: 'appendBlock',
          sessionId: currentSessionId,
          taskId: currentTaskId,
          turnId: currentAssistantTurnId,
          block: { kind: 'error', content: '连接中断' },
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
          try {
            if (event.event === 'text') {
              const { delta } = JSON.parse(event.data)
              enqueueDelta('text', activeTurnId, delta)
            } else if (event.event === 'thought') {
              const { delta } = JSON.parse(event.data)
              enqueueDelta('thought', activeTurnId, delta)
            } else if (event.event === 'tool_call') {
              flushPending()
              const { id, turn, toolName, args } = JSON.parse(event.data)
              const turnId = ensureAgentTurn(turn ?? 1)
              activeTurnId = turnId
              stepToTurnId.set(id, turnId)
              dispatch({
                type: 'appendBlock',
                sessionId: currentSessionId,
                taskId: currentTaskId,
                turnId,
                block: {
                  kind: 'tool',
                  step: {
                    id,
                    toolName,
                    turn: turn ?? 1,
                    args: args ?? {},
                    status: 'running',
                    startedAt: Date.now(),
                  },
                },
              })
            } else if (event.event === 'tool_result') {
              flushPending()
              const { id, status, summary } = JSON.parse(event.data)
              const turnId = stepToTurnId.get(id)
              if (turnId) {
                dispatch({
                  type: 'updateToolBlock',
                  sessionId: currentSessionId,
                  taskId: currentTaskId,
                  turnId,
                  stepId: id,
                  patch: { status, resultSummary: summary },
                })
              }
            } else if (event.event === 'tool_approval') {
              flushPending()
              const { requestId, approvalId, toolName, args } = JSON.parse(event.data)
              approvalCtxRef.current.set(approvalId, {
                requestId,
                sessionId: currentSessionId,
                taskId: currentTaskId,
                turnId: activeTurnId,
              })
              dispatch({
                type: 'appendBlock',
                sessionId: currentSessionId,
                taskId: currentTaskId,
                turnId: activeTurnId,
                block: {
                  kind: 'approval',
                  approval: { approvalId, toolName, args: args ?? {}, status: 'pending' },
                },
              })
            } else if (event.event === 'error') {
              flushPending()
              const { message } = JSON.parse(event.data)
              dispatch({
                type: 'appendBlock',
                sessionId: currentSessionId,
                taskId: currentTaskId,
                turnId: currentAssistantTurnId,
                block: { kind: 'error', content: message },
              })
            } else if (event.event === 'stop') {
              flushPending()
              streamCompleted = true
              dispatch({
                type: 'setTaskStatus',
                sessionId: currentSessionId,
                taskId: currentTaskId,
                status: 'error',
              })
              closeStream()
              void ping()
              break
            } else if (event.event === 'done') {
              flushPending()
              streamCompleted = true
              dispatch({
                type: 'setTaskStatus',
                sessionId: currentSessionId,
                taskId: currentTaskId,
                status: 'done',
              })
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

  const handleApproval = useCallback(
    async (approvalId: string, decision: 'allow' | 'deny', remember: boolean) => {
      const ctx = approvalCtxRef.current.get(approvalId)
      if (!ctx) return
      dispatch({
        type: 'updateApprovalBlock',
        sessionId: ctx.sessionId,
        taskId: ctx.taskId,
        turnId: ctx.turnId,
        approvalId,
        status: decision === 'allow' ? 'allowed' : 'denied',
      })
      approvalCtxRef.current.delete(approvalId)
      try {
        await approveTool(ctx.requestId, approvalId, decision, remember)
      } catch (error) {
        addSystemMessage(`审批发送失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    [addSystemMessage]
  )

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
      colorBgBase: '#16171a',
      colorBgContainer: '#1e1f23',
      colorBgElevated: '#26272c',
      colorTextBase: '#eceae4',
      colorTextSecondary: '#86837c',
      colorBorder: 'rgba(236, 234, 228, 0.08)',
      colorPrimary: '#4fd1c5',
      colorPrimaryHover: '#6ee0d5',
      colorPrimaryActive: '#3bb8ac',
      colorLink: '#4fd1c5',
      colorLinkHover: '#6ee0d5',
      borderRadius: 10,
      fontFamily:
        '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyCode: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
    },
    components: {
      Button: {
        colorPrimaryBg: '#4fd1c5',
        colorPrimaryText: '#131417',
      },
      Badge: {
        colorInfo: '#4fd1c5',
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
              <div className="workbench-status">
                <span className={`status-dot ${agentReady ? 'ok' : sidecarReady ? 'warn' : 'off'}`} aria-hidden="true" />
                <span className="status-model">{selectedLlmLabel}</span>
                {cost && cost.totalTokens > 0 && (
                  <span className="cost-hud" title={`${cost.requests} 次请求 · 缓存命中 ${cost.cacheHitRate.toFixed(0)}%`}>
                    <span className="cost-metric">↑{formatTokens(cost.inputTokens)}</span>
                    <span className="cost-metric">↓{formatTokens(cost.outputTokens)}</span>
                    <span className="cost-metric cost-cache">⚡{cost.cacheHitRate.toFixed(0)}%</span>
                  </span>
                )}
              </div>
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

            <section ref={messagesRef} className="messages" onScroll={handleMessagesScroll}>
              {session && session.tasks.length === 0 && session.messages.length === 0 && (
                <div className="empty-state">
                  <div className="empty-constellation" aria-hidden="true" />
                  <h2>交给我吧</h2>
                  <p>说说你想做什么。读写文件、跑命令、查资料都行，我会在本地一步步做给你看。</p>
                </div>
              )}
              {session && (
                <TaskFeed
                  session={session}
                  streamingTaskId={streamingTaskId}
                  streamingTurnId={streamingTurnId}
                  onApproval={handleApproval}
                />
              )}
            </section>

            <div className="composer-area">
              {slashMatches.length > 0 && (
                <div className="slash-hints">
                  {slashMatches.map((c) => (
                    <button
                      key={c.command}
                      type="button"
                      className="slash-hint"
                      onClick={() => {
                        if (!session) return
                        const filled = c.command.includes('[') || c.command.includes('<')
                          ? `${c.command.split(' ')[0]} `
                          : c.command
                        dispatch({ type: 'setDraft', sessionId: session.id, draft: filled })
                      }}
                    >
                      <span className="slash-cmd">{c.command}</span>
                      <span className="slash-desc">{c.description}</span>
                    </button>
                  ))}
                </div>
              )}
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
