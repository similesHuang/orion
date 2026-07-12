# Project + Session 管理与工作目录设计文档

## 背景与问题

当前 Orion Desktop：

- 左侧只有**扁平会话列表**，没有项目概念。
- 代码运行工具 `code_run` 固定使用 `projectRoot/temp` 作为工作目录。
- 用户无法为单个会话指定工作目录，也无法直观看到某个会话关联到哪个本地项目。

期望：

- 左侧显示 **Project 列表**，每个 Project 下可展开多个会话。
- 未绑定 Project 的会话单独放在“独立会话”一栏。
- 输入框下方可**添加 Project 目录**；若目录是 Git 仓库，显示当前分支。
- 绑定 Project 后，`code_run` 默认在该 Project 目录下执行。
- 整体聊天 UI 使用 **Ant Design X** 组件库渲染。

## 目标

1. 引入 `Project` 实体：id、名称、本地路径、git 分支。
2. 会话 (`ChatSession`) 可选绑定到一个 `Project`。
3. 左侧边栏分两级：Project 列表（可展开会话）+ 独立会话列表。
4. 输入框下方显示当前会话绑定的 Project，未绑定时显示“添加 Project 目录”。
5. `code_run`、`fileRead`、`fileWrite`、`filePatch` 的相对路径以 Project 路径为基准。
6. 聊天界面使用 Ant Design X 的 `Sender`、`Bubble.List` 等组件替代当前自定义实现。
7. 路径选择允许任意本地目录；`code_run` 等工具在该目录下执行，仅校验目录存在。

## 非目标

- 不改造为多 Agent 常驻架构。
- 不需要 LLM 主动执行 `/cd` 类命令。
- 不要求 Ant Design X 替换所有 UI（先从聊天主界面开始）。

## 数据模型变更

### Project

`apps/desktop/ui/src/types.ts`

```ts
export interface Project {
  id: string
  name: string           // 目录名，例如 "orion"
  path: string           // 绝对路径，例如 "D:\\AI领域\\orion"
  gitBranch: string | null
  updatedAt: number
}
```

### ChatSession

```ts
export interface ChatSession {
  id: string
  title: string
  messages: UiMessage[]
  draft: string
  updatedAt: number
  backendState: BackendSnapshot | null
  projectId: string | null   // 新增：绑定到 Project
}
```

### UiState

```ts
export interface UiState {
  projects: Project[]
  sessions: ChatSession[]
  activeSessionId: string | null
  expandedProjectIds: string[]   // 左侧哪些 Project 已展开
}
```

## UI 设计方案

### 组件库选择

使用 `@ant-design/x`：

- `Sender`：底部输入框，支持自定义头部/脚部。
- `Bubble.List`：消息列表，支持流式输出、自定义渲染。
- `Prompts`：欢迎页快捷提示（可选）。
- `Conversations`：左侧会话/项目列表（也可用普通 Ant Design `Menu` / `Tree`）。

先安装依赖：

```bash
pnpm --filter @orion/desktop-ui add @ant-design/x antd
```

### 左侧边栏布局

```
┌─────────────────────────────────────────────────────────────┐
│ [+] 新会话                                                    │
├─────────────────────────────────────────────────────────────┤
│ 📁 Projects                                                   │
│   ▼ orion                main                               │
│     ├── 会话 A                                               │
│     └── 会话 B                                               │
│   ▶ my-web-app         feature/x                            │
├─────────────────────────────────────────────────────────────┤
│ 💬 独立会话                                                   │
│   ├── 未绑定会话 1                                            │
│   └── 未绑定会话 2                                            │
└─────────────────────────────────────────────────────────────┘
```

- 每个 Project 项显示：目录名 + git 分支徽章。
- 点击 Project 名称：展开/收起会话。
- 点击 Project 下的会话：切换当前会话。
- 独立会话：所有 `projectId === null` 的会话。

### 主界面 / 输入框区域

```
┌────────────────────────────────────────────┐
│  [消息列表：Bubble.List]                    │
│                                            │
├────────────────────────────────────────────┤
│  ┌──────────────────────────────────────┐  │
│  │ [Sender 输入框]                       │  │
│  └──────────────────────────────────────┘  │
│  [绑定 Project: D:\AI领域\orion  main] [x] │
│  [未绑定 Project：+ 添加 Project 目录]       │
└────────────────────────────────────────────┘
```

- 当前会话已绑定 Project：显示 Project 名 + 分支 + 清除按钮。
- 当前会话未绑定：显示“+ 添加 Project 目录”。
- 点击后调用 Tauri dialog 选择目录。

### 创建 Project 流程

1. 用户点击“+ 添加 Project 目录”。
2. `open({ directory: true })` 选择目录。
3. 校验路径存在且为目录。
4. 创建 `Project` 实体，绑定到当前会话。
5. 调用后端获取 git 分支。
6. 保存到 `localStorage`。

### 创建新会话

- 点击“新会话”：`createSession()` 生成 `projectId: null` 的会话。
- **不自动弹出目录选择器**。
- 用户可在输入框下方手动绑定 Project。
- 未来可扩展：右键 Project → “在该 Project 下新建会话”。

## Git 分支获取

### 方案 A：Tauri Rust 命令（推荐）

新增命令：

```rust
#[command]
fn get_git_branch(path: String) -> Result<Option<String>, String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .current_dir(&path)
        .output()
        .map_err(|e| e.to_string())?;
    if output.status.success() {
        Ok(Some(String::from_utf8_lossy(&output.stdout).trim().to_string()))
    } else {
        Ok(None)
    }
}
```

前端调用：

```ts
const branch = await invoke<string | null>('get_git_branch', { path: project.path })
```

### 方案 B：Sidecar 接口

在 `/api/diagnostics` 或新增 `/api/project-info` 里返回分支。需要多一次 HTTP 调用，不如 Rust 命令直接。

选择 **方案 A**。

## 后端（Sidecar）工作目录切换

基本思路不变：单 Agent，每次 `/chat` 请求前按会话 Project 路径重建 Agent。

### API 变更

`/chat` 新增 `cwd` 参数：

```
GET /chat?q=...&cwd=D%3A%5CAI%E9%A2%86%E5%9F%9F%5Corion
```

- `cwd` 为会话绑定的 Project 路径。
- 未提供时使用默认 `projectRoot/temp`。

### 安全校验

```ts
function resolveWorkingDir(raw: string | null): string {
  if (!raw) return path.join(PROJECT_ROOT, 'temp')
  const resolved = path.resolve(raw)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`工作目录不存在或不是目录: ${raw}`)
  }
  return resolved
}
```

### Agent cwd 透传

`packages/agent/src/index.ts`：

```ts
export interface GenericAgentOptions {
  cwd?: string
}

export class GenericAgent {
  cwd: string
  constructor(options?: GenericAgentOptions) {
    this.sessions = loadSessionsFresh()
    this.cwd = options?.cwd ?? path.join(projectRoot, 'temp')
    this.client = createClient(this.sessions, this.llmNo, this.cwd)
    // ...
  }
}
```

`packages/llm/src/index.ts`：

```ts
export function createClient(
  sessions: BaseSession[],
  index = 0,
  cwd?: string
): NativeToolClient {
  const backend = sessions[index % sessions.length]
  const handlerCwd = cwd ?? path.join(projectRoot, 'temp')
  return new NativeToolClient(backend, handlerCwd)
}
```

### 请求级切换流程

```ts
// chat-sidecar.ts
const rawCwd = url.searchParams.get('cwd')
const targetCwd = resolveWorkingDir(rawCwd)
const snapshot = exportSnapshot(agent)
rebuildAgent(snapshot, { cwd: targetCwd })

try {
  await withTimelineRuntime(runtime, async () => {
    if (q.startsWith('/')) {
      await frontend.handleCommand(requestId, q)
    } else {
      const prompt = buildPrompt(q)
      const queue = current.putTask(prompt, 'desktop')
      // ...
    }
  })
} finally {
  rebuildAgent(snapshot)
}
```

> 当前 Sidecar 请求是串行的（`activeRequests` + `stopActiveTasks`），所以请求前后重建是安全的。若未来并发，需要改为请求级 Agent 实例。

## 工具层影响

`packages/agent/src/handler-base.ts` 中：

```ts
const rawPath = path.join(this.cwd, String(args.cwd || './'));
const cwd = path.normalize(path.resolve(rawPath));
```

当 `this.cwd` 是 Project 路径时，`args.cwd` 默认 `./` 即在 Project 目录执行。`fileRead` / `fileWrite` / `filePatch` 的相对路径也会以 Project 路径为基准。

## 边界情况

| 场景 | 行为 |
|------|------|
| 会话未绑定 Project | 显示“+ 添加 Project 目录”，后端使用 `projectRoot/temp` |
| 绑定 Project 但该目录被删除 | 下次请求时 Sidecar 报错 400；UI 可标记为失效 |
| Project 不是 Git 仓库 | `gitBranch` 为 `null`，不显示分支徽章 |
| 切换会话 | 输入框下方动态显示对应 Project / 未绑定状态 |
| 删除 Project | 关联会话变成独立会话（`projectId` 设为 `null`） |
| 导出 backend snapshot | `projectId` 不进 snapshot，仅存在 UI localStorage |

## 实现顺序建议

### 阶段 1：数据模型 + 基础 UI

1. `types.ts` 增加 `Project` 和 `projectId`。
2. `store.ts` 增加 `projects`、`expandedProjectIds`、相关 actions。
3. `utils.ts` 增加 `createProject()`、`getGitBranch()`（ invoke 命令）。
4. 安装 `@ant-design/x` 和 `antd`。

### 阶段 2：左侧边栏

1. 用 `Conversations` 或 `Tree` 组件实现 Project + 独立会话两层列表。
2. 显示 git 分支徽章。
3. 展开/收起、切换会话。

### 阶段 3：聊天主界面（Ant Design X）

1. 用 `Bubble.List` 替换现有消息列表。
2. 用 `Sender` 替换现有输入框。
3. 在 `Sender` 脚部插槽里显示 Project 绑定条。

### 阶段 4：后端 cwd 切换

1. `GenericAgent` / `createClient` / `NativeToolClient` 支持 `cwd`。
2. `/chat` 接收 `cwd` 参数。
3. `resolveWorkingDir` 安全校验。
4. 请求前后重建 Agent。

### 阶段 5： polish

1. 空状态、loading、错误提示。
2. 右键菜单：Project 下新建会话、删除 Project、取消绑定。
3. 测试 `code_run` 在 Project 目录下执行。

## 依赖变更

`apps/desktop/ui/package.json`：

```json
{
  "dependencies": {
    "@ant-design/x": "^1.0.0",
    "antd": "^5.x"
  }
}
```

> 版本号以安装时实际为准。

## 待决定事项

- Project 路径是否必须限制在 `PROJECT_ROOT` 下？**不限制**，允许任意本地目录。
- 是否允许一个会话切换 Project？**允许**：清除后重新绑定。
- Project 名是否允许用户自定义？**第一阶段用目录名**，后续可加编辑。
- 是否需要在 Project 变更时主动刷新 git 分支？**进入 UI 或切换会话时刷新一次**即可。

## 相关文件

- `apps/desktop/ui/src/types.ts`
- `apps/desktop/ui/src/store.ts`
- `apps/desktop/ui/src/utils.ts`
- `apps/desktop/ui/src/App.tsx`
- `apps/desktop/ui/package.json`
- `apps/desktop/src-tauri/src/lib.rs`
- `apps/desktop/sidecar/chat-sidecar.ts`
- `packages/agent/src/index.ts`
- `packages/agent/src/handler-base.ts`
- `packages/llm/src/index.ts`
- `packages/tools/src/handler.ts`
