// tests/runtime/test-skill-loader.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SkillLoader } from '../../dist/runtime/skill-loader.js';

describe('SkillLoader', () => {
  it('should register and load a skill', async () => {
    const loader = new SkillLoader();
    loader.register({
      manifest: { name: 'frontend-design', description: 'Design beautiful UIs' },
      content: '## Skill Content\nDo great design.',
      frontmatter: {},
    });
    const skill = await loader.load('frontend-design');
    assert.ok(skill);
    assert.equal(skill.manifest.name, 'frontend-design');
  });

  it('should return null for unknown skill', async () => {
    const loader = new SkillLoader();
    const skill = await loader.load('nonexistent');
    assert.equal(skill, null);
  });

  it('should render catalog', () => {
    const loader = new SkillLoader();
    loader.register({ manifest: { name: 'a', description: 'Skill A' }, content: '', frontmatter: {} });
    loader.register({ manifest: { name: 'b', description: 'Skill B' }, content: '', frontmatter: {} });
    const catalog = loader.renderCatalog();
    assert.ok(catalog.includes('Skill A'));
    assert.ok(catalog.includes('Skill B'));
  });

  it('should scan all registered skills', async () => {
    const loader = new SkillLoader();
    loader.register({ manifest: { name: 'x', description: 'X' }, content: '', frontmatter: {} });
    const manifests = await loader.scan();
    assert.equal(manifests.length, 1);
    assert.equal(manifests[0].name, 'x');
  });
});
