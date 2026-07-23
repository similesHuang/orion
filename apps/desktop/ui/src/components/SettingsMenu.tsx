import { type ReactElement } from 'react'
import { Switch } from 'antd'

interface SettingsMenuProps {
  onSelect: (section: string) => void
  gatewayConfigured: boolean
  themeMode: 'dark' | 'light'
  onThemeChange: (mode: 'dark' | 'light') => void
}

const MENU_ITEMS = [
  { key: 'model', icon: '🤖', label: '模型配置' },
  { key: 'gateway', icon: '🔌', label: 'Gateway 配置' },
  { key: 'diagnostics', icon: '📊', label: '运行诊断' },
]

export function SettingsMenu({ onSelect, gatewayConfigured, themeMode, onThemeChange }: SettingsMenuProps): ReactElement {
  const isDark = themeMode === 'dark'
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
      <div className="settings-menu-divider" />
      <div className="settings-menu-item" style={{ cursor: 'default' }}>
        <span className="settings-menu-icon">🌙</span>
        <span className="settings-menu-label">暗夜模式</span>
        <Switch
          size="small"
          checked={isDark}
          onChange={(checked) => onThemeChange(checked ? 'dark' : 'light')}
          style={{ marginLeft: 'auto' }}
        />
        <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--ink-mute)' }}>☀️</span>
      </div>
    </div>
  )
}
