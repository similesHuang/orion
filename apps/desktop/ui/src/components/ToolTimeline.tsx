import { useMemo, type ReactElement } from 'react'
import { Space, Spin, Typography } from 'antd'
import { formatDuration } from '../utils'
import type { Task, TimelineStep } from '../types'

interface ToolTimelineProps {
  task: Task | null
}

export function ToolTimeline({ task }: ToolTimelineProps): ReactElement {
  const steps = useMemo(() => {
    if (!task) return []
    return task.turns
      .flatMap((turn) => turn.blocks.filter((block) => block.kind === 'tool').map((block) => (block as { step: TimelineStep }).step))
      .sort((a, b) => a.startedAt - b.startedAt)
  }, [task])

  return (
    <aside className="tool-timeline">
      <header className="tool-timeline-header">
        <h3>Tool Timeline</h3>
      </header>
      <div className="tool-timeline-body">
        {steps.length === 0 && <p className="tool-timeline-empty">暂无工具调用</p>}
        {steps.map((step) => (
          <div key={step.id} className={`tool-timeline-item tool-timeline-item--${step.status}`}>
            <Space size={8}>
              <Typography.Text code>{step.toolName}</Typography.Text>
              {step.status === 'running' && <Spin size="small" />}
            </Space>
            <Typography.Text type="secondary">{formatDuration(step.durationMs)}</Typography.Text>
          </div>
        ))}
      </div>
    </aside>
  )
}
