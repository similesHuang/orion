# Orion 桌面端设置面板重设计：Modal + 分类菜单

> 版本：v0.1
> 日期：2026-07-22
> 状态：草稿

---

## 1. 背景

当前设置面板使用 Ant Design Drawer（右侧滑出），所有配置内容堆叠在一个面板中。三级菜单（模型配置 / Gateway 配置 / 运行诊断）已实现，但点击后打开的仍是同一个包含全部内容的面板，没有分类展示。

## 2. 设计目标

1. 点击菜单项后只显示对应的配置内容
2. 用居中 Modal 替代右侧 Drawer，视觉更聚焦
3. Modal 使用实心底色（不透明），避免透视干扰
4. 保持 glassmorphic 整体风格一致性

## 3. 设计

### 3.1 Modal 结构

每个配置项共用同一个 Modal 布局：

```
┌──────────────────────────────────┐
│ 设置                              │
│ 🤖 模型配置                    ✕ │  ← eyebrow + 标题 + 关闭按钮
├──────────────────────────────────┤
│                                  │
│  LLM 类型     [openai         ]  │  ← 表单字段
│  API Key      [••••••••••    ]  │
│  Model        [claude-opus-4  ]  │
│  Base URL     [https://...    ]  │
│                                  │
├──────────────────────────────────┤
│            [取消]    [保存配置]   │  ← 取消关闭，保存写 .env
└──────────────────────────────────┘
```

### 3.2 视觉规格

| 元素 | 值 |
|------|-----|
| Modal 背景 | `#1c1d21` 实心 |
| Modal 圆角 | `14px` |
| Modal 边框 | `1px solid rgba(255,255,255,0.08)` |
| Modal 阴影 | `0 24px 80px rgba(0,0,0,0.6)` |
| 遮罩层 | `rgba(0,0,0,0.55)` 无模糊 |
| 输入框背景 | `#131418` |
| 输入框圆角 | `7px` |
| 输入框边框 | `1px solid rgba(255,255,255,0.06)` |
| Modal 宽度 | `500px` |
| Header 底部 | 分割线 `1px solid rgba(255,255,255,0.06)` |
| Footer 顶部 | 同上 |

### 3.3 三个配置面板

**模型配置：**
- LLM 类型（输入框）
- API Key（密码框）
- Model（输入框）
- Base URL（输入框）
- 其他环境变量（折叠区域，默认收起，包含额外 .env 字段）

**Gateway 配置：**
- 每个 Gateway 卡片显示状态标签（已配置 / 缺少字段）
- 各凭证字段输入框

**运行诊断：**
- Sidecar 状态卡片（PID、端口、Node 版本）
- Agent 状态卡片（就绪状态、当前模型）
- Gateway 状态卡片（运行状态、启停按钮）

### 3.4 交互规则

| 操作 | 行为 |
|------|------|
| 点击菜单项 | 关闭 popover，打开对应 Modal |
| 点击 ✕ | 关闭 Modal |
| 点击取消 | 关闭 Modal，不保存 |
| 点击背景遮罩 | 关闭 Modal |
| 点击保存 | 写 .env / mykey → 重建 agent → 关闭 Modal → 刷新诊断 |
| 键盘 Escape | 关闭 Modal |

### 3.5 状态管理

新增 `settingsSection` state 记录当前选中的配置类型：
- `'model'` — 模型配置
- `'gateway'` — Gateway 配置
- `'diagnostics'` — 运行诊断

`handleSettingsMenuSelect(section)` 设置 section 并打开 Modal。

---

## 4. 影响范围

### 新增
- 无新文件 — 基于现有 App.tsx 修改

### 修改
- `apps/desktop/ui/src/App.tsx`：
  - 新增 `settingsSection` state
  - 修改 `handleSettingsMenuSelect` 设置 section
  - 将 Drawer 替换为 Ant Design Modal
  - `renderSettingsBody` 改为根据 section 渲染对应内容
  - 更新 footer 按钮文案和保存回调

### 删除
- 当前 Drawer 相关代码
- `renderSettingsBody` 中的多 section 渲染（改为按需渲染）
- `settings-eyebrow` CSS 类（不再需要）

### CSS 调整
- Modal 背景色、圆角、阴影
- 输入框深色底色
- 取消按钮 hover 效果
