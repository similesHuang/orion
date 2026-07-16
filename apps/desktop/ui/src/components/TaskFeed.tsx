import { useMemo, type ReactElement } from 'react'
import { TurnView } from './TurnView'
import { migrateMessagesToTask } from '../utils'
import type { ChatSession, Task } from '../types'

interface TaskCardProps {
  task: Task
  isStreaming: boolean
  streamingTurnId: string | null
}

function TaskCard({ task, isStreaming, streamingTurnId }: TaskCardProps): ReactElement {
  return (
    <article className={`task-card task-card--${task.status}`}>
      <header className="task-header">
        <h4 className="task-title">{task.title}</h4>
        <span className={`task-status task-status--${task.status}`}>{task.status}</span>
      </header>
      <div className="task-turns">
        {task.turns.map((turn, index) => (
          <TurnView
            key={turn.id}
            turn={turn}
            isStreaming={isStreaming && turn.id === streamingTurnId && index === task.turns.length - 1}
          />
        ))}
      </div>
    </article>
  )
}

interface TaskFeedProps {
  session: ChatSession
  streamingTaskId: string | null
  streamingTurnId: string | null
}

export function TaskFeed({ session, streamingTaskId, streamingTurnId }: TaskFeedProps): ReactElement {
  const tasks = useMemo(() => {
    const effectiveTasks =
      session.tasks.length > 0
        ? session.tasks
        : session.messages.length > 0
          ? [migrateMessagesToTask(session.messages)]
          : []
    return [...effectiveTasks].sort((a, b) => a.createdAt - b.createdAt)
  }, [session.tasks, session.messages])

  if (tasks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-constellation" aria-hidden="true" />
        <h2>交给我吧</h2>
        <p>说说你想做什么。读写文件、跑命令、查资料都行，我会在本地一步步做给你看。</p>
      </div>
    )
  }

  return (
    <div className="task-feed">
      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          isStreaming={task.id === streamingTaskId}
          streamingTurnId={streamingTurnId}
        />
      ))}
    </div>
  )
}
