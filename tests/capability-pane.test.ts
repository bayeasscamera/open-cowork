import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const read = (rel: string) => readFileSync(path.resolve(process.cwd(), rel), 'utf8');

const pane = read('src/renderer/components/CapabilityPane.tsx');
const en = JSON.parse(read('src/renderer/i18n/locales/en.json'));
const fr = JSON.parse(read('src/renderer/i18n/locales/fr.json'));
const zh = JSON.parse(read('src/renderer/i18n/locales/zh.json'));

describe('capabilities pane', () => {
  it('reports the skills the loader is given, not the manager listing', () => {
    expect(pane).toContain('skillsApi.getRuntimeView()');
    expect(pane).toContain('runtimeReport?.success ? runtimeReport.view ?? null : null');
    expect(pane).not.toContain('skillsApi.getAll()');
    expect(pane).toContain("t('capabilityPanel.skills.title', { count: runtime?.loaded ?? 0 })");
    expect(pane).toContain("t('capabilityPanel.skills.summary', {");
    expect(pane).toContain('loaded: runtime?.loaded ?? 0,');
    expect(pane).toContain('disabled: runtime?.disabled ?? 0,');
  });

  it('groups skills by the root they came from and marks disabled ones', () => {
    expect(pane).toContain('runtime?.sources.filter((source) => source.skills.length > 0) ?? []');
    expect(pane).toContain("t('capabilityPanel.skills.source.' + source.kind)");
    expect(pane).toContain('title={source.root}');
    expect(pane).toContain("skill.enabled ? '' : 'opacity-60'");
    expect(pane).toContain("t('capabilityPanel.skills.enabled')");
    expect(pane).toContain("t('capabilityPanel.skills.disabled')");
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
    for (const section of ['skills', 'proposals', 'mcp']) {
      expect(en.capabilityPanel[section], 'en.capabilityPanel.' + section).toBeTruthy();
      expect(fr.capabilityPanel[section], 'fr.capabilityPanel.' + section).toBeTruthy();
      expect(zh.capabilityPanel[section], 'zh.capabilityPanel.' + section).toBeTruthy();
    }
    for (const key of ['title', 'hint', 'empty', 'enabled', 'disabled', 'summary']) {
      expect(en.capabilityPanel.skills[key], 'en skills ' + key).toBeTruthy();
      expect(fr.capabilityPanel.skills[key], 'fr skills ' + key).toBeTruthy();
      expect(zh.capabilityPanel.skills[key], 'zh skills ' + key).toBeTruthy();
    }
    for (const kind of ['builtin', 'global', 'plugin']) {
      expect(en.capabilityPanel.skills.source[kind], 'en source ' + kind).toBeTruthy();
      expect(fr.capabilityPanel.skills.source[kind], 'fr source ' + kind).toBeTruthy();
      expect(zh.capabilityPanel.skills.source[kind], 'zh source ' + kind).toBeTruthy();
    }
    for (const status of ['connecting', 'connected', 'failed', 'disabled']) {
      expect(en.capabilityPanel.mcp.status[status], 'en mcp status ' + status).toBeTruthy();
      expect(fr.capabilityPanel.mcp.status[status], 'fr mcp status ' + status).toBeTruthy();
      expect(zh.capabilityPanel.mcp.status[status], 'zh mcp status ' + status).toBeTruthy();
    }
    expect(en.controlCenter.tab.capabilities).toBe('Capabilities');
  });
});
