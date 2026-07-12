import type { ChatSession, Project, Role, UiMessage } from './types'

export interface SseEvent {
  event?: string
  data: string
}

function shouldFlush(buffer: string): boolean {
  if (buffer.length >= 16) return true
  if (/\s$/.test(buffer) || /[，。！？；："'）\]\}、,.!?;:\")\]\}]$/.test(buffer.slice(-1))) return true
  return false
}

export async function* streamBuffer(source: AsyncIterable<SseEvent>): AsyncIterable<SseEvent> {
  let buffer = ''
  for await (const ev of source) {
    if (ev.event === 'tool_call' || ev.event === 'tool_result' || ev.event === 'done' || ev.event === 'error') {
      if (buffer) {
        yield { event: 'text', data: JSON.stringify({ delta: buffer }) }
        buffer = ''
      }
      yield ev
      continue
    }
    if (ev.event === 'thought') {
      // thoughts are independent blocks; don't flush the text buffer
      yield ev
      continue
    }
    if (ev.event !== 'text') {
      if (buffer) {
        yield { event: 'text', data: JSON.stringify({ delta: buffer }) }
        buffer = ''
      }
      yield ev
      continue
    }
    let delta = ''
    try {
      delta = JSON.parse(ev.data).delta ?? ''
    } catch {
      delta = ev.data
    }
    buffer += delta
    if (shouldFlush(buffer)) {
      yield { event: 'text', data: JSON.stringify({ delta: buffer }) }
      buffer = ''
    }
  }
  if (buffer) {
    yield { event: 'text', data: JSON.stringify({ delta: buffer }) }
  }
}

export async function* parseSse(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let eventEnd: number
    while ((eventEnd = buffer.indexOf('\n\n')) !== -1) {
      const eventText = buffer.slice(0, eventEnd)
      buffer = buffer.slice(eventEnd + 2)
      yield parseSseEvent(eventText)
    }
  }
  const rest = buffer.trim()
  if (rest) {
    yield parseSseEvent(rest)
  }
}

function parseSseEvent(text: string): SseEvent {
  let eventName = ''
  const dataLines: string[] = []
  for (const line of text.split('\n')) {
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5))
    }
  }
  return { event: eventName || undefined, data: dataLines.join('\n') }
}

export function uid(prefix = 'session'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

export function createProject(projectPath: string, gitBranch: string | null = null): Project {
  const normalized = projectPath.replace(/\\/g, '/')
  return {
    id: uid('project'),
    name: normalized.split('/').filter(Boolean).pop() || 'project',
    path: projectPath,
    gitBranch,
    updatedAt: Date.now(),
  }
}

export function createSession(title = '新会话', projectId: string | null = null): ChatSession {
  return {
    id: uid(),
    title,
    messages: [],
    draft: '',
    updatedAt: Date.now(),
    backendState: null,
    projectId,
  }
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatUpdatedAt(ts: number): string {
  const delta = Date.now() - ts
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  return `${Math.floor(delta / 86_400_000)} 天前`
}

export function formatDuration(ms?: number): string {
  if (!ms || ms < 0) return '进行中'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
}

export function parseListValue(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function sessionPreview(session: ChatSession): string {
  const last = [...session.messages].reverse().find((message) => message.role !== 'system')
  return last?.text.replace(/\s+/g, ' ').slice(0, 48) || '空会话'
}

export function roleLabel(role: Role): string {
  if (role === 'user') return '你'
  if (role === 'assistant') return 'Orion'
  return '系统'
}

export function sanitizeMessage(message: unknown): UiMessage {
  const cast = message as Partial<UiMessage>
  return {
    id: cast.id || uid('msg'),
    role: cast.role || 'assistant',
    text: cast.text || '',
    thoughts: Array.isArray(cast.thoughts) ? cast.thoughts : [],
    units: Array.isArray(cast.units) ? cast.units : [],
    createdAt: typeof cast.createdAt === 'number' ? cast.createdAt : Date.now(),
  }
}

export function autoResizeTextarea(element: HTMLTextAreaElement): void {
  element.style.height = '0px'
  element.style.height = `${Math.min(element.scrollHeight, 180)}px`
}
