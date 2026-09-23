import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const pane = read('src/renderer/components/CapabilityPane.tsx');
const en = JSON.parse(read('src/renderer/i18n/locales/en.json'));
const fr = JSON.parse(read('src/renderer/i18n/locales/fr.json'));
const zh = JSON.parse(read('src/renderer/i18n/locales/zh.json'));

describe('capabilities pane', () => {
  it('separates enabled skills from disabled ones', () => {
    expect(pane).toContain('const enabledSkills = skills.filter((skill) => skill.enabled);');
    expect(pane).toContain('const disabledSkills = skills.filter((skill) => !skill.enabled);');
    expect(pane).toContain("t('capabilityPanel.skills.title', { count: enabledSkills.length })");
    expect(pane).toContain("t('capabilityPanel.skills.enabled')");
    expect(pane).toContain("t('capabilityPanel.skills.disabled')");
    expect(pane).toContain("t('capabilityPanel.skillType.' + skill.type)");
  });

  it('shows where the active skills are stored', () => {
    expect(pane).toContain('skillsApi.getStoragePath()');
    expect(pane).toContain('setStoragePath(');
    expect(pane).toContain('title={storagePath}');
  });

  it('surfaces pending skill proposals without opening a second approval path', () => {
    expect(pane).toContain('skillsApi.listProposals()');
    expect(pane).toContain("t('capabilityPanel.proposals.title', { count: proposals.length })");
    expect(pane).toContain("t('capabilityPanel.proposals.hint')");
    expect(pane).not.toContain('approveProposal');
    expect(pane).not.toContain('rejectProposal');
  });

  it('reports MCP server status and tool counts', () => {
    expect(pane).toContain('mcpApi.getServerStatus()');
    expect(pane).toContain("t('capabilityPanel.mcp.status.' + server.status)");
    expect(pane).toContain("t('capabilityPanel.mcp.toolCount', { count: server.toolCount })");
    expect(pane).toContain("t('capabilityPanel.mcp.title', {");
  });

  it('groups the exposed MCP tools by server', () => {
    expect(pane).toContain('const toolGroups = new Map<string, McpTool[]>();');
    expect(pane).toContain('groupedTools.map(([serverName, serverTools]) => (');
    expect(pane).toContain("t('capabilityPanel.mcp.tools')");
  });

  it('polls so the runtime view stays current', () => {
    expect(pane).toContain('const POLL_MS = 5000;');
    expect(pane).toContain('setInterval(');
  });

  it('declares every capability string in all three locales', () => {
    for (const key of ['hint', 'unavailable']) {
      expect(en.capabilityPanel[key], 'en.capabilityPanel.' + key).toBeTruthy();
      expect(fr.capabilityPanel[key], 'fr.capabilityPanel.' + key).toBeTruthy();
      expect(zh.capabilityPanel[key], 'zh.capabilityPanel.' + key).toBeTruthy();
    }
    for (const section of ['skills', 'skillType', 'proposals', 'mcp']) {
      expect(en.capabilityPanel[section], 'en.capabilityPanel.' + section).toBeTruthy();
      expect(fr.capabilityPanel[section], 'fr.capabilityPanel.' + section).toBeTruthy();
      expect(zh.capabilityPanel[section], 'zh.capabilityPanel.' + section).toBeTruthy();
    }
    for (const status of ['connecting', 'connected', 'failed', 'disabled']) {
      expect(en.capabilityPanel.mcp.status[status], 'en mcp status ' + status).toBeTruthy();
      expect(fr.capabilityPanel.mcp.status[status], 'fr mcp status ' + status).toBeTruthy();
      expect(zh.capabilityPanel.mcp.status[status], 'zh mcp status ' + status).toBeTruthy();
    }
    for (const type of ['builtin', 'mcp', 'custom']) {
      expect(en.capabilityPanel.skillType[type], 'en skill type ' + type).toBeTruthy();
      expect(fr.capabilityPanel.skillType[type], 'fr skill type ' + type).toBeTruthy();
      expect(zh.capabilityPanel.skillType[type], 'zh skill type ' + type).toBeTruthy();
    }
    expect(en.controlCenter.tab.capabilities).toBe('Capabilities');
  });
});
