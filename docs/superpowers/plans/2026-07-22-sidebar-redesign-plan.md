# 侧边栏与输入框 UI 精简 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify the desktop sidebar and input area by removing cluttered UI elements and adding a settings popover menu.

**Architecture:** Pure React UI changes to `App.tsx` and `style.css`. Add one small `SettingsMenu.tsx` component. All changes are cosmetic/deletions — no backend logic touched.

**Tech Stack:** React, TypeScript, Ant Design, Ant Design X

## Global Constraints

- No backend/sidecar changes — all changes are frontend-only
- Keep session/project state management and data flow unchanged
- The drawer-based settings panels (model config, gateway config, diagnostics) stay — only the entry point changes from direct button to popover → drawer
- Slash command hints in the input area are preserved
- `pnpm typecheck` must pass after changes

---

### Task 1: Simplify sidebar — brand area and session list

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx` (lines 1300-1470 — sidebar section)

**Interfaces:**
- Consumes: existing `chatState`, `handleCreateSession`, `handleSwitchSession`, `handleToggleExpandProject`, `projectsSorted`, `standaloneSessions`, `session`, `sessionPreview`, `formatUpdatedAt`, `currentProject`, `handleRefreshProjectBranch` (some will be removed)
- Produces: clean sidebar with brand + project groups + standalone session group + settings button at bottom

- [ ] **Step 1: Simplify brand area and toolbar**

Replace the current brand mark + toolbar Space (lines 1300-1331) with a compact header:

```tsx
{/* Brand + New session button */}
<div className="sidebar-brand" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 14px 6px' }}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <div className="brand-mark" aria-hidden="true">
      <span className="brand-star brand-star--a" />
      <span className="brand-star brand-star--b" />
      <span className="brand-star brand-star--c" />
      <span className="brand-star brand-star--d" />
      <span className="brand-orbit" />
    </div>
    <Typography.Text className="brand-name" style={{ fontSize: 13, fontWeight: 600 }}>Orion</Typography.Text>
  </div>
  <Tooltip title="新建会话">
    <Button type="text" size="small" icon={<PlusOutlined />} onClick={handleCreateSession} />
  </Tooltip>
</div>
```

Key changes: removed "本地 Agent" tagline, removed FolderAddOutlined and SettingOutlined buttons from toolbar.

- [ ] **Step 2: Simplify Project collapse items**

Replace the Project collapse's `items` prop (lines 1349-1427 area) to remove all action icons and add compact session items:

```tsx
items={projectsSorted.map((project) => {
  const sessionsOfProject = projectSessions(project.id)
  return {
    key: project.id,
    label: (
      <div className="project-collapse-header" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>{project.name}</span>
        {project.gitBranch && (
          <Badge count={project.gitBranch} color="blue" style={{ backgroundColor: '#3b82f6', fontSize: 9 }} />
        )}
      </div>
    ),
    children: (
      <List
        size="small"
        dataSource={sessionsOfProject}
        locale={{ emptyText: '暂无会话' }}
        renderItem={(item) => (
          <List.Item
            key={item.id}
            className={`session-list-item ${item.id === session?.id ? 'active' : ''}`}
            onClick={() => void handleSwitchSession(item.id)}
            style={{ padding: '4px 6px 4px 24px', border: 'none', cursor: 'pointer' }}
          >
            <div style={{ width: '100%', overflow: 'hidden' }}>
              <div style={{ fontSize: 12, color: item.id === session?.id ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {item.title}
              </div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 2 }}>
                {formatUpdatedAt(item.updatedAt)}
              </div>
            </div>
          </List.Item>
        )}
      />
    ),
  }
})}
```

Key changes: removed ReloadOutlined/EditOutlined/PlusOutlined/DeleteOutlined buttons from project header. Removed `.session-item-desc` (message preview). Added compact 2-line session item (title + time).

- [ ] **Step 3: Simplify standalone sessions section**

Replace the standalone sessions Menu (lines 1432-1448) to match the compact style:

```tsx
<div className="sidebar-section" style={{ marginTop: 8 }}>
  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 6px' }}>
    <Typography.Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.7)', fontWeight: 500 }}>
      独立会话
    </Typography.Text>
    <span style={{ marginLeft: 'auto', fontSize: 10, color: 'rgba(255,255,255,0.25)' }}>
      {standaloneSessions.length}
    </span>
  </div>
  {standaloneSessions.map((item) => (
    <div
      key={item.id}
      className={`session-list-item ${item.id === session?.id ? 'active' : ''}`}
      onClick={() => void handleSwitchSession(item.id)}
      style={{ padding: '4px 6px 4px 22px', cursor: 'pointer', borderRadius: 4 }}
    >
      <div style={{ fontSize: 12, color: item.id === session?.id ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {item.title}
      </div>
      <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', marginTop: 1 }}>
        {formatUpdatedAt(item.updatedAt)}
      </div>
    </div>
  ))}
</div>
```

- [ ] **Step 4: Replace sidebar footer with settings button**

Replace the current sidebar-footer (lines 1451-1468) with just a settings button:

```tsx
<div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 12px' }}>
  <Popover
    content={<SettingsMenu onSelect={handleSettingsMenuSelect} gatewayConfigured={gatewayConfigured} />}
    trigger="click"
    placement="top"
    overlayClassName="settings-popover"
    open={settingsPopoverOpen}
    onOpenChange={setSettingsPopoverOpen}
  >
    <div className="sidebar-settings-btn">
      <span style={{ fontSize: 13, marginRight: 6 }}>⚙</span>
      <span style={{ fontSize: 11 }}>设置</span>
    </div>
  </Popover>
</div>
```

- [ ] **Step 5: Add state and handler for settings popover**

Add these near the top of the App component with other state hooks:

```tsx
const [settingsPopoverOpen, setSettingsPopoverOpen] = useState(false)

const gatewayConfigured = useMemo(() => {
  return settings.diagnostics?.gateways.some((g) => g.configured) ?? false
}, [settings.diagnostics])
```

Add this handler with other handler callbacks:

```tsx
const handleSettingsMenuSelect = useCallback((section: string) => {
  setSettingsPopoverOpen(false)
  setSettings({ open: true })
  // Optionally scroll to section or set active tab in the drawer
}, [])
```

- [ ] **Step 6: Verify build**

```bash
pnpm typecheck
```
Expected: passes cleanly (the removed variables like `handleAddProjectDirectory` etc. need to be checked — if they become unused, remove them or keep them referenced elsewhere).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/ui/src/App.tsx
git commit -m "refactor(desktop): simplify sidebar layout"
```

---

### Task 2: Create SettingsMenu popover component

**Files:**
- Create: `apps/desktop/ui/src/components/SettingsMenu.tsx`

**Interfaces:**
- Consumes: `{ onSelect: (section: string) => void, gatewayConfigured: boolean }`
- Produces: popover content with 3 menu items

- [ ] **Step 1: Create SettingsMenu.tsx**

```tsx
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
```

- [ ] **Step 2: Verify build**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/ui/src/components/SettingsMenu.tsx
git commit -m "feat(desktop): add settings popover menu component"
```

---

### Task 3: Simplify input area — remove attachments, model selector, binding bar, drag-drop

**Files:**
- Modify: `apps/desktop/ui/src/App.tsx` (lines 1572-1630 area — composer area)
- Modify: `apps/desktop/ui/src/style.css` (remove drag-drop related CSS, simplify composer area)

**Interfaces:**
- Consumes: existing `handleSend`, `handleStop`, `streaming`, `sidecarReady`, `session`, `dispatch`, `slashMatches`, `commands`
- Removes: `handleAttachFile`, `dragging`, `handleDragOver`, `handleDragLeave`, `handleDrop`, `handleExportConversation`, `handleImportConversation`, model selector, binding bar
- Produces: clean input area with text input + send button + slash command hints

- [ ] **Step 1: Remove unused state, refs, and handlers**

Remove from App.tsx:
- `dragging` state (if no longer used elsewhere)
- `handleAttachFile` callback
- `handleDragOver`, `handleDragLeave`, `handleDrop` callbacks
- `handleExportConversation`, `handleImportConversation` callbacks
- Remove imports for `DownloadOutlined`, `UploadOutlined` if no longer used

Check `handleAddProjectDirectory` — if it's now unused, remove it too.

Check `projectSessions` and `handleUnbindCurrentProject` — keep if referenced elsewhere.

- [ ] **Step 2: Simplify the composer-area JSX**

Replace the current composer-area (lines 1572-1630 area) with:

```tsx
<div className="composer-area">
  {slashMatches.length > 0 && (
    <div className="slash-hints">
      {slashMatches.map((c) => (
        <button
          key={c.command}
          type="button"
          className="slash-hint"
          onClick={() => {
            if (!session) return
            const filled = c.command.includes('[') || c.command.includes('<')
              ? `${c.command.split(' ')[0]} `
              : c.command
            dispatch({ type: 'setDraft', sessionId: session.id, draft: filled })
          }}
        >
          <span className="slash-cmd">{c.command}</span>
          <span className="slash-desc">{c.description}</span>
        </button>
      ))}
    </div>
  )}
  <Sender
    rootClassName="orion-sender"
    value={session?.draft || ''}
    onChange={(value) => {
      if (!session) return
      dispatch({ type: 'setDraft', sessionId: session.id, draft: value })
    }}
    onSubmit={() => void handleSend()}
    onCancel={handleStop}
    loading={streaming}
    disabled={!sidecarReady}
    submitType="enter"
    placeholder={sidecarReady ? '输入任务或问题' : 'sidecar 启动中…'}
  />
</div>
```

Key changes: removed `prefix` slot (attachment button), removed `footer` slot (model selector + project binding), removed drag-drop overlay and event handlers.

- [ ] **Step 3: Update style.css — remove drag-drop styles, update composer area**

Remove from style.css:
- `.composer-area.drag-over .orion-sender`
- `.drop-overlay`
- `.attach-btn`
- `.attachment-preview-*`

Simplify `.composer-area` styles — keep glassmorphic background.

- [ ] **Step 4: Re-check unused imports**

Remove unused imports from App.tsx:
- `open` from `@tauri-apps/plugin-dialog` (if no longer used for attachments)
- `readFile`, `readTextFile`, `writeTextFile` from `@tauri-apps/plugin-fs`
- `uploadFile`, `exportConversation`, `importConversation` from `./api`
- `DownloadOutlined`, `UploadOutlined` from `@ant-design/icons`
- `FolderAddOutlined` if `handleAddProjectDirectory` was removed

Keep imports that are used elsewhere (e.g., `SettingOutlined` is no longer in toolbar but might be referenced — check before removing).

- [ ] **Step 5: Verify build**

```bash
pnpm typecheck
```
Expected: passes cleanly with no unused variable/import errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src/App.tsx apps/desktop/ui/src/style.css
git commit -m "refactor(desktop): simplify input area"
```

---

### Task 4: CSS refinements for compact sidebar and settings popover

**Files:**
- Modify: `apps/desktop/ui/src/style.css`

- [ ] **Step 1: Add .sidebar-settings-btn styles**

```css
.sidebar-settings-btn {
  display: flex;
  align-items: center;
  padding: 5px 10px;
  border-radius: 5px;
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.06);
  cursor: pointer;
  color: rgba(255,255,255,0.35);
  transition: background 0.15s, border-color 0.15s;
  width: 100%;
}
.sidebar-settings-btn:hover {
  background: rgba(255,255,255,0.07);
  border-color: rgba(255,255,255,0.1);
  color: rgba(255,255,255,0.5);
}
```

- [ ] **Step 2: Add .settings-menu styles**

```css
.settings-menu {
  min-width: 180px;
}
.settings-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 6px;
  cursor: pointer;
  color: rgba(255,255,255,0.8);
  font-size: 12px;
  transition: background 0.15s;
}
.settings-menu-item:hover {
  background: rgba(255,255,255,0.06);
}
.settings-menu-icon {
  font-size: 14px;
  line-height: 1;
}
.settings-menu-label {
  flex: 1;
}
.settings-menu-badge {
  font-size: 10px;
  color: #4fd1c5;
  background: rgba(79,209,197,0.12);
  padding: 1px 6px;
  border-radius: 4px;
}
```

- [ ] **Step 3: Add .session-list-item.active styles**

```css
.session-list-item {
  border-radius: 4px;
  transition: background 0.15s;
}
.session-list-item:hover {
  background: rgba(255,255,255,0.04);
}
.session-list-item.active {
  background: rgba(79,209,197,0.08);
  border-left: 2px solid #4fd1c5;
  padding-left: 22px !important;
}
```

- [ ] **Step 4: Update Ant Design Popover overlay**

```css
.settings-popover .ant-popover-inner {
  background: rgba(30, 31, 38, 0.95);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 10px;
  padding: 6px;
  box-shadow: 0 12px 40px rgba(0,0,0,0.5);
}
```

- [ ] **Step 5: Verify build**

```bash
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/ui/src/style.css
git commit -m "style(desktop): add compact sidebar and settings popover styles"
```
