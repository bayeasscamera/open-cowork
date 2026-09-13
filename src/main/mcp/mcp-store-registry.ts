/**
 * @module main/mcp/mcp-store-registry
 * v3.6+: One-Click MCP App Store & Tool Registry
 */

export interface MCPStoreItem {
  id: string;
  name: string;
  description: string;
  category: 'search' | 'database' | 'devtools' | 'browser' | 'productivity';
  command: string;
  args: string[];
  envRequirements?: string[];
  icon: string;
  installed: boolean;
}

export class MCPStoreRegistry {
  private items: Map<string, MCPStoreItem> = new Map();

  constructor() {
    this.initCatalog();
  }

  private initCatalog() {
    const catalog: MCPStoreItem[] = [
      {
        id: 'brave-search',
        name: 'Brave Search',
        description: 'Recherche Web en direct sans tracking',
        category: 'search',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-brave-search'],
        envRequirements: ['BRAVE_API_KEY'],
        icon: 'search',
        installed: false,
      },
      {
        id: 'postgresql',
        name: 'PostgreSQL Explorer',
        description: 'Inspection de schémas et exécution de requêtes SQL sécurisées',
        category: 'database',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-postgres'],
        envRequirements: ['POSTGRES_CONNECTION_STRING'],
        icon: 'database',
        installed: false,
      },
      {
        id: 'github',
        name: 'GitHub Automator',
        description: 'Gestion des PRs, issues et commits directement par l\'agent',
        category: 'devtools',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        envRequirements: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
        icon: 'github',
        installed: false,
      },
      {
        id: 'puppeteer-browser',
        name: 'Puppeteer Browser Control',
        description: 'Automatisation de navigation Web, clics et captures d\'écran',
        category: 'browser',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-puppeteer'],
        icon: 'globe',
        installed: false,
      },
      {
        id: 'filesystem-extended',
        name: 'Extended Filesystem Sandbox',
        description: 'Accès sécurisé à des répertoires secondaires de la machine',
        category: 'devtools',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem'],
        icon: 'folder',
        installed: false,
      },
    ];

    for (const item of catalog) {
      this.items.set(item.id, item);
    }
  }

  public getCatalog(): MCPStoreItem[] {
    return Array.from(this.items.values());
  }

  public getInstalled(): MCPStoreItem[] {
    return this.getCatalog().filter((i) => i.installed);
  }

  public setInstalled(id: string, installed: boolean): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    item.installed = installed;
    return true;
  }
}
