# Orion 双皮肤系统 — GitHub Dark / 暖白昼

> 版本：v0.1
> 日期：2026-07-22
> 状态：草稿

---

## 1. 目标

为 Orion 桌面端实现两套完整 UI 皮肤，用户在设置菜单中一键切换，切换后立即生效并持久化。

## 2. 方案

### 2.1 实现方式

使用 CSS 自定义属性（变量）控制所有颜色值，通过切换根元素的类名（`.theme-dark` / `.theme-light`）来整体切换。Ant Design 主题同步切换 `darkAlgorithm` / `defaultAlgorithm`。

```
:root,
.theme-dark {
  --bg: #0d1117;
  --surface: #161b22;
  ...
}

.theme-light {
  --bg: #f5f0eb;
  --surface: #ffffff;
  ...
}
```

### 2.2 配色方案

| Token | GitHub Dark | 暖白昼 |
|-------|-------------|--------|
| 背景 `--bg` | `#0d1117` | `#f5f0eb` |
| 卡片 `--surface` | `#161b22` | `#ffffff` |
| 输入框 `--input-bg` | `#0d1117` | `#f0ebe5` |
| 边框 `--border` | `#30363d` | `rgba(0,0,0,0.06)` |
| 主文字 `--text` | `#e6edf3` | `rgba(0,0,0,0.85)` |
| 次要文字 `--text-muted` | `#8d96a0` | `rgba(0,0,0,0.4)` |
| 强调色 `--accent` | `#58a6ff` | `#0891b2` |
| 成功 `--success` | `#3fb950` | `#059669` |
| 危险 `--danger` | `#f85149` | `#dc2626` |
| 消息用户 `--msg-user` | `rgba(56,139,253,0.08)` | `rgba(99,102,241,0.06)` |
| 消息 AI `--msg-ai` | `#161b22` | `#ffffff` |
| 代码块背景 | `#0d1117` | `#f0ebe5` |

### 2.3 设置菜单

在设置菜单（弹窗）中，第三项改为：
```
🎨 切换皮肤
  ├── 🌙 GitHub Dark
  └── ☀️ 暖白昼
```

当前选中的皮肤显示 ✅ 标记。

### 2.4 持久化

- 选择存入 `localStorage`，key: `orion-theme`
- App 启动时读取，默认 GitHub Dark
- 切换后立即生效，不重启

### 2.5 CSS 策略

将现有 style.css 中的所有硬编码颜色值替换为 CSS 变量：
- `rgba(255,255,255,0.85)` → `var(--text)`
- `#1c1d21` → `var(--surface)`
- `#4fd1c5` → `var(--accent)`
- 以此类推

`.theme-light` 类下覆盖变量值实现日间模式。

---

## 3. 影响范围

### 修改
- `apps/desktop/ui/src/style.css` — 全部颜色值替换为 CSS 变量，新增 `.theme-light` 变量覆盖
- `apps/desktop/ui/src/App.tsx` — 读取 `orion-theme` 存 state，传给 ConfigProvider 的 algorithm，加到根元素 class
- `apps/desktop/ui/src/components/SettingsMenu.tsx` — 新增「🎨 切换皮肤」菜单项

### 无变化
- 组件逻辑、布局、间距均不变
- 后端完全不受影响
- Modal / Input / Card 等 Ant Design 组件颜色由 algorithm 控制，不涉及 CSS 变量
