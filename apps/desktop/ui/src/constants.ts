import type { FieldSpec, GatewayUiSpec } from './types'

export const STORAGE_KEY = 'orion-desktop-ui-state-v4'
export const SSE_INACTIVITY_MS = 90_000
export const MAX_BUFFER_LEN = 500_000
export const MAX_ATTACHMENTS = 20

export const PRIMARY_MODEL_FIELDS: FieldSpec[] = [
  { scope: 'env', key: 'GA_LANG', label: '界面语言', placeholder: 'zh / en' },
  { scope: 'env', key: 'LLM_TYPE', label: 'LLM 类型', placeholder: 'claude / oai / mixin' },
  { scope: 'env', key: 'LLM_NAME', label: '会话名', placeholder: 'kimi-k2.7' },
  { scope: 'env', key: 'LLM_MODEL', label: '模型名', placeholder: 'gpt-5 / kimi-k2.7' },
  { scope: 'env', key: 'LLM_APIBASE', label: 'API Base', placeholder: 'https://api.openai.com/v1' },
  { scope: 'env', key: 'LLM_APIKEY', label: 'API Key', placeholder: 'sk-...', secret: true },
  { scope: 'env', key: 'LLM_MAX_RETRIES', label: '重试次数', placeholder: '3' },
  { scope: 'env', key: 'LLM_CONNECT_TIMEOUT', label: '连接超时', placeholder: '10' },
  { scope: 'env', key: 'LLM_READ_TIMEOUT', label: '读取超时', placeholder: '120' },
  { scope: 'env', key: 'LLM_CONTEXT_WIN', label: '上下文窗口', placeholder: '28000' },
  { scope: 'env', key: 'LLM_STREAM', label: '流式输出', placeholder: 'true / false' },
  { scope: 'env', key: 'LLM_TEMPERATURE', label: '温度', placeholder: '1' },
  { scope: 'env', key: 'LLM_MAX_TOKENS', label: '最大输出 Token', placeholder: '8192' },
]

export const GATEWAY_SPECS: GatewayUiSpec[] = [
  {
    id: 'feishu',
    label: '飞书机器人',
    description: '配置 App 凭证和允许用户，桌面端即可直接管理 gateway 所需字段。',
    fields: [
      { scope: 'mykey', key: 'fs_app_id', label: 'App ID', placeholder: 'cli_...' },
      { scope: 'mykey', key: 'fs_app_secret', label: 'App Secret', placeholder: 'secret', secret: true },
      { scope: 'mykey', key: 'fs_allowed_users', label: '允许用户', placeholder: '每行一个 user_id', multiline: true },
      { scope: 'env', key: 'FEISHU_PORT', label: 'Webhook 端口', placeholder: '8083' },
    ],
  },
  {
    id: 'wecom',
    label: '企微机器人',
    description: '配置 corp id/secret 与允许用户，供 WeCom gateway 使用。',
    fields: [
      { scope: 'mykey', key: 'wecom_bot_id', label: 'Bot ID / Corp ID', placeholder: 'ww...' },
      { scope: 'mykey', key: 'wecom_secret', label: 'Secret', placeholder: 'corp secret', secret: true },
      { scope: 'mykey', key: 'wecom_allowed_users', label: '允许用户', placeholder: '每行一个用户 ID', multiline: true },
      { scope: 'env', key: 'WECOM_PORT', label: 'Webhook 端口', placeholder: '8080' },
    ],
  },
  {
    id: 'telegram',
    label: 'Telegram',
    description: '轮询模式，不需要本地 webhook 端口。',
    fields: [
      { scope: 'mykey', key: 'tg_bot_token', label: 'Bot Token', placeholder: '12345:token', secret: true },
      { scope: 'mykey', key: 'tg_allowed_users', label: '允许用户', placeholder: '每行一个 user id 或 username', multiline: true },
    ],
  },
  {
    id: 'wechat',
    label: '微信',
    description: '配置 token 与允许用户，并设置网关监听端口。',
    fields: [
      { scope: 'mykey', key: 'wx_bot_token', label: 'Bot Token', placeholder: 'token', secret: true },
      { scope: 'mykey', key: 'wx_allowed_users', label: '允许用户', placeholder: '每行一个用户 ID', multiline: true },
      { scope: 'env', key: 'WECHAT_PORT', label: 'Webhook 端口', placeholder: '8082' },
    ],
  },
  {
    id: 'qq',
    label: 'QQ 机器人',
    description: '配置 QQ Bot App 凭证与允许用户。',
    fields: [
      { scope: 'mykey', key: 'qq_app_id', label: 'App ID', placeholder: 'appid' },
      { scope: 'mykey', key: 'qq_app_secret', label: 'App Secret', placeholder: 'secret', secret: true },
      { scope: 'mykey', key: 'qq_allowed_users', label: '允许用户', placeholder: '每行一个用户 ID', multiline: true },
      { scope: 'env', key: 'QQ_PORT', label: 'Webhook 端口', placeholder: '8085' },
    ],
  },
  {
    id: 'dingtalk',
    label: '钉钉机器人',
    description: '配置 client id/secret 与允许用户。',
    fields: [
      { scope: 'mykey', key: 'dingtalk_client_id', label: 'Client ID', placeholder: 'ding...' },
      { scope: 'mykey', key: 'dingtalk_client_secret', label: 'Client Secret', placeholder: 'secret', secret: true },
      { scope: 'mykey', key: 'dingtalk_allowed_users', label: '允许用户', placeholder: '每行一个用户 ID', multiline: true },
      { scope: 'env', key: 'DINGTALK_PORT', label: 'Webhook 端口', placeholder: '8084' },
    ],
  },
  {
    id: 'discord',
    label: 'Discord',
    description: '当前仓库只校验 token，接收侧仍需外部适配器。',
    fields: [
      { scope: 'mykey', key: 'discord_bot_token', label: 'Bot Token', placeholder: 'token', secret: true },
      { scope: 'mykey', key: 'discord_allowed_users', label: '允许用户', placeholder: '每行一个用户 ID 或用户名', multiline: true },
    ],
  },
]
