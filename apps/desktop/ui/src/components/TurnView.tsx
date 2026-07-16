import { type ReactElement } from 'react'
import { BlockRenderer } from './BlockRenderer'
import { roleLabel } from '../utils'
import type { Turn } from '../types'

interface TurnViewProps {
  turn: Turn
  isStreaming?: boolean
}

function Avatar({ role }: { role: Turn['role'] }): ReactElement {
  if (role === 'user') {
    return <span className="turn-avatar turn-avatar--user" aria-hidden="true">你</span>
  }
  if (role === 'system') {
    return <span className="turn-avatar turn-avatar--system" aria-hidden="true">i</span>
  }
  return (
    <span className="turn-avatar turn-avatar--agent" aria-hidden="true">
      <span className="agent-eye" />
      <span className="agent-eye" />
    </span>
  )
}

export function TurnView({ turn, isStreaming }: TurnViewProps): ReactElement {
  return (
    <div className={`turn turn--${turn.role}`}>
      <div className="turn-gutter">
        <Avatar role={turn.role} />
        {turn.role !== 'user' && <span className="turn-spine" aria-hidden="true" />}
      </div>
      <div className="turn-body">
        <div className="turn-meta">
          <span className="turn-role">{roleLabel(turn.role)}</span>
          {turn.agentTurn !== undefined && turn.agentTurn > 1 && (
            <span className="turn-agent-turn">第 {turn.agentTurn} 步</span>
          )}
        </div>
        <div className="turn-blocks">
          {turn.blocks.map((block, index) => (
            <div key={`${block.kind}-${index}`} className={`block block--${block.kind}`}>
              <BlockRenderer block={block} isStreaming={isStreaming && index === turn.blocks.length - 1} />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
