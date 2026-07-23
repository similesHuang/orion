import { useEffect, useState, type ReactElement } from 'react'
import { MarkdownBlock } from '../markdown'
import type { ApprovalRequest, Block, TimelineStep } from '../types'

type ApprovalHandler = (approvalId: string, decision: 'allow' | 'deny', remember: boolean) => void

const RISK_LABEL: Record<string, string> = {
  code_run: '执行命令',
  file_write: '写入文件',
  file_patch: '修改文件',
}

const TOOL_ICON: Record<string, string> = {
  file_read: '📄',
  file_write: '✏️',
  file_patch: '🔧',
  code_run: '⚡',
  web_navigate: '🌐',
  web_scan: '🔍',
  web_execute_js: '📜',
  ask_user: '💬',
  update_working_checkpoint: '📋',
  start_long_term_update: '🧠',
}

const STATUS_TEXT: Record<TimelineStep['status'], string> = {
  running: '进行中',
  done: '完成',
  error: '失败',
}

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
    case 'file_read': return { label: '读取文件', detail: pick('path', 'file', 'filename') }
    case 'file_write': return { label: '写入文件', detail: pick('path', 'file', 'filename') }
    case 'file_patch': return { label: '修改文件', detail: pick('path', 'file', 'filename') }
    case 'code_run': return { label: '执行命令', detail: pick('command', 'cmd', 'code') }
    case 'web_navigate': return { label: '打开网页', detail: pick('url', 'href') }
    case 'web_scan': return { label: '扫描网页', detail: pick('url', 'query', 'href') }
    case 'web_execute_js': return { label: '执行脚本', detail: pick('url', 'script') }
    case 'ask_user': return { label: '询问用户', detail: pick('question', 'prompt') }
    case 'update_working_checkpoint': return { label: '更新进度', detail: pick('summary', 'note') }
    case 'start_long_term_update': return { label: '更新长期记忆', detail: pick('summary', 'note') }
    default: return { label: step.toolName, detail: '' }
  }
}

function ApprovalBlockView({ approval, onApproval }: { approval: ApprovalRequest; onApproval: ApprovalHandler }): ReactElement {
  const label = RISK_LABEL[approval.toolName] || approval.toolName
  const preview = (() => {
    const args = approval.args
    const s = (k: string) => (typeof args[k] === 'string' ? args[k] as string : '')
    if (approval.toolName === 'code_run') return s('command') || s('cmd') || s('code')
    return s('path') || s('file') || s('filename')
  })()
  const decided = approval.status !== 'pending'

  return (
    <div className={`tcard tcard--approval tcard--${approval.status}`}>
      <div className="tcard-head">
        <span className="tcard-icon">⚠️</span>
        <span className="tcard-name">需要审批</span>
        <code className="tcard-cmd">{label}</code>
      </div>
      {preview && <div className="tcard-preview"><code>{preview}</code></div>}
      {!decided && (
        <div className="tcard-actions">
          <button type="button" className="tcard-btn tcard-btn--allow" onClick={() => onApproval(approval.approvalId, 'allow', false)}>
            批准
          </button>
          <button type="button" className="tcard-btn tcard-btn--session" onClick={() => onApproval(approval.approvalId, 'allow', true)}>
            本次会话都允许
          </button>
          <button type="button" className="tcard-btn tcard-btn--deny" onClick={() => onApproval(approval.approvalId, 'deny', false)}>
            拒绝
          </button>
        </div>
      )}
    </div>
  )
}

function ToolBlockView({ step }: { step: TimelineStep }): ReactElement {
  const [open, setOpen] = useState(false)
  const { label, detail } = describeTool(step)
  const isRunning = step.status === 'running'
  const icon = TOOL_ICON[step.toolName] || '🔧'

  return (
    <div className={`tcard tcard--tool tcard--${step.status}`}>
      <div className="tcard-head" onClick={() => !isRunning && setOpen((v) => !v)} style={{ cursor: isRunning ? 'default' : 'pointer' }}>
        <span className="tcard-icon">{isRunning ? '⏳' : icon}</span>
        <span className="tcard-name">{label}</span>
        {detail && <code className="tcard-cmd">{detail}</code>}
        <span className="tcard-spacer" />
        {isRunning ? (
          <span className="tcard-status tcard-status--live">进行中 <span className="tcard-dots"><span /><span /><span /></span></span>
        ) : (
          <>
            <span className={`tcard-status tcard-status--${step.status}`}>{STATUS_TEXT[step.status]}</span>
            {step.durationMs != null && <span className="tcard-duration">{step.durationMs >= 1000 ? `${(step.durationMs / 1000).toFixed(1)}s` : `${step.durationMs}ms`}</span>}
            <span className={`tcard-chevron ${open ? 'open' : ''}`} aria-hidden="true">▾</span>
          </>
        )}
      </div>
      {open && !isRunning && (
        <div className="tcard-body">
          {Object.keys(step.args || {}).length > 0 && (
            <div className="tcard-section">
              <span className="tcard-section-label">参数</span>
              <pre className="tcard-pre">{JSON.stringify(step.args, null, 2)}</pre>
            </div>
          )}
          {step.resultSummary && (
            <div className="tcard-section">
              <span className="tcard-section-label">结果</span>
              {step.toolName === 'code_run' ? (
                <pre className="tcard-pre tcard-pre--output">{step.resultSummary}</pre>
              ) : (
                <div className="tcard-md"><MarkdownBlock text={step.resultSummary} /></div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function ThoughtBlockView({ content, isStreaming }: { content: string; isStreaming?: boolean }): ReactElement {
  const [open, setOpen] = useState(true)
  useEffect(() => {
    if (!isStreaming) setOpen(false)
  }, [isStreaming])

  return (
    <div className={`thought ${open ? 'thought--open' : ''}`}>
      <button type="button" className="thought-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className={`thought-dot ${isStreaming ? 'thought-dot--live' : ''}`} aria-hidden="true" />
        <span className="thought-label">{isStreaming ? '思考中' : '思考过程'}</span>
        <span className={`thought-chevron ${open ? 'open' : ''}`} aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="thought-body">
          <MarkdownBlock text={content} />
        </div>
      )}
    </div>
  )
}

function TerminalBlockView({ block }: { block: Extract<Block, { kind: 'terminal' }> }): ReactElement {
  return (
    <div className="tcard tcard--tool tcard--done">
      <div className="tcard-head">
        <span className="tcard-icon">💻</span>
        <span className="tcard-name">终端</span>
        <code className="tcard-cmd">{block.command}</code>
        {block.exitCode !== undefined && <span className="tcard-duration">exit {block.exitCode}</span>}
      </div>
      <pre className="tcard-pre tcard-pre--output" style={{ margin: 0, borderTop: '1px solid var(--line)' }}>{block.output}</pre>
    </div>
  )
}

function DiffBlockView({ block }: { block: Extract<Block, { kind: 'diff' }> }): ReactElement {
  return (
    <div className="tcard tcard--tool tcard--done">
      <div className="tcard-head">
        <span className="tcard-icon">📝</span>
        <span className="tcard-name">修改文件</span>
        <code className="tcard-cmd">{block.path}</code>
        <span className={`tcard-status tcard-status--${block.op === 'delete' ? 'error' : 'done'}`}>{block.op}</span>
      </div>
    </div>
  )
}

export function BlockRenderer({
  block,
  isStreaming,
  onApproval,
}: {
  block: Block
  isStreaming?: boolean
  onApproval: ApprovalHandler
}): ReactElement {
  switch (block.kind) {
    case 'text':
      return <MarkdownBlock text={block.content} isStreaming={isStreaming} />
    case 'thought':
      return <ThoughtBlockView content={block.content} isStreaming={isStreaming} />
    case 'tool':
      return <ToolBlockView step={block.step} />
    case 'approval':
      return <ApprovalBlockView approval={block.approval} onApproval={onApproval} />
    case 'diff':
      return <DiffBlockView block={block} />
    case 'terminal':
      return <TerminalBlockView block={block} />
    case 'summary':
      return <div className="block-summary"><MarkdownBlock text={block.content} /></div>
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
