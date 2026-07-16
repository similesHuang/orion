import type { FieldSpec, GatewayUiSpec } from './types'

export const STORAGE_KEY = 'orion-desktop-ui-state-v6'
export const SSE_INACTIVITY_MS = 300_000
export const MAX_BUFFER_LEN = 500_000

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
  { scope: 'env', key: 'ORION_TOOL_APPROVAL', label: '工具执行审批', placeholder: 'true / false', hint: '开启后执行命令、写入/修改文件前会等待你确认（默认开启）' },
  { scope: 'env', key: 'ORION_ALLOW_SHELL', label: '允许 Shell 命令', placeholder: 'false', hint: '允许 agent 执行任意 bash/shell 命令。风险较高，默认关闭；建议同时开启工具执行审批' },
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
]
