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

  it('requires a DISTINCTIVE shared keyword, so generic vocabulary is not enough', () => {
    // Share only generic terms ("market", "outlook") — different subjects.
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market outlook',
        'Research the cloud software market outlook'
      )
    ).toBe(false);
    // A distinctive shared term — same subject.
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market outlook in Europe',
        'Research the electric vehicle market outlook in Asia'
      )
    ).toBe(true);
  });

  it('never bridges two subjects through shared GENERIC words alone', () => {
    // Regression: "market"+"size" used to union these into ONE group, so a
    // 4-delegation batch produced 3 cross-check passes instead of 2.
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market size',
        'Research the semiconductor market size'
      )
    ).toBe(false);
    expect(
      sharesResearchTopic(
        'Research the electric vehicle market share',
        'Research the semiconductor market share'
      )
    ).toBe(false);
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

  it('splits 4 briefs into exactly 2 subject groups (no generic-word bridge)', () => {
    const items = [
      { t: 'EV size', p: 'Research the electric vehicle market size' },
      { t: 'EV share', p: 'Research the electric vehicle market share' },
      { t: 'Chip size', p: 'Research the semiconductor market size' },
      { t: 'Chip share', p: 'Research the semiconductor market share' },
    ];
    const groups = groupResearchByTopic(items, (i) => `${i.t}\n${i.p}`);
    expect(groups).toHaveLength(2);
    const labels = groups.map((g) => g.map((x) => x.t).sort()).sort();
    expect(labels).toEqual([
      ['Chip share', 'Chip size'],
      ['EV share', 'EV size'],
    ]);
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
    // Both briefs are pure function words, so extractTopicKeywords yields [].
    // (Previously this passed only because the rule required TWO shared
    // keywords; the shared "thing" was silently doing the work.)
    const items = [{ p: 'do it now' }, { p: 'be there then' }];
    expect(extractTopicKeywords(items[0].p)).toHaveLength(0);
    expect(extractTopicKeywords(items[1].p)).toHaveLength(0);
    expect(groupResearchByTopic(items, (i) => i.p)).toHaveLength(0);
  });
});
