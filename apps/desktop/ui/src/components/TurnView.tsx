import { type ReactElement } from 'react'
import { BlockRenderer } from './BlockRenderer'
import type { Turn } from '../types'

interface TurnViewProps {
  turn: Turn
  isStreaming?: boolean
  onApproval: (approvalId: string, decision: 'allow' | 'deny', remember: boolean) => void
}

function Avatar({ role }: { role: Turn['role'] }): ReactElement {
  if (role === 'user') {
    return <span className="avtr avtr--user" aria-hidden="true">你</span>
  }
  if (role === 'system') {
    return <span className="avtr avtr--system" aria-hidden="true">i</span>
  }
  return (
    <span className="avtr avtr--agent" aria-hidden="true">O</span>
  )
}

export function TurnView({ turn, isStreaming, onApproval }: TurnViewProps): ReactElement {
  const isUser = turn.role === 'user'

  return (
    <div className={`turn turn--${turn.role}`}>
      {isUser ? (
        /* User: right-aligned, avatar on the right */
        <div className="turn-user-wrap">
          <div className="turn-user-blocks">
            <div className="turn-meta turn-meta--user">
              <span className="turn-time">{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <span className="turn-label">你</span>
            </div>
            {turn.blocks.map((block, index) => (
              <div key={`${block.kind}-${index}`} className={`block block--${block.kind}`}>
                <BlockRenderer block={block} onApproval={onApproval} />
              </div>
            ))}
          </div>
          <div className="turn-avatar-col">
            <Avatar role={turn.role} />
          </div>
        </div>
      ) : (
        /* AI / System: left-aligned with connector line */
        <div className="turn-ai-wrap">
          <div className="turn-avatar-col">
            <Avatar role={turn.role} />
            <div className="turn-spine" aria-hidden="true" />
          </div>
          <div className="turn-ai-content">
            <div className="turn-meta turn-meta--ai">
              <span className="turn-label">{turn.role === 'system' ? '系统' : 'Orion'}</span>
              <span className="turn-time">{new Date(turn.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              {turn.agentTurn !== undefined && turn.agentTurn > 1 && (
                <span className="turn-step">第 {turn.agentTurn} 步</span>
              )}
            </div>
            {turn.blocks.map((block, index) => (
              <div key={`${block.kind}-${index}`} className={`block block--${block.kind}`}>
                <BlockRenderer
                  block={block}
                  isStreaming={isStreaming && index === turn.blocks.length - 1}
                  onApproval={onApproval}
                />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
