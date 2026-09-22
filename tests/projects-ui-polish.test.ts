import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Source + i18n contracts for the polished Projects interface.
 *
 * The regression this locks down: the pages referenced i18n keys that were
 * never added to the locale files, so the UI rendered raw key names
 * ("projects.pageTitle"). Every 'projects.*' literal used by the components
 * must resolve in ALL locales.
 */

const pages = readFileSync('src/renderer/components/projects/ProjectsPages.tsx', 'utf8');
const panel = readFileSync('src/renderer/components/ProjectsPanel.tsx', 'utf8');
const localesDir = path.resolve(process.cwd(), 'src/renderer/i18n/locales');

type Dict = Record<string, string | Dict>;

function loadLocale(name: string): Dict {
  return JSON.parse(readFileSync(path.join(localesDir, `${name}.json`), 'utf8'));
}

function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dict)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out[fullKey] = value;
    else Object.assign(out, flatten(value, fullKey));
  }
  return out;
}

/** Every literal 'projects.*' key referenced by the components. */
function referencedKeys(source: string): string[] {
  const keys = new Set<string>();
  for (const match of source.matchAll(/'((?:projects)\.[a-zA-Z0-9_.]+)'/g)) {
    keys.add(match[1]);
  }
  return [...keys].sort();
}

describe('Projects UI — i18n keys all resolve', () => {
  const keys = [...new Set([...referencedKeys(pages), ...referencedKeys(panel)])];

  it('collects a meaningful set of keys (guards a broken regex)', () => {
    expect(keys.length).toBeGreaterThan(30);
    expect(keys).toContain('projects.pageTitle');
    expect(keys).toContain('projects.sortSessions');
    expect(keys).toContain('projects.statusRunning');
  });

  for (const locale of ['en', 'fr', 'zh']) {
    it(`every referenced key exists in ${locale}.json`, () => {
      const flat = flatten(loadLocale(locale));
      const missing = keys.filter((key) => !(key in flat));
      expect(missing, `${locale} is missing: ${missing.join(', ')}`).toEqual([]);
    });
  }
});

describe('ProjectsPages — list view enhancements', () => {
  it('shows the real page title and subtitle instead of raw keys', () => {
    expect(pages).toContain("t('projects.pageTitle')");
    expect(pages).toContain("t('projects.pageSubtitle')");
  });

  it('offers a grid/list layout toggle', () => {
    expect(pages).toContain("const PROJECT_VIEWS: ProjectView[] = ['grid', 'list']");
    expect(pages).toContain("view === 'grid' ?");
    expect(pages).toContain("t('projects.viewList')");
  });

  it('gives every card a stable colour identity and relative timestamps', () => {
    expect(pages).toContain('function avatarTone(');
    expect(pages).toContain('function formatRelativeTime(');
    expect(pages).toContain('new Intl.RelativeTimeFormat');
  });

  it('exposes hover quick actions (open, edit, archive) on each card', () => {
    expect(pages).toContain('const renderActions');
    expect(pages).toContain("t('projects.openProject')");
    expect(pages).toContain("t('projects.quickEdit')");
    expect(pages).toContain('projects.archive(project.id, !project.archived)');
  });

  it('renders archived projects with a stable tag and dimmed style', () => {
    expect(pages).toContain("t('projects.archivedTag')");
  });
});

describe('ProjectsPages — detail view enhancements', () => {
  it('shows the real injection-budget ring (driven by the backend usage)', () => {
    expect(pages).toContain('function CapacityRing');
    expect(pages).toContain("t('projects.capacityTitle')");
  });

  it('groups reference files by kind with typed icons and a search box', () => {
    expect(pages).toContain('function fileKind(');
    expect(pages).toContain("t('projects.fileTypeImages')");
    expect(pages).toContain("t('projects.fileTypeCode')");
    expect(pages).toContain("t('projects.fileTypeDocs')");
    expect(pages).toContain("t('projects.searchFiles')");
  });

  it('lets the user pin/unpin conversations directly from the project page', () => {
    expect(pages).toContain('togglePinSession(session.id, !session.isPinned)');
    expect(pages).toContain('STATUS_TONE[session.status]');
  });

  it('lets the user copy the workspace path from the hero', () => {
    expect(pages).toContain('navigator.clipboard.writeText(project.workdir)');
    expect(pages).toContain("t('projects.pathCopied')");
  });
});

describe('ProjectsPanel — editor modal polish', () => {
  it('closes on Escape and saves on ⌘/Ctrl+Enter', () => {
    expect(panel).toContain("event.key === 'Escape'");
    expect(panel).toContain('event.metaKey || event.ctrlKey');
    expect(panel).toContain("t('projects.saveShortcutHint')");
  });

  it('validates required fields inline instead of only showing a top banner', () => {
    expect(panel).toContain('function isAbsolutePath(');
    expect(panel).toContain("t('projects.requiredField')");
    expect(panel).toContain("t('projects.workdirInvalid')");
  });

  it('counts instruction characters and labels the danger zone', () => {
    expect(panel).toContain("t('projects.characters', { count: instructions.length })");
    expect(panel).toContain("t('projects.dangerZoneTitle')");
    expect(panel).toContain("t('projects.dangerZoneHint')");
  });

  it('organises the form into labelled section cards', () => {
    expect(panel).toContain('function SectionCard(');
    expect(panel).toContain("t('projects.fileCount', { count: referenceFiles.length })");
  });
});
