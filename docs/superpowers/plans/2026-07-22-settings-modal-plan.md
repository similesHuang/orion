# 设置面板 Modal 重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the unified settings Drawer with per-section Modals triggered by the settings popover menu.

**Architecture:** Add `settingsSection` state to track which config panel to show. Replace `<Drawer>` with Ant Design `<Modal>`. Split `renderSettingsBody` into per-section render functions. Style Modal with solid dark background.

**Tech Stack:** React, TypeScript, Ant Design (Modal component)

## Global Constraints

- Modal background must be solid `#1c1d21` (not translucent)
- Overlay must be `rgba(0,0,0,0.55)` with no backdrop-filter blur
- All three sections (model, gateway, diagnostics) must render independently
- Save/close behavior must be identical to current Drawer
- `pnpm typecheck` must pass after changes

---

### Task 1: Add settings section state and split render functions

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx`

**Interfaces:**
- Consumes: existing `settings` state, `handleSaveSettings`, `loadSettings`, `renderDiagnostics`, `PRIMARY_MODEL_FIELDS`, `GATEWAY_SPECS`, `renderExtraEnvKeys`
- Produces: `settingsSection` state, `handleSettingsMenuSelect` writes section, 3 render functions

- [ ] **Step 1: Add `settingsSection` state and update handler**

Add near other state hooks (~line 170):
```tsx
const [settingsSection, setSettingsSection] = useState<string>('model')
```

Replace the existing `handleSettingsMenuSelect`:
```tsx
const handleSettingsMenuSelect = useCallback((section: string) => {
  setSettingsPopoverOpen(false)
  setSettingsSection(section)
  setSettings({ open: true })
}, [])
```

- [ ] **Step 2: Split renderSettingsBody into per-section functions**

Replace the single `renderSettingsBody` with three named render functions, placed before `orionTheme`:

```tsx
const renderModelConfig = () => (
  <>
    {settings.error && <div className="settings-error">配置加载失败：{settings.error}</div>}
    <section className="settings-section">
      <div className="form-grid">
        {PRIMARY_MODEL_FIELDS.map((field) => (
          <FieldInput key={field.key} field={field} value={getFieldValue(field)} onChange={updateField} />
        ))}
      </div>
    </section>
    {renderExtraEnvKeys.length > 0 && (
      <details className="settings-details">
        <summary style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', cursor: 'pointer', padding: '8px 0' }}>
          其他环境变量 ({renderExtraEnvKeys.length})
        </summary>
        <div className="form-grid" style={{ marginTop: 8 }}>
          {renderExtraEnvKeys.map((key) => (
            <FieldInput key={key} field={{ scope: 'env', key, label: key }} value={String(settings.env[key] ?? '')} onChange={updateField} />
          ))}
        </div>
      </details>
    )}
  </>
)

const renderGatewayConfig = () => (
  <>
    {settings.error && <div className="settings-error">配置加载失败：{settings.error}</div>}
    <div className="gateway-grid">
      {GATEWAY_SPECS.map((spec) => {
        const diagnostic = settings.diagnostics?.gateways.find((item) => item.id === spec.id)
        const statusText = diagnostic?.configured ? '已配置' : diagnostic ? `缺少 ${diagnostic.requiredMissing.join(', ')}` : '待检测'
        return (
          <article className="gateway-card" key={spec.id}>
            <div className="gateway-card-head">
              <div>
                <h4>{spec.label}</h4>
                <p>{spec.description}</p>
              </div>
              <span className={`gateway-state ${diagnostic?.configured ? 'ok' : 'warn'}`}>{statusText}</span>
            </div>
            <div className="form-grid">
              {spec.fields.map((field) => (
                <FieldInput key={field.key} field={field} value={getFieldValue(field)} onChange={updateField} />
              ))}
            </div>
          </article>
        )
      })}
    </div>
  </>
)

const renderDiagnosticsPanel = () => (
  settings.diagnostics
    ? renderDiagnostics(settings.diagnostics, gatewayRunning, handleStartGateway, handleStopGateway)
    : <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.35)' }}>尚未获取到诊断信息。</p>
)
```

Remove the old `renderSettingsBody` function entirely.

- [ ] **Step 3: Verify build**

```bash
pnpm typecheck
```
Expected: passes (the old `renderSettingsBody` is gone but `settingsSection` and new functions are defined).

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/ui/src/App.tsx
git commit -m "feat(desktop): add settings section state and split render functions"
```

---

### Task 2: Replace Drawer with Modal and add custom styles

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx` (the Drawer → Modal JSX)
- Modify: `apps/desktop/ui/src/style.css` (Modal/input custom styles)

- [ ] **Step 1: Replace Drawer import with Modal**

In the antd import line (line 11-24), replace:
```tsx
import {
  Badge,
  Button,
  Collapse,
  ConfigProvider,
  Drawer,
  Layout,
  List,
  Modal,
  Popover,
  ...
} from 'antd'
```

Remove `Drawer` from the imports, add `Modal`. Keep all other imports.

- [ ] **Step 2: Replace the Drawer JSX with Modal JSX**

Find the `<Drawer` block (around line 1297) and replace with:

```tsx
<Modal
  open={settings.open}
  onCancel={() => setSettings({ open: false })}
  footer={
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
      <Button onClick={() => setSettings({ open: false })}>取消</Button>
      <Button type="primary" onClick={() => void handleSaveSettings()} loading={settings.saving}>
        保存配置
      </Button>
    </div>
  }
  width={520}
  centered
  destroyOnClose
  className="settings-modal"
>
  <div style={{ padding: '4px 0' }}>
    {settingsSection === 'model' && renderModelConfig()}
    {settingsSection === 'gateway' && renderGatewayConfig()}
    {settingsSection === 'diagnostics' && renderDiagnosticsPanel()}
  </div>
</Modal>
```

Set the Modal title dynamically based on section:
```tsx
title={
  <div>
    <div style={{ fontSize: 10, textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)', letterSpacing: 1 }}>设置</div>
    <div style={{ fontSize: 15, fontWeight: 600, color: 'rgba(255,255,255,0.9)', marginTop: 1 }}>
      {settingsSection === 'model' && '🤖 模型配置'}
      {settingsSection === 'gateway' && '🔌 Gateway 配置'}
      {settingsSection === 'diagnostics' && '📊 运行诊断'}
    </div>
  </div>
}
```

- [ ] **Step 3: Add Modal CSS to style.css**

```css
/* ── Settings Modal ── */
.settings-modal .ant-modal-content {
  background: #1c1d21;
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 14px;
  box-shadow: 0 24px 80px rgba(0,0,0,0.6);
  padding: 0;
}
.settings-modal .ant-modal-header {
  background: transparent;
  border-bottom: 1px solid rgba(255,255,255,0.06);
  padding: 16px 20px;
  margin: 0;
}
.settings-modal .ant-modal-body {
  padding: 20px;
  background: transparent;
}
.settings-modal .ant-modal-footer {
  border-top: 1px solid rgba(255,255,255,0.06);
  padding: 14px 20px;
  margin: 0;
  background: transparent;
}
.settings-modal .ant-modal-close {
  top: 16px;
  right: 20px;
  color: rgba(255,255,255,0.25);
}

/* Modal overlay — solid dark, no blur */
.ant-modal-mask {
  background: rgba(0,0,0,0.55) !important;
}

/* Deeper input background inside modal */
.settings-modal .settings-input,
.settings-modal .settings-textarea,
.settings-modal .settings-select {
  background: #131418;
  border: 1px solid rgba(255,255,255,0.06);
  border-radius: 7px;
}
```

- [ ] **Step 4: Clean up old Drawer-related state**

Remove `settingsStateLabel` memo if no longer referenced. Check if `settings.dirty` tracking is still needed (yes, for save button feedback — keep it).

Remove unused imports: `Drawer` should be removed from antd import.

- [ ] **Step 5: Verify build**

```bash
pnpm typecheck
```
Expected: passes. No `Drawer` reference remaining, `Modal` properly imported.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src/App.tsx apps/desktop/ui/src/style.css
git commit -m "feat(desktop): replace settings drawer with per-section modal"
```
