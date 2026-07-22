/** Vision API template — ask a vision model about an image.
 *  Ported from GenericAgent/memory/vision_api.template.py
 */
import fs from 'fs';
import { loadEnvFile, loadMykey } from '../shared/index.js';

const MODELSCOPE_API_BASE = 'https://api-inference.modelscope.cn';
const MODELSCOPE_MODEL = 'Qwen/Qwen3-VL-235B-A22B-Instruct';

interface ApiConfig {
  apibase: string;
  apikey: string;
  model: string;
  proxy?: string;
}

function findApiConfig(): Record<string, unknown> {
  const env = loadEnvFile();
  if (env.LLM_APIKEY && env.LLM_APIBASE && env.LLM_MODEL) {
    return {
      apikey: env.LLM_APIKEY,
      apibase: env.LLM_APIBASE,
      model: env.LLM_MODEL,
      proxy: env.LLM_PROXY,
    };
  }
  return loadMykey();
}

function pickConfig(keys: Record<string, unknown>, backend: string): ApiConfig | null {
  if (keys.apikey && keys.apibase && keys.model) {
    return {
      apibase: String(keys.apibase),
      apikey: String(keys.apikey),
      model: String(keys.model),
      proxy: keys.proxy as string | undefined,
    };
  }
  const name =
    backend === 'claude'
      ? Object.keys(keys).find((k) => /claude/i.test(k) && /config/i.test(k))
      : backend === 'openai'
      ? Object.keys(keys).find((k) => /oai|openai/i.test(k) && /config/i.test(k))
      : undefined;
  if (!name) return null;
  const cfg = keys[name] as Record<string, unknown>;
  return {
    apibase: String(cfg.apibase || ''),
    apikey: String(cfg.apikey || ''),
    model: String(cfg.model || ''),
    proxy: cfg.proxy as string | undefined,
  };
}

function mediaTypeForPath(imagePath: string): string {
  const ext = imagePath.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return map[ext || ''] || 'image/jpeg';
}

function prepareImage(imagePath: string): { b64: string; mediaType: string } {
  const buf = fs.readFileSync(imagePath);
  return { b64: buf.toString('base64'), mediaType: mediaTypeForPath(imagePath) };
}

async function callClaude(b64: string, mediaType: string, prompt: string, cfg: ApiConfig, timeoutSec = 60): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const resp = await fetch(`${cfg.apibase.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': cfg.apikey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: mediaType, data: b64 } },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { content?: Array<{ type?: string; text?: string }> };
    return data.content?.[0]?.text || '';
  } finally {
    clearTimeout(t);
  }
}

async function callOpenAICompat(
  b64: string,
  mediaType: string,
  prompt: string,
  cfg: ApiConfig,
  timeoutSec = 60
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutSec * 1000);
  try {
    const resp = await fetch(`${cfg.apibase.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apikey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${b64}` } },
            ],
          },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`OpenAI-compat API ${resp.status}: ${await resp.text()}`);
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(t);
  }
}

export async function askVision(
  imageInput: string,
  prompt = '详细描述这张图片的内容',
  timeoutSec = 60,
  _maxPixels = 1440000,
  backend: 'claude' | 'openai' | 'modelscope' = 'claude'
): Promise<string> {
  let image: { b64: string; mediaType: string };
  try {
    image = prepareImage(imageInput);
  } catch (e) {
    return `Error: 图片处理失败 - ${e instanceof Error ? e.message : String(e)}`;
  }
  const keys = findApiConfig();
  try {
    if (backend === 'claude') {
      const cfg = pickConfig(keys, 'claude');
      if (!cfg) return "Error: 未找到 .env 或 mykey.json 中的 Claude 配置";
      return await callClaude(image.b64, image.mediaType, prompt, cfg, timeoutSec);
    }
    if (backend === 'openai') {
      const cfg = pickConfig(keys, 'openai');
      if (!cfg) return "Error: 未找到 .env 或 mykey.json 中的 OpenAI 配置";
      return await callOpenAICompat(image.b64, image.mediaType, prompt, cfg, timeoutSec);
    }
    const modelscopeKey = process.env.MODELSCOPE_API_KEY || '';
    return await callOpenAICompat(image.b64, image.mediaType, prompt, { apibase: MODELSCOPE_API_BASE, apikey: modelscopeKey, model: MODELSCOPE_MODEL }, timeoutSec);
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') return `Error: 请求超时 (>${timeoutSec}s)`;
    return `Error: API请求失败 - ${e instanceof Error ? e.message : String(e)}`;
  }
}
