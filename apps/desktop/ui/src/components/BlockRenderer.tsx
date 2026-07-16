import { useEffect, useState, type ReactElement } from 'react'
import { MarkdownBlock } from '../markdown'
import { formatDuration } from '../utils'
import type { Block, TimelineStep } from '../types'

/** Human-facing label + one-line summary for a tool call, keyed on tool name. */
function describeTool(step: TimelineStep): { label: string; detail: string } {
  const args = step.args || {}
  const pick = (...keys: string[]): string => {
    for (const k of keys) {
      const v = args[k]
      if (typeof v === 'string' && v.trim()) return v
      if (typeof v === 'number') return String(v)
    }
    return ''
  }
  switch (step.toolName) {
    case 'file_read':
      return { label: '读取文件', detail: pick('path', 'file', 'filename') }
    case 'file_write':
      return { label: '写入文件', detail: pick('path', 'file', 'filename') }
    case 'file_patch':
      return { label: '修改文件', detail: pick('path', 'file', 'filename') }
    case 'code_run':
      return { label: '执行命令', detail: pick('command', 'cmd', 'code') }
    case 'web_navigate':
      return { label: '打开网页', detail: pick('url', 'href') }
    case 'web_scan':
      return { label: '扫描网页', detail: pick('url', 'query', 'href') }
    case 'web_execute_js':
      return { label: '执行脚本', detail: pick('url', 'script') }
    case 'ask_user':
      return { label: '询问用户', detail: pick('question', 'prompt') }
    case 'update_working_checkpoint':
      return { label: '更新进度', detail: pick('summary', 'note') }
    case 'start_long_term_update':
      return { label: '更新长期记忆', detail: pick('summary', 'note') }
    default:
      return { label: step.toolName, detail: '' }
  }
}

const STATUS_TEXT: Record<TimelineStep['status'], string> = {
  running: '进行中',
  done: '完成',
  error: '失败',
}

function ToolBlockView({ step }: { step: TimelineStep }): ReactElement {
  const [open, setOpen] = useState(false)
  const { label, detail } = describeTool(step)
  const hasRaw = Object.keys(step.args || {}).length > 0 || !!step.resultSummary

  return (
    <div className={`tool-card tool-card--${step.status}`}>
      <button
        type="button"
        className="tool-card-head"
        onClick={() => hasRaw && setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className={`tool-dot tool-dot--${step.status}`} aria-hidden="true" />
        <span className="tool-label">{label}</span>
        {detail && <span className="tool-detail" title={detail}>{detail}</span>}
        <span className="tool-spacer" />
        <span className={`tool-status tool-status--${step.status}`}>{STATUS_TEXT[step.status]}</span>
        {step.status !== 'running' && (
          <span className="tool-duration">{formatDuration(step.durationMs)}</span>
        )}
        {hasRaw && <span className={`tool-chevron ${open ? 'open' : ''}`} aria-hidden="true">›</span>}
      </button>
      {open && hasRaw && (
        <div className="tool-card-body">
          {Object.keys(step.args || {}).length > 0 && (
            <div className="tool-raw">
              <span className="tool-raw-label">参数</span>
              <pre>{JSON.stringify(step.args, null, 2)}</pre>
            </div>
          )}
          {step.resultSummary && (
            <div className="tool-raw">
              <span className="tool-raw-label">结果</span>
              <pre>{step.resultSummary}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Reasoning trace. Auto-collapses once the agent stops streaming into it, so a
 * finished reply stays clean but the thinking is one click away.
 */
function ThoughtBlockView({ content, isStreaming }: { content: string; isStreaming?: boolean }): ReactElement {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!isStreaming) setOpen(false)
  }, [isStreaming])

  return (
    <div className={`reasoning ${open ? 'is-open' : ''}`}>
      <button type="button" className="reasoning-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`reasoning-pulse ${isStreaming ? 'is-live' : ''}`} aria-hidden="true" />
        <span className="reasoning-title">{isStreaming ? '正在思考' : '思考过程'}</span>
        <span className={`reasoning-chevron ${open ? 'open' : ''}`} aria-hidden="true">›</span>
      </button>
      {open && (
        <div className="reasoning-body">
          <MarkdownBlock text={content} />
        </div>
      )}
    </div>
  )
}

function TerminalBlockView({ block }: { block: Extract<Block, { kind: 'terminal' }> }): ReactElement {
  return (
    <div className="block-terminal">
      <div className="block-terminal-header">
        <code>{block.command}</code>
        {block.exitCode !== undefined && <span className="terminal-exit">exit {block.exitCode}</span>}
      </div>
      <pre className="block-terminal-body">
        <code>{block.output}</code>
      </pre>
    </div>
  )
}

function DiffBlockView({ block }: { block: Extract<Block, { kind: 'diff' }> }): ReactElement {
  return (
    <div className="block-diff">
      <div className="block-diff-header">
        <code>{block.path}</code>
        <span className="diff-op">{block.op}</span>
      </div>
    </div>
  )
}

export function BlockRenderer({ block, isStreaming }: { block: Block; isStreaming?: boolean }): ReactElement {
  switch (block.kind) {
    case 'text':
      return <MarkdownBlock text={block.content} isStreaming={isStreaming} />
    case 'thought':
      return <ThoughtBlockView content={block.content} isStreaming={isStreaming} />
    case 'tool':
      return <ToolBlockView step={block.step} />
    case 'diff':
      return <DiffBlockView block={block} />
    case 'terminal':
      return <TerminalBlockView block={block} />
    case 'summary':
      return (
        <div className="block-summary">
          <MarkdownBlock text={block.content} />
        </div>
      )
    case 'error':
      return (
        <div className="block-error">
          <span className="block-error-mark" aria-hidden="true">!</span>
          <MarkdownBlock text={block.content} />
        </div>
      )
    default:
      return <></>
  }
}
