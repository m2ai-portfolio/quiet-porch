import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalPath, isInside } from '../scripts/lib.ts';

describe('isInside guards the exporter against writing household frames into the repo', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qp-guard-')));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, 'docs'), { recursive: true });
  const outside = join(root, 'outside');
  mkdirSync(outside);
  symlinkSync(repo, join(outside, 'link-to-repo'));

  it('refuses the repo itself, any child, a child named with two dots, a dot-dot path that returns, and a symlink into it', () => {
    expect(isInside(repo, repo)).toBe(true);
    expect(isInside(repo, join(repo, 'docs', 'nights'))).toBe(true);
    expect(isInside(repo, join(repo, '..household'))).toBe(true); // a child whose name starts with two dots
    expect(isInside(repo, `${repo}/docs/../hh2`)).toBe(true);
    expect(isInside(repo, join(outside, 'link-to-repo', 'nights'))).toBe(true);
  });

  it('allows paths outside, including a sibling whose name starts with the repo name', () => {
    expect(isInside(repo, join(root, 'outside', 'nights'))).toBe(false);
    expect(isInside(repo, join(root, 'repo-fixtures'))).toBe(false);
    expect(isInside(repo, join(root, '..', 'elsewhere'))).toBe(false);
  });

  it('sees through the /var and /private/var alias on macOS', () => {
    if (process.platform !== 'darwin') return;
    const viaVar = repo.replace(/^\/private/, '');
    expect(viaVar).not.toBe(repo);
    expect(isInside(repo, join(viaVar, 'hh3'))).toBe(true);
    expect(canonicalPath(join(viaVar, 'hh3'))).toBe(join(repo, 'hh3'));
  });

  it('is not fooled by upper-case spelling on a case-insensitive filesystem (round 2)', () => {
    const upper = repo.replace(/repo$/, 'REPO');
    let insensitive = false;
    try {
      insensitive = realpathSync(upper) !== undefined;
    } catch {
      /* case-sensitive filesystem: nothing to test */
    }
    if (!insensitive) return;
    expect(isInside(repo, join(upper, 'fxupper'))).toBe(true);
    expect(isInside(upper, join(repo, 'docs'))).toBe(true);
  });
});
