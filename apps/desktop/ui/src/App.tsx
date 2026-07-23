import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactElement,
} from 'react'
import { Sender, XProvider } from '@ant-design/x'
import {
  Badge,
  Button,
  Card,
  Collapse,
  ConfigProvider,
  Descriptions,
  Form,
  Input,
  Modal,
  Layout,
  List,
  Popover,
  Space,
  Tooltip,
  Typography,
  theme,
} from 'antd'
import {
  PlusOutlined,
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
  baseUrl,
  setSidecarPort,
  startSidecar as startSidecarCmd,
  stopGeneration as stopGenerationCmd,
  stopSidecar,
  waitForSidecar,
  minimizeWindow,
  toggleMaximizeWindow,
  closeWindow,
  startGateway,
  stopGateway,
  gatewayStatus,
} from './api'
import {
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
import { SettingsMenu } from './components/SettingsMenu'
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
  const [gatewayRunning, setGatewayRunning] = useState(false)
  const [, setGatewayPid] = useState<number | null>(null)
  const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<string>('model')
  const [themeMode, setThemeMode] = useState<'dark' | 'light'>(() => {
    const saved = (typeof localStorage !== 'undefined' ? localStorage.getItem('orion-theme') : null) as 'dark' | 'light' || 'dark'
    try { document.documentElement.className = saved === 'light' ? 'theme-light' : 'theme-dark' } catch {}
    return saved
  })

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
    () => chatState.projects,
    [chatState.projects]
  )

  const standaloneSessions = useMemo(
    () =>
      chatState.sessions
        .filter((item) => !item.projectId)
        .sort((left, right) => left.createdAt - right.createdAt),
    [chatState.sessions]
  )

  const gatewayConfigured = useMemo(() => {
    return settings.diagnostics?.gateways.some((g) => g.configured) ?? false
  }, [settings.diagnostics])

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
        .sort((left, right) => left.createdAt - right.createdAt),
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

  const handleToggleExpandProject = useCallback((projectId: string) => {
    dispatch({ type: 'toggleExpandProject', projectId })
  }, [])

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

  const handleStartGateway = useCallback(async () => {
    try {
      await startGateway()
      const status = await gatewayStatus()
      setGatewayRunning(status.running)
      setGatewayPid(status.pid)
    } catch (error) {
      addSystemMessage(`启动 gateway 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [addSystemMessage])

  const handleStopGateway = useCallback(async () => {
    try {
      await stopGateway()
      setGatewayRunning(false)
      setGatewayPid(null)
    } catch (error) {
      addSystemMessage(`停止 gateway 失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [addSystemMessage])

  const handleSettingsMenuSelect = useCallback((section: string) => {
    setSettingsPopoverOpen(false)
    setSettingsSection(section)
    setSettings({ open: true })
  }, [])

  const handleThemeChange = useCallback((mode: 'dark' | 'light') => {
    setThemeMode(mode)
    try {
      localStorage.setItem('orion-theme', mode)
      document.documentElement.className = mode === 'dark' ? 'theme-dark' : 'theme-light'
    } catch {}
  }, [])

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

  const renderModelConfig = () => (
    <Form layout="vertical" size="middle">
      {settings.error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{settings.error}</div>}
      {PRIMARY_MODEL_FIELDS.map((field) => (
        <Form.Item key={field.key} label={<span style={{ color: 'var(--ink-dim)' }}>{field.label}</span>}>
          {field.secret ? (
            <Input.Password
              className="settings-ant-input"
              value={getFieldValue(field)}
              onChange={(e) => updateField(field.scope, field.key, e.target.value)}
              placeholder={field.placeholder}
            />
          ) : field.multiline ? (
            <Input.TextArea
              className="settings-ant-input"
              value={getFieldValue(field)}
              onChange={(e) => updateField(field.scope, field.key, e.target.value)}
              placeholder={field.placeholder}
              rows={3}
            />
          ) : (
            <Input
              className="settings-ant-input"
              value={getFieldValue(field)}
              onChange={(e) => updateField(field.scope, field.key, e.target.value)}
              placeholder={field.placeholder}
            />
          )}
        </Form.Item>
      ))}
      {renderExtraEnvKeys.length > 0 && (
        <Collapse
          ghost
          items={[{
            key: 'extra',
            label: <span style={{ color: 'var(--ink-mute)', fontSize: 13 }}>其他环境变量 ({renderExtraEnvKeys.length})</span>,
            children: renderExtraEnvKeys.map((key) => (
              <Form.Item key={key} label={<span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>{key}</span>}>
                <Input className="settings-ant-input" value={String(settings.env[key] ?? '')} onChange={(e) => updateField('env', key, e.target.value)} />
              </Form.Item>
            )),
          }]}
        />
      )}
    </Form>
  )

  const renderGatewayConfig = () => (
    <Form layout="vertical" size="middle">
      {settings.error && <div style={{ color: 'var(--error)', fontSize: 13, marginBottom: 12 }}>{settings.error}</div>}
      {GATEWAY_SPECS.map((spec) => {
        const diagnostic = settings.diagnostics?.gateways.find((item) => item.id === spec.id)
        const statusText = diagnostic?.configured ? '已配置' : diagnostic ? `缺少 ${diagnostic.requiredMissing.join(', ')}` : '待检测'
        return (
          <Card
            key={spec.id}
            size="small"
            title={<span style={{ fontSize: 14 }}>{spec.label}</span>}
            extra={<span style={{ fontSize: 12, color: diagnostic?.configured ? 'var(--agent)' : 'var(--warn)' }}>{statusText}</span>}
            className="settings-gateway-card"
          >
            {spec.fields.map((field) => (
              <Form.Item key={field.key} label={<span style={{ color: 'var(--ink-dim)' }}>{field.label}</span>}>
                {field.secret ? (
                  <Input.Password className="settings-ant-input" value={getFieldValue(field)} onChange={(e) => updateField(field.scope, field.key, e.target.value)} placeholder={field.placeholder} />
                ) : (
                  <Input className="settings-ant-input" value={getFieldValue(field)} onChange={(e) => updateField(field.scope, field.key, e.target.value)} placeholder={field.placeholder} />
                )}
              </Form.Item>
            ))}
          </Card>
        )
      })}
    </Form>
  )

  const renderDiagnosticsPanel = () => {
    if (!settings.diagnostics) {
      return <p style={{ color: 'var(--ink-mute)', fontSize: 13 }}>尚未获取到诊断信息。</p>
    }
    const d = settings.diagnostics
    return (
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Card size="small" title="Sidecar" className="settings-diag-card">
          <Descriptions column={2} size="small" colon={false}>
            <Descriptions.Item label="PID">{d.pid}</Descriptions.Item>
            <Descriptions.Item label="Node">{d.nodeVersion}</Descriptions.Item>
            <Descriptions.Item label="端口">{d.sidecarPort}</Descriptions.Item>
            <Descriptions.Item label="活跃请求">{d.activeRequests}</Descriptions.Item>
          </Descriptions>
        </Card>
        <Card size="small" title="Agent" className="settings-diag-card">
          <Descriptions column={2} size="small" colon={false}>
            <Descriptions.Item label="状态"><span style={{ color: d.agent.ready ? 'var(--agent)' : 'var(--warn)' }}>{d.agent.ready ? '就绪' : '未就绪'}</span></Descriptions.Item>
            <Descriptions.Item label="当前模型">{d.agent.llmName || '未加载'}</Descriptions.Item>
            <Descriptions.Item label="LLM 索引">{d.agent.llmIndex ?? '-'}</Descriptions.Item>
            <Descriptions.Item label="模型数">{d.agent.llms.length}</Descriptions.Item>
          </Descriptions>
          {d.agent.issue && <pre style={{ margin: '8px 0 0', color: 'var(--error)', fontSize: 12 }}>{d.agent.issue}</pre>}
        </Card>
        {d.gateways.map((g) => (
          <Card key={g.id} size="small" title={g.label} className="settings-diag-card"
            extra={g.configured ? <span style={{ color: 'var(--agent)', fontSize: 12 }}>ready</span> : <span style={{ color: 'var(--warn)', fontSize: 12 }}>incomplete</span>}
          >
            <Descriptions column={1} size="small" colon={false}>
              {g.requiredMissing.length > 0 && <Descriptions.Item label="缺少">{g.requiredMissing.join(', ')}</Descriptions.Item>}
              {g.portKey && <Descriptions.Item label={g.portKey}>{g.portValue || '-'}</Descriptions.Item>}
            </Descriptions>
          </Card>
        ))}
      </Space>
    )
  }

  const orionTheme = useMemo(() => ({
    algorithm: themeMode === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
    token: themeMode === 'dark' ? {
      colorBgBase: '#0d1117',
      colorBgContainer: '#161b22',
      colorBgElevated: '#161b22',
      colorTextBase: '#e6edf3',
      colorTextSecondary: '#8d96a0',
      colorBorder: '#30363d',
      colorPrimary: '#58a6ff',
      colorPrimaryHover: '#79c0ff',
      colorPrimaryActive: '#58a6ff',
      colorLink: '#58a6ff',
      controlOutline: 'transparent',
      colorError: '#f85149',
      borderRadius: 10,
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyCode: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
    } : {
      colorBgBase: '#f5f0eb',
      colorBgContainer: '#ffffff',
      colorBgElevated: '#ffffff',
      colorTextBase: 'rgba(0,0,0,0.85)',
      colorTextSecondary: 'rgba(0,0,0,0.4)',
      colorBorder: 'rgba(0,0,0,0.06)',
      colorPrimary: '#0891b2',
      colorPrimaryHover: '#0e7490',
      colorPrimaryActive: '#0891b2',
      colorLink: '#0891b2',
      controlOutline: 'transparent',
      colorError: '#dc2626',
      borderRadius: 10,
      fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
      fontFamilyCode: '"JetBrains Mono", "SF Mono", ui-monospace, monospace',
    },
    components: {
      Button: {
        colorPrimaryBg: themeMode === 'dark' ? 'rgba(56,139,253,0.15)' : 'rgba(8,145,178,0.1)',
        colorPrimaryText: themeMode === 'dark' ? '#58a6ff' : '#0891b2',
      },
      Input: {
        activeBorderColor: 'transparent',
        activeShadow: '0 0 0 0 transparent',
        hoverBorderColor: themeMode === 'dark' ? '#484f58' : 'rgba(0,0,0,0.12)',
      },
    },
  }), [themeMode])

  return (
    <ConfigProvider theme={orionTheme}>
      <XProvider>
        <Layout className={`shell theme-${themeMode}`}>
          <div className="ambient ambient-a" />
          <div className="ambient ambient-b" />
          <Layout className="chat-layout">
            <Layout.Sider className="chat-sidebar" width={260}>
            {/* Brand + New session button */}
            <div className="sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 14px 6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div className="brand-mark" aria-hidden="true">
                  <span className="brand-star brand-star--a" />
                  <span className="brand-star brand-star--b" />
                  <span className="brand-star brand-star--c" />
                  <span className="brand-star brand-star--d" />
                  <span className="brand-orbit" />
                </div>
                <Typography.Text className="brand-name" style={{ fontSize: 13, fontWeight: 600 }}>Orion</Typography.Text>
              </div>
              <Tooltip title="新建会话">
                <Button type="text" size="small" icon={<PlusOutlined />} onClick={handleCreateSession} />
              </Tooltip>
            </div>

            <div className="sidebar-scroll">
              {projectsSorted.length > 0 && (
                <div className="sidebar-section">
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
                          <div className="project-collapse-header" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 12, color: 'var(--ink-dim)', fontWeight: 500 }}>{project.name}</span>
                            {project.gitBranch && (
                              <Badge count={project.gitBranch} color="blue" style={{ backgroundColor: 'var(--agent)', fontSize: 9 }} />
                            )}
                          </div>
                        ),
                        children: (
                          <List
                            size="small"
                            dataSource={sessionsOfProject}
                            locale={{ emptyText: '暂无会话' }}
                            renderItem={(item) => (
                              <List.Item
                                key={item.id}
                                className={`session-list-item ${item.id === session?.id ? 'active' : ''}`}
                                onClick={() => void handleSwitchSession(item.id)}
                                style={{ padding: '4px 6px 4px 24px', border: 'none', cursor: 'pointer' }}
                              >
                                <div style={{ width: '100%', overflow: 'hidden' }}>
                                  <div style={{ fontSize: 12, color: item.id === session?.id ? 'var(--ink)' : 'var(--ink-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {item.title}
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 2 }}>
                                    {formatUpdatedAt(item.updatedAt)}
                                  </div>
                                </div>
                              </List.Item>
                            )}
                          />
                        ),
                      }
                    })}
                  />
                </div>
              )}

              <div className="sidebar-section" style={{ marginTop: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 6px' }}>
                  <Typography.Text style={{ fontSize: 12, color: 'var(--ink-dim)', fontWeight: 500 }}>
                    独立会话
                  </Typography.Text>
                  <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-mute)' }}>
                    {standaloneSessions.length}
                  </span>
                </div>
                {standaloneSessions.map((item) => (
                  <div
                    key={item.id}
                    className={`session-list-item ${item.id === session?.id ? 'active' : ''}`}
                    onClick={() => void handleSwitchSession(item.id)}
                    style={{ padding: '4px 6px 4px 22px', cursor: 'pointer', borderRadius: 4 }}
                  >
                    <div style={{ fontSize: 12, color: item.id === session?.id ? 'var(--ink)' : 'var(--ink-dim)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.title}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 1 }}>
                      {formatUpdatedAt(item.updatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ borderTop: '1px solid var(--line)', padding: '8px 12px' }}>
              <Popover
                content={<SettingsMenu onSelect={handleSettingsMenuSelect} gatewayConfigured={gatewayConfigured} themeMode={themeMode} onThemeChange={handleThemeChange} />}
                trigger="click"
                placement="top"
                overlayClassName="settings-popover"
                open={settingsPopoverOpen}
                onOpenChange={setSettingsPopoverOpen}
              >
                <div className="sidebar-settings-btn">
                  <span style={{ fontSize: 13, marginRight: 6 }}>⚙</span>
                  <span style={{ fontSize: 11 }}>设置</span>
                </div>
              </Popover>
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
                placeholder={sidecarReady ? '输入任务或问题' : 'sidecar 启动中…'}
              />
            </div>
          </Layout.Content>

        </Layout>

        <Modal
          open={settings.open}
          onCancel={() => setSettings({ open: false })}
          title={
            <div>
              <div style={{ fontSize: 11, color: 'var(--ink-mute)', letterSpacing: 0.5 }}>设置</div>
              <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)' }}>
                {settingsSection === 'model' && '🤖 模型配置'}
                {settingsSection === 'gateway' && '🔌 Gateway 配置'}
                {settingsSection === 'diagnostics' && '📊 运行诊断'}
              </div>
            </div>
          }
          footer={
            <Space>
              <Button onClick={() => setSettings({ open: false })}>取消</Button>
              <Button type="primary" onClick={() => void handleSaveSettings()} loading={settings.saving}>
                保存配置
              </Button>
            </Space>
          }
          width={520}
          centered
          destroyOnClose
          className="settings-modal"
          styles={{ body: { maxHeight: 420, overflowY: 'auto', padding: '16px 24px' } }}
        >
          {settingsSection === 'model' && renderModelConfig()}
          {settingsSection === 'gateway' && renderGatewayConfig()}
          {settingsSection === 'diagnostics' && renderDiagnosticsPanel()}
        </Modal>
      </Layout>
      </XProvider>
    </ConfigProvider>
  )
}
