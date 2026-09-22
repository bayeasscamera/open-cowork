import { describe, it, expect } from 'vitest';
import {
  ACCEPTED_ADVISORIES,
  advisoryIdFromUrl,
  collectAdvisories,
  findBlockingAdvisories,
} from '../scripts/audit-ci.mjs';

describe('audit-ci dependency gate', () => {
  const report = {
    vulnerabilities: {
      'extract-zip': {
        name: 'extract-zip',
        severity: 'high',
        via: [
          {
            url: 'https://github.com/advisories/GHSA-jmr9-qjv8-65gv',
            severity: 'high',
            title: 'symlink traversal',
          },
        ],
      },
      'some-new-package': {
        name: 'some-new-package',
        severity: 'critical',
        via: [
          {
            url: 'https://github.com/advisories/GHSA-0000-0000-0001',
            severity: 'critical',
            title: 'brand new critical',
          },
        ],
      },
      'low-only': {
        name: 'low-only',
        severity: 'low',
        via: [
          {
            url: 'https://github.com/advisories/GHSA-1111-1111-1111',
            severity: 'low',
            title: 'low severity',
          },
        ],
      },
    },
  };

  it('extracts the GHSA id from an advisory URL', () => {
    expect(advisoryIdFromUrl('https://github.com/advisories/GHSA-jmr9-qjv8-65gv')).toBe(
      'GHSA-jmr9-qjv8-65gv'
    );
    expect(advisoryIdFromUrl('')).toBe('');
  });

  it('flattens advisories and collects affected package names', () => {
    const advisories = collectAdvisories(report);
    const ids = advisories.map((a) => a.id).sort();
    expect(ids).toEqual(['GHSA-0000-0000-0001', 'GHSA-1111-1111-1111', 'GHSA-jmr9-qjv8-65gv']);
    const extractZip = advisories.find((a) => a.id === 'GHSA-jmr9-qjv8-65gv');
    expect(extractZip?.packages).toContain('extract-zip');
  });

  it('ignores string "via" entries that only link to a transitive dependency', () => {
    const withStringVia = {
      vulnerabilities: {
        ngrok: { name: 'ngrok', severity: 'high', via: ['extract-zip'] },
      },
    };
    expect(collectAdvisories(withStringVia)).toEqual([]);
  });

  it('does not block accepted advisories', () => {
    const acceptedOnly = {
      vulnerabilities: { 'extract-zip': report.vulnerabilities['extract-zip'] },
    };
    expect(findBlockingAdvisories(acceptedOnly)).toEqual([]);
  });

  it('blocks an unknown high/critical advisory and ignores low severity', () => {
    const blocking = findBlockingAdvisories(report, new Map());
    expect(blocking.map((a) => a.id).sort()).toEqual(['GHSA-0000-0000-0001', 'GHSA-jmr9-qjv8-65gv']);
  });

  it('every accepted advisory carries a non-trivial rationale', () => {
    for (const [id, reason] of ACCEPTED_ADVISORIES) {
      expect(id).toMatch(/^GHSA-/);
      expect(reason.length).toBeGreaterThan(40);
    }
  });
});
