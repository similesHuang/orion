import type http from 'node:http'

export function sseEvent(res: http.ServerResponse, eventName: string, data: string): void {
  res.write(`event: ${eventName}\n`)
  res.write(`data: ${data.replace(/\n/g, '\ndata: ')}\n\n`)
}

export function json(res: http.ServerResponse, status: number, data: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers })
  res.end(JSON.stringify(data))
}

function getAllowedOrigin(origin: string | undefined): string | false {
  if (!origin) return false
  // Tauri production window uses tauri://localhost; dev server uses http://127.0.0.1:5173
  if (origin === 'tauri://localhost') return origin
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin
  return false
}

export function corsHeaders(origin: string | undefined): http.OutgoingHttpHeaders {
  const allowed = getAllowedOrigin(origin)
  if (!allowed) return {}
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}
