import http from 'http';
import { AgentChatMixin } from './index.js';

export function createWebhookServer(
  frontend: AgentChatMixin,
  port: number,
  responseBody = 'OK'
): http.Server {
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        frontend.handleWebhook(JSON.parse(data) as Record<string, unknown>);
      } catch (e) {
        console.error(`[${frontend.label}] webhook parse error: ${e instanceof Error ? e.message : String(e)}`);
      }
      res.statusCode = 200;
      res.end(responseBody);
    });
  });
  server.listen(port, () => console.log(`[${frontend.label}] webhook listening on ${port}`));
  return server;
}
