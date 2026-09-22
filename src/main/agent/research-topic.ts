/**
 * @module main/agent/research-topic
 *
 * Topic grouping for parallel research delegations.
 *
 * Zone 2 of cross-verification must compare reports about the SAME subject: a
 * delegation about Kubernetes costs and one about the 2026 chip market cannot
 * factually contradict each other, and cross-checking them would burn a model
 * call for nothing. Because delegations are launched in parallel (often in the
 * same tool-call batch), there is no human-supplied subject to group on — the
 * subject has to be inferred from the briefs themselves.
 *
 * Pure and dependency-free (no model call), so it is cheap and unit-testable.
 * It is deliberately conservative: when two briefs do not clearly share
 * vocabulary, they go to DIFFERENT groups (a missed cross-check is preferable
 * to a meaningless one).
 */

/**
 * Words carrying no topical signal: English + French function words, plus the
 * generic research verbs a delegation brief is always built from. Kept small
 * and explicit — a large stop-list would erase real subject words.
 */
const STOP_WORDS = new Set([
  // English function words
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'from',
  'with', 'without', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'it', 'its', 'this', 'that', 'these', 'those', 'there', 'here', 'which', 'who',
  'what', 'when', 'where', 'why', 'how', 'all', 'any', 'both', 'each', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'also', 'about',
  'into', 'over', 'after', 'before', 'between', 'through', 'during', 'above',
  'below', 'up', 'down', 'out', 'off', 'again', 'further', 'then', 'once', 'if',
  'because', 'while', 'against', 'have', 'has', 'had', 'do', 'does', 'did',
  // French function words
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'mais', 'dans',
  'sur', 'pour', 'par', 'avec', 'sans', 'est', 'sont', 'etre', 'avoir', 'ce',
  'cet', 'cette', 'ces', 'qui', 'que', 'quoi', 'dont', 'ou', 'comment', 'pourquoi',
  'quand', 'plus', 'moins', 'tres', 'tout', 'tous', 'toute', 'toutes', 'son',
  'sa', 'ses', 'leur', 'leurs', 'nous', 'vous', 'ils', 'elles', 'je', 'tu',
  'au', 'aux', 'en', 'y', 'ne', 'pas', 'aussi', 'ainsi', 'donc', 'car',
  // Research-task vocabulary (present in nearly every brief)
  'research', 'recherche', 'rechercher', 'investigate', 'enquete', 'investigation',
  'find', 'trouve', 'trouver', 'search', 'cherche', 'look', 'explore', 'explorer',
  'analyze', 'analyse', 'analyser', 'compare', 'comparer', 'summarize', 'resume',
  'resumer', 'report', 'rapport', 'study', 'etude', 'etudier', 'overview',
  // Research framing nouns: they label the DELIVERABLE, not the subject, and
  // are shared by unrelated briefs ("... market outlook" vs "... market size").
  'outlook', 'perspective', 'trend', 'trends', 'tendances', 'key', 'main',
  'state', 'current', 'actuel', 'actuelle', 'latest', 'dernier', 'derniere',
  'recent', 'recente', 'report', 'sources', 'source', 'web', 'online', 'internet',
  'please', 'need', 'want', 'should', 'could', 'would', 'while', 'about',
  'example', 'examples', 'including', 'include', 'etc',
]);

/** Strip accents so "économie" and "economie" match. */
function deaccent(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/**
 * Extract the topical keywords of a research brief: lowercase, accent-stripped,
 * stop-words removed, 3+ characters, de-duplicated. Longer words are kept first
 * so the signature is dominated by specific terms (e.g. "kubernetes") rather
 * than generic ones.
 */
export function extractTopicKeywords(text: string): string[] {
  const words = deaccent(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  const unique = Array.from(new Set(words));
  return unique.sort((a, b) => b.length - a.length);
}

/**
 * Whether two research briefs clearly share a subject. Requires at least TWO
 * shared topical keywords: a single common word ("market", "model") is not
 * enough evidence to spend a cross-check call on unrelated topics.
 */
export function sharesResearchTopic(a: string, b: string): boolean {
  const aWords = new Set(extractTopicKeywords(a));
  if (aWords.size === 0) return false;
  let shared = 0;
  for (const word of new Set(extractTopicKeywords(b))) {
    if (aWords.has(word)) {
      shared += 1;
      if (shared >= 2) return true;
    }
  }
  return false;
}

/**
 * Group research delegations by inferred subject: each group holds briefs that
 * share a topic with at least one member (transitive closure via union-find, so
 * A-B and B-C group A with C even when A and C share less). Groups of ONE are
 * dropped — a single report has nothing to contradict.
 */
export function groupResearchByTopic<T>(
  items: T[],
  textOf: (item: T) => string
): T[][] {
  const parent = items.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    // Path compression keeps repeated lookups flat.
    let cursor = i;
    while (parent[cursor] !== root) {
      const next = parent[cursor];
      parent[cursor] = root;
      cursor = next;
    }
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[rj] = ri;
  };

  const texts = items.map((item) => textOf(item));
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (sharesResearchTopic(texts[i], texts[j])) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, T[]>();
  for (let i = 0; i < items.length; i += 1) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) {
      bucket.push(items[i]);
    } else {
      groups.set(root, [items[i]]);
    }
  }
  return Array.from(groups.values()).filter((group) => group.length >= 2);
}
