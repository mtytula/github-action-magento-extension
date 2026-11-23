'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { hunkRanges, patchRanges, changedLines, readChangedLines, inScope } = require('../src/changed-lines');

test('hunk ranges from git diff', () => {
  const diff = [
    'diff --git a/Model/A.php b/Model/A.php', '--- a/Model/A.php', '+++ b/Model/A.php',
    '@@ -10,2 +12,3 @@', '@@ -40 +43 @@', '@@ -60,4 +63,0 @@',
    'diff --git a/old.php b/new.php', '--- a/old.php', '+++ b/new.php', '@@ -1,0 +1,2 @@',
    'diff --git a/gone.php b/gone.php', '--- a/gone.php', '+++ /dev/null', '@@ -1,3 +0,0 @@',
  ].join('\n');
  assert.deepEqual(Object.fromEntries(hunkRanges(diff)), { 'Model/A.php': [[12, 14], [43, 43]], 'new.php': [[1, 2]] });
});

test('hunk ranges of a single API patch', () => {
  assert.deepEqual(patchRanges('@@ -1,3 +1,4 @@ class A\n x\n+y\n@@ -20 +21,0 @@\n-z\n@@ -30,2 +30,2 @@\n'), [[1, 4], [30, 31]]);
  assert.deepEqual(patchRanges(''), []);
});

test('changed lines prefer git on a merge commit and fall back to API patches', async () => {
  const calls = [];
  const gitOk = async (args) => {
    calls.push(args);
    return args[0] === 'rev-parse' ? { code: 0, stdout: 'sha\n' }
      : { code: 0, stdout: 'diff --git a/A.php b/A.php\n--- a/A.php\n+++ b/A.php\n@@ -1 +5,2 @@\n' };
  };
  const apiFiles = [
    { filename: 'A.php', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'big.php', status: 'modified' },
    { filename: 'gone.php', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
  ];
  const request = async () => ({ ok: true, json: async () => apiFiles });
  const base = { repository: 'acme/demo', api: 'https://api.example', token: 't', event: { pull_request: { number: 7 } }, request };

  assert.deepEqual(await changedLines({ ...base, git: gitOk }), { 'A.php': [[5, 6]] });
  assert.deepEqual(calls[0], ['rev-parse', '--verify', '-q', 'HEAD^2']);
  assert.equal(calls[1][0], 'diff');
  assert.deepEqual(calls[1].slice(-2), ['HEAD^1', 'HEAD']);

  const gitMissing = async () => ({ code: 128, stdout: '' });
  assert.deepEqual(await changedLines({ ...base, git: gitMissing }), { 'A.php': [[1, 1]], 'big.php': null });
});

test('changed lines of a push come from git, and are unknown without a previous commit', async () => {
  const before = 'a'.repeat(40);
  const after = 'b'.repeat(40);
  const calls = [];
  const git = async (args) => {
    calls.push(args);
    return args[0] === 'cat-file' ? { code: 0, stdout: '' } : { code: 0, stdout: '+++ b/X.php\n@@ -3 +3 @@\n' };
  };
  const base = { repository: 'acme/demo', api: 'https://api.example', token: 't', request: async () => ({ ok: false }) };

  assert.deepEqual(await changedLines({ ...base, event: { before, after }, git }), { 'X.php': [[3, 3]] });
  assert.deepEqual(calls[0], ['cat-file', '-e', `${before}^{commit}`]);
  assert.deepEqual(calls[1].slice(-2), [before, 'HEAD']);
  assert.equal(await changedLines({ ...base, event: { before: '0'.repeat(40), after }, git }), null);
  assert.equal(await changedLines({ ...base, event: { before, after }, git: async () => ({ code: 1, stdout: '' }) }), null);
});

test('changed lines are read back from their file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-lines-')), 'changed-lines.json');
  assert.equal(readChangedLines(file), null);
  fs.writeFileSync(file, JSON.stringify({ 'A.php': [[1, 2]], 'big.php': null }));
  assert.deepEqual(readChangedLines(file), { 'A.php': [[1, 2]], 'big.php': null });
  fs.writeFileSync(file, '[1]');
  assert.equal(readChangedLines(file), null);
});

test('inScope', () => {
  const lines = { 'A.php': [[5, 6]], 'big.php': null };
  assert.equal(inScope(lines, 'A.php', 6), true);
  assert.equal(inScope(lines, 'A.php', 7), false);
  assert.equal(inScope(lines, 'big.php', 900), true);
  assert.equal(inScope(lines, 'other.php', 1), false);
  assert.equal(inScope(lines, null, 1), false);
});

test('git ranges of a real merge commit are numbered on the merged file', async () => {
  const { execFileSync } = require('node:child_process');
  const { runGit } = require('../src/changed-lines');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-git-')));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  const write = (lines) => fs.writeFileSync(path.join(root, 'A.php'), `${lines.join('\n')}\n`);
  git('init', '-q', '-b', 'main');
  write(['a', 'b', 'c', 'd']);
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feature');
  write(['a', 'b', 'c', 'D']);
  git('commit', '-q', '-am', 'feature');
  git('switch', '-q', 'main');
  write(['new', 'new', 'a', 'b', 'c', 'd']);
  git('commit', '-q', '-am', 'main moved the file down');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');

  const lines = await changedLines({ event: { pull_request: { number: 1 } }, repository: 'acme/demo', git: runGit(root), request: async () => ({ ok: false }) });
  assert.deepEqual(lines, { 'A.php': [[6, 6]] });
});
