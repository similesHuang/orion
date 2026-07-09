# Orion

Orion 是一个基于 TypeScript 的本地 Agent 平台，把 LLM 抽象、工具调用、记忆系统、自主运行、桌面端和 IM 网关整合在同一个 `pnpm` monorepo 中。目标不是“只聊天”，而是让模型在本地环境里实际执行任务。

> 注意：仓库目录名可能是 `origin/`，但项目名称与 npm workspace 名称是 `orion`，内部包以 `@orion/*` 命名。

---

## 项目定位

一句话理解 Orion：

> 把大模型接到本地执行环境上的 TypeScript Agent 平台，CLI、桌面端、记忆系统和多通道 IM 接入已经拆成独立模块。

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                        应用层 (apps)                          │
│  ┌──────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ CLI      │  │ Desktop (Tauri)  │  │ IM Gateway       │  │
│  │ @orion/cli│  │ @orion/desktop   │  │ @orion/gateway   │  │
│  └────┬─────┘  └────────┬─────────┘  └────────┬─────────┘  │
└───────┼─────────────────┼─────────────────────┼────────────┘
        │                 │                     │
        └─────────────────┼─────────────────────┘
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                      核心运行时 (packages)                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ @orion/agent │  │ @orion/chat  │  │ @orion/reflect       │  │
│  │ Agent 主循环 │  │ 聊天命令    │  │ 自主/反射/调度       │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │             │
│         ▼                ▼                    ▼             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    @orion/tools                        │  │
│  │  文件读写 / 补丁 / 代码执行 / 网页导航 / JS 注入 / 扫描  │  │
│  └─────────────────────────┬─────────────────────────────┘  │
│                            │                                 │
│         ┌──────────────────┼──────────────────┐             │
│         ▼                  ▼                  ▼             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────────┐   │
│  │ @orion/llm  │   │ @orion/memory│   │ @orion/shared    │   │
│  │ LLM 客户端  │   │ 记忆系统     │   │ 公共工具         │   │
│  └──────┬──────┘   └──────┬──────┘   └─────────────────┘   │
│         │                 │                                  │
│         └─────────────────┼──────────────────┐              │
│                           ▼                  ▼              │
│                  ┌─────────────────┐  ┌─────────────┐       │
│                  │ @orion/types    │  │ @orion/core │       │
│                  │ 共享类型定义    │  │ 聚合导出层   │       │
│                  └─────────────────┘  └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

### 依赖关系

- `@orion/types` 与 `@orion/shared` 是最底层，无内部依赖。
- `@orion/llm`、`@orion/memory`、`@orion/tools` 依赖 `types` / `shared`。
- `@orion/agent` 依赖 `llm`、`tools`、`types`、`shared`。
- `@orion/chat`、`@orion/reflect` 依赖 `agent` 与 `memory`。
- `@orion/core` 重新导出所有包，方便外部一次性引入。
- `apps/cli`、`apps/desktop`、`apps/gateway` 面向最终用户，依赖 `agent` / `chat`。

---

## 目录结构

```text
orion/
├── apps/
│   ├── cli/                    # 命令行入口，直接调用 @orion/agent 的 main()
│   ├── desktop/                # Tauri 桌面应用
│   │   ├── ui/                 # Vite + React 前端（@orion/desktop-ui）
│   │   ├── sidecar/            # Node 辅助脚本（chat-sidecar、desktop-pet）
│   │   └── src-tauri/          # Rust / Tauri 壳层
│   └── gateway/                # IM 网关入口
│       ├── wecom.ts            # 企业微信
│       ├── telegram.ts         # Telegram
│       ├── feishu.ts           # 飞书
│       ├── dingtalk.ts         # 钉钉
│       ├── qq.ts               # QQ
│       ├── discord.ts          # Discord
│       └── wechat.ts           # 微信
├── assets/                     # 系统提示词、工具 schema、模板文件
│   ├── sys_prompt.txt          # 中文系统提示词
│   ├── sys_prompt_en.txt       # 英文系统提示词
│   ├── tools_schema.json       # 工具 schema
│   ├── tools_schema_cn.json    # 中文模型适配 schema
│   └── tmwd_cdp_bridge/        # Chrome DevTools Protocol 浏览器扩展
├── memory/                     # 长期记忆、SOP、运行规则（运行时数据）
├── packages/
│   ├── agent/                  # Agent 主循环、会话管理、任务队列、CLI 入口
│   ├── chat/                   # 聊天前端辅助、网关工具、continue/review 等命令
│   ├── core/                   # 聚合导出层（ umbrella package ）
│   ├── llm/                    # LLM 客户端抽象：OpenAI / Anthropic / Mixin
│   ├── memory/                 # 记忆相关代码
│   │   ├── skill-search/       # 技能索引与搜索
│   │   └── L4_raw_sessions/    # 会话压缩
│   ├── reflect/                # 调度、自主运行、Goal 模式、多 Agent worker
│   ├── shared/                 # 公共工具（项目根目录查找、Python 执行等）
│   ├── tools/                  # 文件/代码/网页工具
│   └── types/                  # 共享类型定义
├── temp/                       # 会话、模型响应、任务文件等临时输出
├── .env.example                # 环境变量配置模板
├── mykey.template.json         # JSON 密钥配置模板
├── pnpm-workspace.yaml         # pnpm workspace 配置
├── tsconfig.base.json          # 公共 TypeScript 配置
└── package.json                # monorepo 根配置
```

---

## 模块说明

| 包名 | 路径 | 职责 |
|------|------|------|
| `@orion/types` | `packages/types` | 共享类型：`Message`、`ToolCall`、`SessionConfig`、`ContentBlock` 等 |
| `@orion/shared` | `packages/shared` | 公共工具：查找项目根目录、运行 Python 脚本等 |
| `@orion/llm` | `packages/llm` | LLM 客户端封装，支持 OpenAI-compatible、Anthropic-native 与 Mixin 自动切换 |
| `@orion/tools` | `packages/tools` | 工具实现：`fileRead`、`fileWrite`、`filePatch`、`codeRun`、`webNavigate`、`webExecuteJs`、`webScan`、`tmwebdriver` |
| `@orion/memory` | `packages/memory` | 记忆与自主任务：`skill-search`、会话压缩、TODO/历史报告管理、视觉/OCR/ADB/UI 检测相关能力 |
| `@orion/agent` | `packages/agent` | Agent 运行时：`GenericAgent`、主循环、任务队列、`/cost` `/next` `/resume` 等 slash 命令 |
| `@orion/chat` | `packages/chat` | 聊天命令与网关辅助：`history-utils`、`gateway-utils`、`review-cmd`、`continue-cmd`、`btw-cmd` |
| `@orion/reflect` | `packages/reflect` | 反射与自主模块：调度器、`autonomous`、`goal-mode`、`agent-team-worker`、`checklist-master` |
| `@orion/core` | `packages/core` | 重新导出上述包，方便统一引用 |
| `@orion/cli` | `apps/cli` | CLI 可执行入口，bin 名为 `orion` |
| `@orion/desktop` | `apps/desktop` | Tauri 桌面应用，前端为 `@orion/desktop-ui` |
| `@orion/gateway` | `apps/gateway` | IM 网关，bin 名为 `ga-gateway` |

---

## 技术栈

- **运行时**：Node.js `>=20`
- **语言**：TypeScript + ESM
- **包管理**：`pnpm` workspace
- **桌面端**：Tauri 2 + Rust + Vite + React 19
- **LLM 协议**：OpenAI Chat Completions / Responses API、Anthropic Messages API
- **网络/工具**：原生 `fetch`、WebSocket（`ws`）、浏览器自动化辅助
- **代码质量**：ESLint 10 + `@typescript-eslint`

---

## 快速开始

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置 LLM

复制环境模板：

```bash
cp .env.example .env
```

填写至少以下参数：

```env
GA_LANG=zh
LLM_TYPE=claude
LLM_NAME=kimi-k2.7
LLM_APIKEY=sk-your-api-key
LLM_APIBASE=https://api.kimi.com/coding/
LLM_MODEL=kimi-k2.7
```

> 也可使用 `mykey.json`：`cp mykey.template.json mykey.json`。
> 配置加载优先级：`.env` > `mykey.json` > `mykey.template.json`。

### 3. 常用命令

```bash
# 构建全部包
pnpm build

# 启动 CLI 交互模式
pnpm dev

# 直接运行 CLI
pnpm cli

# 桌面端开发
pnpm desktop:dev

# 构建桌面端
pnpm desktop:build

# 启动 IM 网关（默认企业微信）
pnpm gateway

# 启动后台规划守护进程
pnpm ultraplan:daemon

# 类型检查
pnpm typecheck

# 代码检查
pnpm lint
```

### 4. CLI 入口参数

`apps/cli/src/main.ts` 支持若干运行时参数：

| 参数 | 说明 |
|------|------|
| `--input "prompt"` | 单次运行后退出 |
| `--func path/to/func.txt` | 读取文件作为 prompt 并输出到 `.out.txt` |
| `--task taskname` | 进入任务目录模式，读取 `temp/<taskname>/input.txt` |
| `--reflect script.ts` | 加载反射脚本并循环执行 |
| `--bg` | 后台运行 |
| `--llm_no N` | 指定使用第 N 个 LLM 会话 |
| `--verbose` | 输出更详细日志 |
| `--no-user-tools` | 禁用 `ask_user`、`start_long_term_update` 工具 |

交互模式下可用 slash 命令：

| 命令 | 说明 |
|------|------|
| `/help` | 显示帮助 |
| `/next` | 切换到下一个 LLM 会话 |
| `/llms` | 列出可用会话 |
| `/cost` | 显示 token 消耗报告 |
| `/resume` | 恢复近期会话 |
| `/session.key=value` | 动态修改后端会话配置 |

---

## 关键入口

| 入口 | 文件 | 说明 |
|------|------|------|
| CLI 启动 | `apps/cli/src/main.ts` | 极薄，调用 `@orion/agent` 的 `main()` |
| Agent 核心 | `packages/agent/src/index.ts` | `GenericAgent`、配置加载、系统提示词、任务队列 |
| Agent 循环 | `packages/agent/src/agent-loop.ts` | `agentRunnerLoop`、工具调用与响应处理 |
| LLM 客户端 | `packages/llm/src/index.ts` | `OpenAISession`、`AnthropicSession`、`MixinSession`、`ToolClient`/`NativeToolClient` |
| 工具导出 | `packages/tools/src/index.ts` | 所有工具能力的统一导出 |
| IM 网关 | `apps/gateway/src/index.ts` | 根据参数加载不同网关（wecom/telegram/feishu/...） |
| 桌面配置 | `apps/desktop/src-tauri/tauri.conf.json` | 产品名 `Orion`，前端 dev 地址 `http://localhost:5173` |

---

## 注意事项

- 这是一个**正在使用的工作目录**，不是全新模板。仓库中已包含 `node_modules/`、各包 `dist/`、`temp/model_responses/` 运行痕迹以及桌面端 `src-tauri/target/` 编译产物。
- `.env` 与 `mykey.json` 包含密钥，不要提交到版本控制。
- `memory/` 与 `temp/` 是运行时数据目录，按需决定是否纳入版本管理。

---

## 后续整理建议

1. 清理不应进仓库的构建产物和运行缓存（`dist/`、`target/`、`temp/`、`node_modules/` 等）。
2. 补充面向最终使用者的“用户手册”，与面向仓库结构的 README 分开。
3. 为 `apps/gateway` 和 `packages/memory` 的各子模块补充更详细的说明文档。
