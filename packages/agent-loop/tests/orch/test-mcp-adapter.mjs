// tests/orch/test-mcp-adapter.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildMCPToolName, parseMCPToolName, isMCPTool } from '../../dist/orch/mcp-adapter.js';

describe('MCPAdapter', () => {
  it('should build prefixed tool name', () => {
    const name = buildMCPToolName('docs-server', 'search');
    assert.equal(name, 'mcp__docs-server__search');
  });

  it('should sanitize special chars in names', () => {
    const name = buildMCPToolName('my server!', 'find:file');
    assert.equal(name, 'mcp__my_server___find_file');
  });

  it('should parse MCP tool name', () => {
    const parsed = parseMCPToolName('mcp__docs__search');
    assert.ok(parsed);
    assert.equal(parsed.server, 'docs');
    assert.equal(parsed.tool, 'search');
  });

  it('should return null for non-MCP tool', () => {
    assert.equal(parseMCPToolName('bash'), null);
  });

  it('should detect MCP tools', () => {
    assert.ok(isMCPTool('mcp__server__tool'));
    assert.equal(isMCPTool('bash'), false);
  });
});
