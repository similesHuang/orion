# Orion 重构设计：单包合并 + 桌面端增强

> 版本：v0.1
> 日期：2026-07-22
> 状态：草稿

---

## 1. 背景与目标

### 1.1 现状

Orion 是一个 TypeScript 本地 Agent 平台，当前采用 pnpm monorepo 结构：

- **packages/** 下 10 个子包：`types`, `shared`, `llm`, `tools`, `memory`, `agent`, `chat`, `reflect`, `core`, `permissions`
- **apps/** 下 3 个入口：`cli`（命令行）、`desktop`（Tauri 桌面端）、`gateway`（IM 网关）
- 多包之间通过 `workspace:*` 协议相互引用，每个包独立 tsconfig + 独立 build

### 1.2 问题

1. **多包过于碎片化** — 10 个包中 `core` 仅为 re-export 层、`permissions` 是空壳，其余 8 个包边界不清晰。跨包需要预编译（composite），构建链路长。
2. **CLI 入口冗余** — 桌面端已有完整交互能力，CLI 的维护成本与使用率不匹配。
3. **桌面端能力不足** — 工具结果展示受限、代码无高亮、不支持文件附件、对话持久化弱、无 gateway 进程管理。
4. **UI 风格平庸** — 现有暗色主题缺少视觉层次，没有品牌辨识度。

### 1.3 目标

1. 删除 `apps/cli`，专注桌面端
2. 合并为单包 `packages/core`，消除多包构建复杂度
3. 增强桌面端能力（附件、语法高亮、工具详情、导出导入、gateway 管理）
4. UI 全面升级为 Glassmorphic 风格

---

## 2. 仓库结构

### 2.1 重构后目录

```
orion/
├── apps/
│   ├── desktop/              # Tauri 桌面应用
│   │   ├── ui/               # React 前端 (Vite)
│   │   ├── sidecar/          # Node 后端 (拆分多文件)
│   │   │   ├── chat-sidecar.ts   # 主入口
│   │   │   ├── agent-manager.ts  # Agent 生命期管理
│   │   │   ├── config.ts         # .env/mykey 读写
│   │   │   ├── router.ts         # API 路由
│   │   │   └── sse.ts            # SSE 工具函数
│   │   └── src-tauri/        # Rust 壳层
│   └── gateway/              # IM 网关（保留）
└── packages/
    └── core/                 # ← 唯一的包
        ├── package.json      # name: "@orion/core"
        ├── tsconfig.json     # 去掉 composite，一次编译
        └── src/
            ├── index.ts      # 统一导出
            ├── types/        # (原 @orion/types)
            ├── shared/       # (原 @orion/shared)
            ├── llm/          # (原 @orion/llm)
            ├── tools/        # (原 @orion/tools)
            ├── memory/       # (原 @orion/memory)
            ├── agent/        # (原 @orion/agent)
            ├── chat/         # (原 @orion/chat)
            └── reflect/      # (原 @orion/reflect)
```

### 2.2 删除项

| 路径 | 原因 |
|------|------|
| `apps/cli/` | CLI 入口不再维护 |
| `packages/permissions/` | 空壳，无实际内容 |
| `packages/core/`（旧） | 仅为 re-export，功能已合并 |

### 2.3 构建变化

- 旧的 `composite: true` + project references 全部移除
- `packages/core` 一次 `tsc` 编译产出所有代码
- apps 的 `package.json` 依赖从 `@orion/agent` / `@orion/chat` 等改为 `@orion/core`
- `pnpm-workspace.yaml` 更新为只包含 `packages/core` 和 `apps/*`

---

## 3. 代码合并

### 3.1 文件搬运

将每个源包的 `src/` 直接搬到 `core/src/<domain>/`，保持文件名和内容不变：

| 源 | 目标 | 说明 |
|----|------|------|
| `packages/types/src/index.ts` | `core/src/types/index.ts` | 类型定义 |
| `packages/shared/src/*` | `core/src/shared/*` | 通用工具、storage、python 运行 |
| `packages/llm/src/*` | `core/src/llm/*` | LLM 客户端、env-config |
| `packages/tools/src/*` | `core/src/tools/*` | 工具处理链 |
| `packages/memory/src/*` | `core/src/memory/*` | 记忆系统（保留 L4_raw_sessions） |
| `packages/agent/src/*` | `core/src/agent/*` | Agent 运行时、loop、ultraplan |
| `packages/chat/src/*` | `core/src/chat/*` | 聊天命令处理 |
| `packages/reflect/src/*` | `core/src/reflect/*` | 自主反射模块 |

### 3.2 依赖合并

将所有 workspace 外部依赖合并到 `packages/core/package.json`：

- `js-yaml`（来自 shared）
- `ws`（来自 tools）
- `langfuse`（来自 core 的插件）
- 移除所有 `workspace:*` 内部依赖

### 3.3 导出策略

`core/src/index.ts` 统一导出，保持与消费方兼容：

```ts
export * from './types/index.js'
export * from './shared/index.js'
export * from './llm/index.js'
export * from './tools/index.js'
export * from './memory/index.js'
export * from './agent/index.js'
export * from './chat/index.js'
export * from './reflect/index.js'
```

---

## 4. 桌面端增强

### 4.1 Sidecar 拆分

当前 `chat-sidecar.ts` 单文件 31KB，拆分为：

| 文件 | 职责 |
|------|------|
| `chat-sidecar.ts` | HTTP 启动、main()、keep-alive |
| `agent-manager.ts` | createAgent、rebuildAgent、snapshot、restore |
| `config.ts` | .env/mykey 读写、parse/serialize、gateway 诊断 |
| `router.ts` | 所有 API 路由处理函数 |
| `sse.ts` | SSE 事件格式化、stream 管理 |

### 4.2 功能增强

| 功能 | 实现方式 |
|------|----------|
| 文件附件 | 拖拽/粘贴文件 → 复制到 `temp/attachments/` → 注入 prompt |
| 语法高亮 | 接入已有的 `shiki.ts`，代码块渲染高亮 |
| 工具结果详细视图 | 点击工具卡片展开完整 stdout/stderr，支持横向滚动 |
| 对话导出/导入 | 侧边栏菜单 -> 导出 JSON / 导入 JSON |
| Gateway 进程管理 | 诊断面板 → 一键启动/停止 feishu gateway 子进程 |

---

## 5. UI 视觉设计

### 5.1 风格定位

Glassmorphic（毛玻璃质感）：

- 背景：深蓝紫渐变 `#0f0f1a` → `#1a1a2e` → `#16213e`
- 卡片：`background: rgba(255,255,255,0.04)` + `backdrop-filter: blur(12px)` + 细边框 `rgba(255,255,255,0.06)`
- 主色：青绿 `#4fd1c5` + 靛蓝 `#6366f1`
- 危险色：`#ef4444`
- 文字：主色 `rgba(255,255,255,0.85)` / 次色 `rgba(255,255,255,0.5)` / 弱色 `rgba(255,255,255,0.3)`

### 5.2 对话界面

- 用户消息：靛蓝半透明底，右对齐，右下圆角 4px
- AI 回复：玻璃白底，左对齐，左上圆角 4px
- 工具调用：玻璃卡片内嵌，左侧图标 + 工具名 + 运行状态动画
- 审批面板：工具调用卡片下方，醒目红/绿操作按钮

### 5.3 顶部状态栏

- Agent 状态指示点（绿/黄/灰）
- 当前模型名
- Token 消耗（↑输入 / ↓输出 / ⚡缓存命中率）

---

## 6. 迁移步骤

| 步骤 | 内容 | 验证方式 |
|------|------|----------|
| 1 | 删除 apps/cli、packages/permissions、旧 packages/core | `git rm -r` |
| 2 | 创建 packages/core/src/{types,shared,llm,tools,memory,agent,chat,reflect} | 目录结构就绪 |
| 3 | 搬运代码、合并 package.json、编写 tsconfig/index.ts | `pnpm install` 通过 |
| 4 | 更新 apps/desktop/sidecar 和 apps/gateway 的 import | 引用编译通过 |
| 5 | 更新 pnpm-workspace.yaml | 构建链路正确 |
| 6 | `pnpm build && pnpm typecheck` | 零错误 |
| 7 | Sidecar 拆分为多文件 | 功能不变 |
| 8 | 桌面功能增强（附件/高亮/工具详情/导出/gateway 管理） | 用户可操作 |
| 9 | UI 玻璃质感改造 | 视觉一致 |

---

## 7. 范围边界

### 本次范围
- 包结构重构、CLI 删除、单包合并
- Sidecar 拆分（纯重构，不改功能）
- 桌面功能增强（新增能力）
- UI 视觉改造（原有组件重新样式化）

### 不在此次范围
- 现有桌面 spec 中描述的 Codex 式任务流/checkpoint/diff 系统（属于下一阶段）
- 新增 LLM 提供商支持
- 跨平台（Windows/Linux）适配
