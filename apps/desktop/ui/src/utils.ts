import type { ChatSession, Role, TimelineState, UiMessage } from './types'

export interface SseEvent {
  event?: string
  data: string
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

export function basename(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

export function createSession(title = '新会话', projectId: string | null = null): ChatSession {
  return {
    id: uid(),
    title,
    projectId,
    messages: [],
    draft: '',
    pendingFiles: [],
    updatedAt: Date.now(),
    backendState: null,
  }
}

export function cloneTimeline(timeline: TimelineState | null | undefined): TimelineState | null {
  return timeline ? (JSON.parse(JSON.stringify(timeline)) as TimelineState) : null
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
    createdAt: typeof cast.createdAt === 'number' ? cast.createdAt : Date.now(),
    timeline: cloneTimeline(cast.timeline),
  }
}

export function autoResizeTextarea(element: HTMLTextAreaElement): void {
  element.style.height = '0px'
  element.style.height = `${Math.min(element.scrollHeight, 180)}px`
}
