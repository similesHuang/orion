import { type ReactElement } from 'react'
import { Typography } from 'antd'

interface SettingsMenuProps {
  onSelect: (section: string) => void
  gatewayConfigured: boolean
}

const MENU_ITEMS = [
  { key: 'model', icon: '🤖', label: '模型配置' },
  { key: 'gateway', icon: '🔌', label: 'Gateway 配置' },
  { key: 'diagnostics', icon: '📊', label: '运行诊断' },
]

export function SettingsMenu({ onSelect, gatewayConfigured }: SettingsMenuProps): ReactElement {
  return (
    <div className="settings-menu">
      {MENU_ITEMS.map((item) => (
        <div
          key={item.key}
          className="settings-menu-item"
          onClick={() => onSelect(item.key)}
        >
          <span className="settings-menu-icon">{item.icon}</span>
          <span className="settings-menu-label">{item.label}</span>
          {item.key === 'gateway' && gatewayConfigured && (
            <span className="settings-menu-badge">✓</span>
          )}
        </div>
      ))}
    </div>
  )
}
