import type { AgentEvent } from '../core/message.js';

export class CliConsumer {
  private prompt: string;

  constructor(prompt = 'agent >> ') {
    this.prompt = prompt;
  }

  /** 消费 AgentEvent 流，输出到终端 */
  async consume(eventIter: AsyncIterable<AgentEvent>): Promise<string> {
    let finalResult = '';

    for await (const event of eventIter) {
      switch (event.kind) {
        case 'text':
          process.stdout.write(event.content);
          break;

        case 'thinking':
          // 灰色显示思考过程
          process.stdout.write(`\x1b[90m${event.content}\x1b[0m`);
          break;

        case 'tool_call':
          process.stdout.write(`\n\x1b[36m> ${event.name}\x1b[0m\n`);
          break;

        case 'tool_result': {
          const color = event.status === 'error' ? '\x1b[31m' : '\x1b[32m';
          const content = typeof event.content === 'string'
            ? event.content
            : JSON.stringify(event.content, null, 2);
          const truncated = content.length > 500
            ? content.slice(0, 500) + '\n... (truncated)'
            : content;
          process.stdout.write(`${color}${truncated}\x1b[0m\n`);
          break;
        }

        case 'error':
          process.stderr.write(`\x1b[31m[${event.severity}] ${event.message}\x1b[0m\n`);
          break;

        case 'done':
          finalResult = event.result;
          process.stdout.write(`\n\x1b[32m${event.result}\x1b[0m\n`);
          break;
      }
    }

    process.stdout.write(`\n${this.prompt}`);
    return finalResult;
  }
}
