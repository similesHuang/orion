import { invoke } from '@tauri-apps/api/core'
import type { BackendSnapshot, DiagnosticsPayload, LlmOption, Project, SettingsPayload } from './types'

export let sidecarPort: number | null = null

export function setSidecarPort(port: number | null): void {
  sidecarPort = port
}

export function baseUrl(): string {
  return sidecarPort ? `http://127.0.0.1:${sidecarPort}` : ''
}

export async function fetchJson<T>(pathName: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseUrl()}${pathName}`, init)
  const text = await response.text()
  let data: ({ error?: string } & T) | null = null
  if (text) {
    try {
      data = JSON.parse(text) as { error?: string } & T
    } catch {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
    }
  }
  if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`)
  return data as T
}

export async function startSidecar(): Promise<number> {
  return invoke<number>('start_chat_sidecar')
}

export async function stopSidecar(): Promise<void> {
  await invoke('stop_chat_sidecar')
}

export async function minimizeWindow(): Promise<void> {
  await invoke('minimize_window')
}

export async function toggleMaximizeWindow(): Promise<boolean> {
  return invoke<boolean>('toggle_maximize_window')
}

export async function closeWindow(): Promise<void> {
  await invoke('close_window')
}

export async function setWindowAlwaysOnTop(alwaysOnTop: boolean): Promise<void> {
  await invoke('set_window_always_on_top', { alwaysOnTop })
}

export async function selectWorkspaceFolder(): Promise<string | null> {
  return invoke<string | null>('select_workspace_folder')
}

export async function getWorkspacePath(): Promise<string | null> {
  return invoke<string | null>('get_workspace_path')
}

export async function setWorkspacePath(path: string): Promise<void> {
  await invoke('set_workspace_path', { path })
}

export async function setWorkspacePathState(path: string): Promise<void> {
  await invoke('set_workspace_path_state', { path })
}

export async function setWorkspacePathRuntime(path: string): Promise<DiagnosticsPayload> {
  return fetchJson<DiagnosticsPayload>('/api/workspace', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  })
}

export async function waitForSidecar(maxAttempts = 80): Promise<boolean> {
  if (!sidecarPort) return false
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await fetch(`${baseUrl()}/api/diagnostics`)
      if (response.ok) return true
    } catch {
      // sidecar may still be starting
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

export async function exportBackendSnapshot(): Promise<BackendSnapshot | null> {
  if (!sidecarPort) return null
  try {
    return await fetchJson<BackendSnapshot>('/api/session/export')
  } catch {
    return null
  }
}

export async function importBackendSnapshot(snapshot: BackendSnapshot | null): Promise<void> {
  if (!sidecarPort) return
  const pathName = snapshot ? '/api/session/import' : '/api/session/reset'
  await fetchJson(pathName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: snapshot ? JSON.stringify(snapshot) : undefined,
  })
}

export async function loadSettings(): Promise<SettingsPayload> {
  return fetchJson<SettingsPayload>('/api/settings')
}

export async function saveSettings(settings: Record<string, unknown>): Promise<SettingsPayload> {
  return fetchJson<SettingsPayload>('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ settings }),
  })
}

export async function loadModels(): Promise<LlmOption[]> {
  return fetchJson<LlmOption[]>('/api/llms')
}

export async function selectLlm(idx: number): Promise<void> {
  await fetchJson(`/api/llm/${idx}`, { method: 'POST' })
}

export async function pingSidecar(): Promise<DiagnosticsPayload> {
  return fetchJson<DiagnosticsPayload>('/api/diagnostics')
}

export async function reinjectPrompt(): Promise<void> {
  await fetchJson('/api/reinject', { method: 'POST' })
}

export async function getProjectInfo(
  path: string
): Promise<{ path: string; isGit: boolean; branch: string | null }> {
  return fetchJson<{ path: string; isGit: boolean; branch: string | null }>(`/api/project-info?path=${encodeURIComponent(path)}`)
}

export async function stopGeneration(): Promise<void> {
  await fetchJson('/api/stop', { method: 'POST' })
}

export async function loadProjectsFromDisk(): Promise<{
  projects: Project[]
  activeProjectId: string | null
}> {
  const raw = await invoke<string>('load_projects')
  const parsed = JSON.parse(raw) as {
    projects?: unknown[]
    activeProjectId?: string | null
  }
  return {
    projects: Array.isArray(parsed.projects)
      ? parsed.projects.map((rawProject) => {
          const project = rawProject as Partial<Project>
          return {
            id: project.id || `project-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: project.name || '未命名项目',
            path: project.path || '',
            gitBranch: project.gitBranch ?? null,
            createdAt: typeof project.createdAt === 'number' ? project.createdAt : Date.now(),
            updatedAt: typeof project.updatedAt === 'number' ? project.updatedAt : Date.now(),
          }
        })
      : [],
    activeProjectId: parsed.activeProjectId ?? null,
  }
}

export async function saveProjectsToDisk(
  projects: Project[],
  activeProjectId: string | null
): Promise<void> {
  await invoke('save_projects', {
    payload: JSON.stringify({ projects, activeProjectId }),
  })
}
