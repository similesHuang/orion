/**
 * DeepSeek Agent Loop Demo
 *
 * 演示如何使用 @orion/agent-loop 的 CliConsumer + AgentLoop。
 *
 * 使用方式：
 *   1. 设置环境变量 DEEPSEEK_API_KEY
 *   2. npx tsx tests/demo-cli.ts
 *
 * 也可以直接在命令行传 key：
 *   npx tsx tests/demo-cli.ts sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
 *
 * DeepSeek API 兼容 OpenAI 格式，所以直接用 fetch 调用流式接口。
 */

// ── 使用项目源文件（不走 dist 编译）──
// 直接 import 源文件，依赖 tsx 的 TypeScript 运行时支持
import { AgentLoop } from '../src/core/agent-loop.js';
import type { AgentLoopOptions } from '../src/core/agent-loop.js';
import type { LLMProvider, LLMEvent, ChatOptions } from '../src/core/llm-provider.js';
import type { Message, ToolDef } from '../src/core/message.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { CliConsumer } from '../src/cli/cli-consumer.js';

// ── 配置 ──
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const DEEPSEEK_MODEL = 'deepseek-v4-flash';
const SYSTEM_PROMPT = '你是一个有帮助的 AI 助手。请用中文回答。';
const MAX_TURNS = 10;

// ── DeepSeek Provider（OpenAI 兼容接口）──
class DeepSeekProvider implements LLMProvider {
  readonly modelId: string = DEEPSEEK_MODEL;

  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string, baseUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? DEEPSEEK_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * 将内部 Message 格式转换为 OpenAI API 的 message 格式
   */
  private toOpenAIMessages(messages: readonly Message[]): unknown[] {
    const out: unknown[] = [];
    // 在遍历中累积 tool_use_id → tool name 的映射
    // （DeepSeek 的 tool role 消息需要 name 字段）
    const toolNameMap = new Map<string, string>();

    for (const msg of messages) {
      // ── 纯文本消息 ──
      if (typeof msg.content === 'string') {
        out.push({ role: msg.role, content: msg.content });
        continue;
      }

      // content 是 ContentBlock[]
      const textBlocks = msg.content.filter(b => b.type === 'text');
      const toolUseBlocks = msg.content.filter((b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
        b.type === 'tool_use'
      );
      const toolResultBlocks = msg.content.filter((b): b is { type: 'tool_result'; tool_use_id: string; content: unknown } =>
        b.type === 'tool_result'
      );

      // ── 记录 tool name 映射（assistant 消息中的 tool_use）──
      for (const tu of toolUseBlocks) {
        toolNameMap.set(tu.id, tu.name);
      }

      // ── tool_result 块 → 转换为 tool role 消息 ──
      if (toolResultBlocks.length > 0) {
        for (const tr of toolResultBlocks) {
          out.push({
            role: 'tool',
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content),
            name: toolNameMap.get(tr.tool_use_id) ?? '',
          });
        }
        // 跳过以下逻辑，因为 tool_result 块已经处理完了
        continue;
      }

      // ── tool_use 块 → assistant 消息携带 tool_calls ──
      if (toolUseBlocks.length > 0) {
        const toolCalls = toolUseBlocks.map(tu => ({
          id: tu.id,
          type: 'function' as const,
          function: {
            name: tu.name,
            arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input),
          },
        }));
        out.push({
          role: 'assistant',
          content: textBlocks.map(b => (b as { text: string }).text).join('') || null,
          tool_calls: toolCalls,
        });
        continue;
      }

      // ── 纯内容块（无 tool_use 也非 tool_result）──
      out.push({
        role: msg.role,
        content: textBlocks.map(b => (b as { text: string }).text).join(''),
      });
    }

    return out;
  }

  /**
   * 将 OpenAI 的 tool_call 格式转成 SDK 内部格式
   */
  private toInternalToolCalls(tcList: unknown[]): Array<{ id: string; function: { name: string; arguments: string } }> {
    if (!Array.isArray(tcList)) return [];
    return tcList.map(tc => {
      const t = tc as { id: string; function: { name: string; arguments: string } };
      return { id: t.id, function: { name: t.function.name, arguments: t.function.arguments } };
    });
  }

  /**
   * 解析 SSE 流中的单行 data 块
   */
  private parseSSELine(line: string): { done: boolean; data: unknown } | null {
    if (!line.startsWith('data: ')) return null;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') return { done: true, data: null };
    try {
      return { done: false, data: JSON.parse(payload) };
    } catch {
      return null;
    }
  }

  /**
   * 核心方法：流式对话
   */
  async *chat(
    messages: readonly Message[],
    tools?: readonly ToolDef[],
    options?: ChatOptions,
  ): AsyncGenerator<LLMEvent> {
    const body: Record<string, unknown> = {
      model: this.modelId,
      messages: this.toOpenAIMessages(messages),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (tools && tools.length > 0) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema,
        },
      }));
    }

    if (options?.maxTokens) body.max_tokens = options.maxTokens;

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => 'Unknown error');
      throw new Error(`DeepSeek API error ${response.status}: ${errText}`);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('Response body is null');

    const decoder = new TextDecoder();
    let buffer = '';
    let collectedContent = '';
    // 按 index 累积流式 tool_calls
    const toolCallAcc: Map<number, {
      id: string;
      function: { name: string; arguments: string };
    }> = new Map();
    let usage: { input: number; output: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const parsed = this.parseSSELine(line);
          if (!parsed) continue;
          if (parsed.done) break;

          const chunk = parsed.data as {
            choices?: Array<{
              delta?: {
                content?: string;
                reasoning_content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  type?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number };
          };

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) {
            if (chunk.usage) {
              usage = { input: chunk.usage.prompt_tokens, output: chunk.usage.completion_tokens };
            }
            continue;
          }

          // 普通文本
          if (delta.content) {
            collectedContent += delta.content;
            yield { kind: 'text', delta: delta.content };
          }

          // 思考过程（DeepSeek 的 reasoning_content）
          if (delta.reasoning_content) {
            yield { kind: 'thinking', delta: delta.reasoning_content };
          }

          // 流式 tool_calls — 按 index 合并
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              let acc = toolCallAcc.get(idx);
              if (!acc) {
                acc = { id: tc.id ?? '', function: { name: '', arguments: '' } };
                toolCallAcc.set(idx, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.function.name += tc.function.name;
              if (tc.function?.arguments) acc.function.arguments += tc.function.arguments;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const mergedToolCalls = Array.from(toolCallAcc.values()).filter(tc => tc.id && tc.function.name);

    // 构造最终 response 事件
    yield {
      kind: 'response',
      response: {
        content: collectedContent,
        tool_calls: mergedToolCalls.length > 0 ? mergedToolCalls : [],
        usage,
        stop_reason: 'end_turn',
      },
    };
  }
}

// ── 定义一些示例工具 ──
function createTools(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register({
    name: 'get_weather',
    description: '查询指定城市的天气',
    schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 北京、上海' },
      },
      required: ['city'],
    },
    handler: async ({ city }: Record<string, unknown>) => {
      const weathers: Record<string, string> = {
        '北京': '晴，25°C',
        '上海': '小雨，22°C',
        '深圳': '多云，28°C',
        '杭州': '阴，24°C',
      };
      const c = String(city ?? '');
      const weather = weathers[c] ?? `${c}，20°C，未知`;
      return { success: true, data: `${c}天气：${weather}` };
    },
  });

  registry.register({
    name: 'calculator',
    description: '简单的数学计算',
    schema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，如 1 + 2' },
      },
      required: ['expression'],
    },
    handler: async ({ expression }: Record<string, unknown>) => {
      try {
        const sanitized = String(expression ?? '').replace(/[^0-9+\-*/.() ]/g, '');
        const result = Function(`'use strict'; return (${sanitized})`)();
        return { success: true, data: String(result) };
      } catch {
        return { success: false, data: '计算失败', error: 'Invalid expression' };
      }
    },
  });

  return registry;
}

// ── 入口 ──
async function main() {
  // 读取 API Key：命令行参数 > 环境变量
  const apiKey = process.argv[2] ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.error('❌ 请设置 DEEPSEEK_API_KEY 环境变量，或直接传参:');
    console.error('   npx tsx tests/demo-cli.ts sk-xxxxxxxxxxxxxxxx');
    process.exit(1);
  }

  // 可选 base_url：环境变量 > 默认值
  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE_URL;

  // 构建组件
  const provider = new DeepSeekProvider(apiKey, baseUrl);
  const tools = createTools();
  const consumer = new CliConsumer();

  const options: AgentLoopOptions = {
    llm: provider,
    systemPrompt: SYSTEM_PROMPT,
    tools,
    maxTurns: MAX_TURNS,
    hooks: {
      onTurnStart: (turn) => console.log(`\n\x1b[33m── Turn ${turn} ──\x1b[0m`),
      onTurnEnd: (turn, stats) =>
        console.log(`\n\x1b[2mTurn ${turn} done (${stats.toolCalls} tools, ${stats.errors} errors)\x1b[0m`),
    },
  };

  const loop = new AgentLoop(options);

  // 从用户输入读取第一句 prompt（或默认）
  const prompt = process.argv[3] ?? '你好！请用中文介绍一下你自己。';
  // 如果还需要交互，可以取消注释下面的行
  // const prompt = await askUserInput();

  console.log(`\n\x1b[36m>>> ${prompt}\x1b[0m\n`);

  try {
    const result = await consumer.consume(loop.run(prompt));
    console.log(`\n\x1b[2m=== Final Result ===\x1b[0m\n${result}`);
  } catch (err) {
    console.error('\n❌ Error:', err);
    process.exit(1);
  }
}

// ── 交互式输入（备用）──
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function askUserInput(): Promise<string> {
  const readline = (await import('node:readline')).default;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question('You: ', answer => {
      rl.close();
      resolve(answer || '你好');
    });
  });
}

// ── 启动 ──
main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
