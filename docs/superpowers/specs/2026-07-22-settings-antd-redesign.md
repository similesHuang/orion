# Orion 设置面板 — Ant Design 原生方案

> 版本：v0.1
> 日期：2026-07-22
> 状态：草稿

---

## 1. 问题

当前设置面板存在两个问题：

1. **透明覆盖** — CSS 覆盖规则冲突（先统一设 `#1c1d21`，又被 `header/body/footer { transparent }` 覆盖），导致面板内容在半透明 background 上叠加显示
2. **未使用 Ant Design 组件** — `FieldInput` 手写组件，`<article>`/`<details>`/`<summary>` 原生标签混用，按钮使用 inline styles 而不是 `Button`，与 Ant Design 主题系统脱节

## 2. 设计目标

1. 正确使用 Ant Design Modal + Form + Input 组件
2. 减少自定义 CSS 覆盖，通过主题 token 控制样式
3. 所有背景实心不透明
4. 保持 glassmorphic 整体风格一致

## 3. 方案

### 3.1 组件替换

| 当前 | 替换为 |
|------|--------|
| `<div>` + inline styles 标题 | `<Modal title>` |
| `FieldInput`（手写 label + input） | `<Form.Item>` + `<Input>` / `<Input.Password>` |
| `<article>` gateway 卡片 | `<Card>` |
| `<details>` 其他环境变量 | `<Collapse>` |
| `<span>` 取消/保存按钮 | `<Button>` |
| 手写 Diagnostics 卡片 | `<Card>` + `<Descriptions>` |

### 3.2 CSS 策略

不再逐个覆盖 `.ant-modal-header { background: transparent }`。改为：

1. **主题 token**：`colorBgElevated: '#1c1d21'` — Modal 背景色全局生效
2. **自定义 CSS 最少化**：
   ```css
   .settings-modal .ant-modal-content {
     border-radius: 12px;
     border: 1px solid rgba(255,255,255,0.08);
     box-shadow: 0 24px 80px rgba(0,0,0,0.5);
   }
   .settings-modal .ant-input,
   .settings-modal .ant-input-password {
     background: #0d0e12;
     border-color: rgba(255,255,255,0.06);
   }
   ```
3. **遮罩层**：`rgba(0,0,0,0.55)` 纯色，无模糊

### 3.3 交互

- Modal `destroyOnClose` — 每次打开重新渲染
- Modal `centered` — 居中
- Modal 固定高度 `max-height: 520px`，内容区域 `overflow-y: auto`
- Modal footer: `<Button>取消</Button>` + `<Button type="primary" loading={saving}>保存配置</Button>`
- 脏状态检查通过 `settings.dirty` 控制保存按钮可用性

### 3.4 三个面板

**模型配置：**
```
Form.Item[LLM 类型] → Input
Form.Item[API Key]  → Input.Password
Form.Item[Model]    → Input
Form.Item[Base URL] → Input
Collapse[其他环境变量 (N)] → Form.Item[key] → Input
```

**Gateway 配置：**
```
Card[Feishu]  → status badge + Form.Items
```

**运行诊断：**
```
Card[Sidecar] + Card[Agent] + Card[Gateway]
```
使用 `Descriptions` 组件展示键值信息。

---

## 4. 影响范围

### 修改
- `apps/desktop/ui/src/App.tsx`：
  - 删除 `FieldInput` 函数组件
  - `renderModelConfig` 使用 `Form` + `Input` + `Collapse`
  - `renderGatewayConfig` 使用 `Card` + `Form`
  - `renderDiagnosticsPanel` 使用 `Card` + `Descriptions`
  - Modal 用 Ant Design 默认样式，减少 inline styles

- `apps/desktop/ui/src/style.css`：
  - 删除透明覆盖（`header/body/footer { transparent }`）
  - 精简 Modal CSS 到最少（圆角 + 边框 + 输入框底色）
  - 删除 `.settings-section`、`.form-grid` 等不再需要的自定义类

### 新增依赖
- `antd` 中的 `Form`、`Input`、`Card`、`Collapse`、`Descriptions`（部分可能已导入）
