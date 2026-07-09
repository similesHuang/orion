import { useMemo, type ReactElement } from 'react'
import { formatDateTime, formatDuration, formatTime } from './utils'
import type { TimelineState } from './types'

function StepStatus({ status }: { status: TimelineState['steps'][number]['status'] }): ReactElement {
  const label = status === 'running' ? '运行中' : status === 'done' ? '完成' : '异常'
  return <span className={`timeline-status timeline-status-${status}`}>{label}</span>
}

function TimelineStep({ step }: { step: TimelineState['steps'][number] }): ReactElement {
  return (
    <details className={`timeline-step timeline-step-${step.status}`} open={step.status === 'running'}>
      <summary>
        <span className="timeline-step-head">
          <span className="timeline-step-title">{step.title}</span>
          <span className="timeline-step-badges">
            <StepStatus status={step.status} />
            <span className="timeline-turn">Turn {step.turn}</span>
            <span className="timeline-duration">{formatDuration(step.durationMs)}</span>
          </span>
        </span>
      </summary>
      <div className="timeline-step-body">
        <div className="timeline-step-line">
          <strong>工具</strong>
          <span>{step.toolName}</span>
        </div>
        <div className="timeline-step-line">
          <strong>参数</strong>
          <code>{step.argsPreview || '{}'}</code>
        </div>
        <div className="timeline-step-line">
          <strong>开始</strong>
          <span>{formatDateTime(step.startedAt)}</span>
        </div>
        {step.resultSummary && (
          <div className="timeline-step-line">
            <strong>结果</strong>
            <span>{step.resultSummary}</span>
          </div>
        )}
      </div>
    </details>
  )
}

export function Timeline({ timeline }: { timeline: TimelineState | null | undefined }): ReactElement | null {
  const { doneCount, runningCount, errorCount, stepNodes } = useMemo(() => {
    const steps = timeline?.steps ?? []
    const doneCount = steps.filter((step) => step.status === 'done').length
    const runningCount = steps.filter((step) => step.status === 'running').length
    const errorCount = steps.filter((step) => step.status === 'error').length
    return {
      doneCount,
      runningCount,
      errorCount,
      stepNodes: steps.length
        ? steps.map((step) => <TimelineStep key={step.id} step={step} />)
        : [<div key="empty" className="timeline-empty">当前回复还没有捕获到工具步骤。</div>],
    }
  }, [timeline])

  if (!timeline || !timeline.steps.length) return null

  return (
    <details className="timeline-panel" open={timeline.running}>
      <summary>
        <span className="timeline-summary-text">工具执行时间线</span>
        <span className="timeline-summary-meta">
          <span className="timeline-chip neutral">{timeline.steps.length} 步</span>
          {doneCount > 0 && <span className="timeline-chip done">{doneCount} 完成</span>}
          {runningCount > 0 && <span className="timeline-chip running">{runningCount} 进行中</span>}
          {errorCount > 0 && <span className="timeline-chip error">{errorCount} 异常</span>}
        </span>
      </summary>
      <div className="timeline-meta-line">
        <span>请求 {timeline.requestId}</span>
        <span>最后更新 {formatTime(timeline.updatedAt)}</span>
      </div>
      <div className="timeline-steps">{stepNodes}</div>
    </details>
  )
}
