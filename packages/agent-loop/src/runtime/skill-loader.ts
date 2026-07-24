import type { ToolRegistration } from '../core/tool-registry.js';

// ── SkillManifest ──
export interface SkillManifest {
  name: string;
  description: string;
  version?: string;
}

// ── Skill ──
export interface Skill {
  manifest: SkillManifest;
  content: string;
  frontmatter: Record<string, unknown>;
  tools?: ToolRegistration[];
  systemPromptOverrides?: string;
}

// ── SkillLoader ──
export class SkillLoader {
  private skillsDir?: string;
  private cache: Map<string, Skill> = new Map();

  constructor(skillsDir?: string) {
    this.skillsDir = skillsDir;
  }

  /** 模拟扫描（测试用 / 实际暂用内存注册） */
  async scan(): Promise<SkillManifest[]> {
    return Array.from(this.cache.values()).map(s => s.manifest);
  }

  /** 注册一个技能（内存方式） */
  register(skill: Skill): void {
    this.cache.set(skill.manifest.name, skill);
  }

  /** 加载技能 */
  async load(name: string): Promise<Skill | null> {
    return this.cache.get(name) ?? null;
  }

  /** 生成给 system prompt 用的技能目录文本 */
  renderCatalog(): string {
    const skills = Array.from(this.cache.values());
    if (skills.length === 0) return '';
    return skills
      .map(s => `- ${s.manifest.name}: ${s.manifest.description}`)
      .join('\n');
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}
