import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HISTORY_PAGE_SIZE,
  historyUrl,
  commitUrl,
  commitDiffUrl,
  worktreesUrl,
  normalizeHistory,
  normalizeCommit,
  normalizeCommitDiff,
  normalizeWorktrees,
  sameFilesPath,
  isSupportedFilesWorktree,
  filterCommits,
  formatCommitDate,
  formatFileStat,
} from '../public/files-workspace.js';

test('history URL carries the confirmed backend contract', () => {
  const url = new URL(historyUrl('C:/repo', { offset: 50, limit: 50 }), 'http://x');
  assert.equal(url.pathname, '/api/project-git/history');
  assert.equal(url.searchParams.get('cwd'), 'C:/repo');
  assert.equal(url.searchParams.get('ref'), 'HEAD');
  assert.equal(url.searchParams.get('offset'), '50');
  assert.equal(url.searchParams.get('limit'), '50');
  assert.equal(HISTORY_PAGE_SIZE, 50);
});

test('commit and diff URLs validate the contract shape', () => {
  assert.ok(commitUrl('C:/repo', 'a'.repeat(40)).startsWith('/api/project-git/commit?'));
  assert.ok(commitDiffUrl('C:/repo', 'a'.repeat(40), 'a/b.js').includes('path=a%2Fb.js'));
  assert.ok(worktreesUrl('C:/repo').startsWith('/api/project-git/worktrees?'));
});

test('normalizeHistory tolerates malformed payloads', () => {
  assert.deepEqual(normalizeHistory(null), { commits: [], hasMore: false, ref: '' });
  const out = normalizeHistory({
    commits: [{ hash: 'abcdef1234567890', subject: 'fix', tags: ['v1'], branches: ['main'], parents: ['p'] }],
    hasMore: true,
    ref: 'abcdef',
  });
  assert.equal(out.commits[0].shortHash, 'abcdef1');
  assert.equal(out.hasMore, true);
});

test('normalizeCommit caps stats and keeps renames', () => {
  const out = normalizeCommit({
    hash: 'h',
    subject: 's',
    files: [{ path: 'b.js', oldPath: 'a.js', status: 'R', additions: 3, deletions: 1 }],
    stats: { files: 1, additions: 3, deletions: 1 },
  });
  assert.equal(out.files[0].oldPath, 'a.js');
  assert.equal(out.stats.additions, 3);
});

test('normalizeCommitDiff and normalizeWorktrees keep flags', () => {
  assert.deepEqual(normalizeCommitDiff({ path: 'a', patch: 'x', truncated: true, binary: false }),
    { path: 'a', patch: 'x', truncated: true, binary: false });
  const wt = normalizeWorktrees({ worktrees: [{ path: 'p', branch: 'b', isCurrent: true, dirty: false, managed: true, id: '1' }], currentPath: 'p' });
  assert.equal(wt.worktrees[0].dirty, false);
  assert.equal(wt.currentPath, 'p');
});

test('filterCommits searches and honors the tags toggle', () => {
  const commits = [
    { hash: 'aaa', subject: 'fix login', tags: [], branches: ['main'] },
    { hash: 'bbb', subject: 'docs', tags: ['v2.0'], branches: [] },
  ];
  assert.equal(filterCommits(commits, { search: 'login' }).length, 1);
  assert.equal(filterCommits(commits, { tagsOnly: true }).length, 1);
  assert.equal(filterCommits(commits, { search: 'v2.0', tagsOnly: true }).length, 1);
  assert.equal(filterCommits(commits, {}).length, 2);
});

test('isSupportedFilesWorktree allows managed entries and the project root', () => {
  assert.equal(isSupportedFilesWorktree({ path: 'C:\\repo\\wt', managed: true }, 'C:\\other'), true);
  assert.equal(isSupportedFilesWorktree({ path: 'C:/repo', managed: false }, 'c:\\repo\\'), true);
  assert.equal(isSupportedFilesWorktree({ path: 'C:/foreign', managed: false }, 'C:/repo'), false);
  assert.equal(isSupportedFilesWorktree({ path: '' }, 'C:/repo'), false);
  assert.equal(isSupportedFilesWorktree(null, 'C:/repo'), false);
});

test('sameFilesPath normalizes separators, case and trailing slashes', () => {
  assert.equal(sameFilesPath('C:\\repo\\wt', 'c:/repo/wt/'), true);
  assert.equal(sameFilesPath('C:/repo/wt', 'C:/repo/other'), false);
  assert.equal(sameFilesPath('', 'C:/repo'), false);
  assert.equal(sameFilesPath(null, null), false);
});

test('format helpers never throw', () => {
  assert.equal(formatCommitDate('not-a-date', 'en'), '');
  assert.ok(formatCommitDate(new Date(0).toISOString(), 'en').length > 0);
  assert.equal(formatFileStat({ binary: true }), 'binary');
  assert.equal(formatFileStat({ additions: 2, deletions: 1 }), '+2 −1');
});
