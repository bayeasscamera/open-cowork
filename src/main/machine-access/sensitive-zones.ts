/**
 * @module main/machine-access/sensitive-zones
 *
 * Sensitive zones are NEVER blocked — they always trigger a reinforced
 * approval card, in every autonomy level including "allow-all". This rule
 * is non-disablable by construction: callers receive `sensitive: true`
 * and must route through user approval.
 */

const POSIX_SENSITIVE_PREFIXES = [
  '/System',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/var',
  '/private',
  '/Library',
  '/Applications',
  '/cores',
  '/opt',
  '/dev',
  '/proc',
  '/sys',
  '/lib',
] as const;

const WINDOWS_SENSITIVE_PREFIXES = [
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\programdata',
] as const;

const HOME_SECRET_SEGMENTS = [
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
  '.config',
  '.pki',
  'Library/Keychains',
  'Library/Cookies',
  'Library/Application Support/Google/Chrome',
  'Library/Application Support/Firefox',
  'AppData/Local/Google/Chrome',
  'AppData/Roaming/Mozilla/Firefox',
] as const;

const COWORK_DATA_SEGMENTS = ['.cowork', '.cowork-user-data'] as const;

const SECRET_FILENAMES = [
  '.env',
  '.env.local',
  'id_rsa',
  'id_ed25519',
  '.pem',
  '.key',
  'credentials.json',
  'secrets.json',
  '.npmrc',
  '.pypirc',
] as const;

function normalizeForMatch(value: string): string {
  return value.normalize('NFC').replace(/\\/g, '/');
}

function lowerOnFs(value: string, platform: NodeJS.Platform): string {
  // macOS default FS and Windows are case-insensitive; Linux is not.
  return platform === 'linux' ? value : value.toLowerCase();
}

/**
 * True when the canonical path enters a sensitive zone. Lexical, conservative:
 * any prefix match counts, on any casing the FS would fold.
 */
export function isSensitivePath(
  canonicalPath: string,
  options: { platform?: NodeJS.Platform; homeDir?: string } = {}
): boolean {
  const platform = options.platform ?? process.platform;
  const normalized = normalizeForMatch(canonicalPath);
  const folded = lowerOnFs(normalized, platform);

  // OS temp roots are working space, not sensitive — even under /var.
  const tempRoots = ['/tmp', '/var/folders', '/private/var/folders', '/private/tmp'];
  const inTemp = tempRoots.some(
    (root) => folded === lowerOnFs(root, platform) || folded.startsWith(lowerOnFs(root, platform) + '/')
  );

  for (const prefix of POSIX_SENSITIVE_PREFIXES) {
    const p = lowerOnFs(prefix, platform);
    if (folded === p || folded.startsWith(p + '/')) {
      // /var/folders (macOS temp) is explicitly not a sensitive zone.
      if (inTemp && (p === '/var' || p === '/private')) continue;
      if (inTemp && folded.startsWith(lowerOnFs('/private/var/folders', platform) + '/')) continue;
      return true;
    }
  }

  if (platform === 'win32') {
    for (const prefix of WINDOWS_SENSITIVE_PREFIXES) {
      const p = prefix.replace(/\\/g, '/');
      if (folded === p || folded.startsWith(p + '/')) return true;
    }
    // Drive root (C:/) and whole-profile grants are sensitive.
    if (/^[a-z]:\/$/i.test(normalized)) return true;
  } else if (/^\/$/.test(normalized)) {
    return true;
  }

  const home = options.homeDir ?? process.env['HOME'] ?? process.env['USERPROFILE'] ?? '';
  if (home) {
    const foldedHome = lowerOnFs(normalizeForMatch(home).replace(/\/+$/, ''), platform);
    if (folded === foldedHome) return true; // whole home folder
    for (const seg of HOME_SECRET_SEGMENTS) {
      const candidate = foldedHome + '/' + lowerOnFs(seg, platform);
      if (folded === candidate || folded.startsWith(candidate + '/')) return true;
    }

    // Another user's home folder is sensitive. The layout differs per platform:
    // /Users/<name> on macOS, /home/<name> on Linux. Only the folder that is
    // NOT the current user's home qualifies.
    const usersRoot = platform === 'darwin' ? '/users/' : '/home/';
    const foldedUsersRoot = lowerOnFs(usersRoot, platform);
    if (folded.startsWith(foldedUsersRoot)) {
      const remainder = folded.slice(foldedUsersRoot.length);
      const slash = remainder.indexOf('/');
      const otherUser = slash === -1 ? remainder : remainder.slice(0, slash);
      const otherHome = foldedUsersRoot + otherUser;
      if (otherUser.length > 0 && otherHome !== foldedHome) return true;
    }
  }

  for (const seg of COWORK_DATA_SEGMENTS) {
    const needle = '/' + lowerOnFs(seg, platform);
    if (folded.endsWith(needle) || folded.includes(needle + '/')) return true;
  }

  const base = folded.split('/').pop() ?? '';
  return (SECRET_FILENAMES as readonly string[]).some(
    (name) => base === lowerOnFs(name, platform) || base.endsWith('.pem') || base.endsWith('.key')
  );
}

/** True for secret-bearing filenames whose content must be masked before the model. */
export function isSecretFilename(fileName: string): boolean {
  const base = fileName.normalize('NFC').split(/[\\/]/).pop() ?? '';
  const folded = base.toLowerCase();
  return (SECRET_FILENAMES as readonly string[]).some(
    (name) => folded === name.toLowerCase() || folded.endsWith('.pem') || folded.endsWith('.key')
  );
}
