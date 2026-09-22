import { describe, expect, it } from 'vitest';
import {
  extractTopicKeywords,
  groupResearchByTopic,
  sharesResearchTopic,
} from '../src/main/agent/research-topic';

describe('research topic detection', () => {
  it('extracts topical keywords, dropping stop words and research vocabulary', () => {
    const keywords = extractTopicKeywords(
      'Research the 2026 electric vehicle market in Europe and summarize key findings with sources'
    );
    expect(keywords).toContain('electric');
    expect(keywords).toContain('vehicle');
    expect(keywords).toContain('europe');
    // Task vocabulary and function words carry no topical signal.
    expect(keywords).not.toContain('research');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('with');
    expect(keywords).not.toContain('2026'); // bare numbers are not topics
  });

  it('matches across accents and casing (French briefs)', () => {
    const a = 'Rechercher le marché de l\'économie circulaire en France';
    const b = "Analyse de l'economie circulaire francaise et de son marche";
    expect(sharesResearchTopic(a, b)).toBe(true);
  });

  it('requires TWO shared keywords, so one generic word is not enough', () => {
    // Share only "market" — clearly different subjects.
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market outlook',
        'Research the cloud software market outlook'
      )
    ).toBe(false);
    // Two specific shared terms — same subject.
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market outlook in Europe',
        'Research the electric vehicle market outlook in Asia'
      )
    ).toBe(true);
  });

  it('never groups two clearly unrelated research briefs', () => {
    const groups = groupResearchByTopic(
      [
        { title: 'Kubernetes costs', prompt: 'Research Kubernetes cluster cost optimization' },
        { title: 'Chip market', prompt: 'Research the 2026 semiconductor market size' },
      ],
      (d) => `${d.title}\n${d.prompt}`
    );
    expect(groups).toHaveLength(0); // no group of 2+ → no cross-check
  });

  it('groups parallel briefs on the SAME subject, including transitively', () => {
    const items = [
      { t: 'A', p: 'Research the electric vehicle market size in Europe' },
      { t: 'B', p: 'Research the electric vehicle market share in Europe' },
      { t: 'C', p: 'Research the electric vehicle charging infrastructure buildout' },
      { t: 'D', p: 'Research sourdough bread hydration ratios' },
    ];
    const groups = groupResearchByTopic(items, (i) => `${i.t}\n${i.p}`);
    expect(groups).toHaveLength(1);
    // A-B share "electric vehicle market", B-C share "electric vehicle": all three
    // land in one group; the bread brief stays out.
    expect(groups[0].map((g) => g.t).sort()).toEqual(['A', 'B', 'C']);
  });

  it('returns no group when the briefs carry no keywords at all', () => {
    const items = [
      { p: 'do the thing' },
      { p: 'do the other thing' },
    ];
    expect(groupResearchByTopic(items, (i) => i.p)).toHaveLength(0);
  });
});
