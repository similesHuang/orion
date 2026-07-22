import { type ReactElement } from 'react'

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
      <div className="settings-menu-item" style={{ opacity: 0.6, cursor: 'default' }}>
        <span className="settings-menu-icon">🎨</span>
        <span className="settings-menu-label">切换皮肤</span>
      </div>
      <div style={{ display: 'flex', gap: 4, padding: '2px 10px 6px' }}>
        <div
          className={`settings-theme-option ${themeMode === 'dark' ? 'active' : ''}`}
          onClick={() => onThemeChange('dark')}
        >
          🌙 暗夜
        </div>
        <div
          className={`settings-theme-option ${themeMode === 'light' ? 'active' : ''}`}
          onClick={() => onThemeChange('light')}
        >
          ☀️ 白昼
        </div>
      </div>
    </div>
  )
}
