import http from 'http';
import { AgentChatMixin } from './index.js';

export function createWebhookServer(
  frontend: AgentChatMixin,
  port: number,
  responseBody = 'OK',
  host = '127.0.0.1'
): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end('Method Not Allowed');
      return;
    }
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data) as Record<string, unknown>;
        frontend.handleWebhook(parsed, data, req.headers);
      } catch (e) {
        console.error(`[${frontend.label}] webhook error: ${e instanceof Error ? e.message : String(e)}`);
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }
      res.statusCode = 200;
      res.end(responseBody);
    });
  });
  server.listen(port, host, () => console.log(`[${frontend.label}] webhook listening on ${host}:${port}`));
  return server;
}
