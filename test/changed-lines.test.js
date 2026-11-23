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
  const head = 'c'.repeat(40);
  const gitOk = async (args) => {
    calls.push(args);
    return args[0] === 'rev-parse' ? { code: 0, stdout: `${head}\n` }
      : { code: 0, stdout: 'diff --git a/A.php b/A.php\n--- a/A.php\n+++ b/A.php\n@@ -1 +5,2 @@\n' };
  };
  const apiFiles = [
    { filename: 'A.php', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' },
    { filename: 'big.php', status: 'modified' },
    { filename: 'gone.php', status: 'removed', patch: '@@ -1 +0,0 @@\n-x' },
  ];
  const request = async () => ({ ok: true, json: async () => apiFiles });
  const base = { repository: 'acme/demo', api: 'https://api.example', token: 't', event: { pull_request: { number: 7, head: { sha: head } } }, request };

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
    return args[0] === 'cat-file' ? { code: 0, stdout: '' } : { code: 0, stdout: '--- a/X.php\n+++ b/X.php\n@@ -3 +3 @@\n' };
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
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'feature'], { encoding: 'utf8' }).trim();

  const lines = await changedLines({ event: { pull_request: { number: 1, head: { sha: head } } }, repository: 'acme/demo', git: runGit(root), request: async () => ({ ok: false }) });
  assert.deepEqual(lines, { 'A.php': [[6, 6]] });
});

test('scope filters step down when the changed lines or files are unknown', () => {
  const { scopeFilter } = require('../src/scope');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-scope-')));
  for (const name of ['A.php', 'B.php']) {
    fs.writeFileSync(path.join(root, name), '<?php');
  }
  const file = (name) => path.join(root, name);
  const base = { config: { workspace: root, extension: root } };

  const lines = scopeFilter({ ...base, changed: new Set(['A.php']), changedLines: { 'A.php': [[1, 3]] } }, 'lines');
  assert.deepEqual([lines.scope, lines.prefix], ['lines', '']);
  assert.deepEqual([lines.keep(file('A.php'), 2), lines.keep(file('A.php'), 9), lines.keep(file('B.php'), 1)], [true, false, false]);

  const noLines = scopeFilter({ ...base, changed: new Set(['A.php']), changedLines: null }, 'lines');
  assert.deepEqual([noLines.scope, noLines.prefix], ['changed', 'changed lines unknown; ']);
  assert.deepEqual([noLines.keep(file('A.php'), 9), noLines.keep(file('B.php'), 1)], [true, false]);

  const nothing = scopeFilter({ ...base, changed: null, changedLines: null }, 'changed');
  assert.deepEqual([nothing.scope, nothing.prefix, nothing.keep(file('B.php'), 1)], ['all', 'changed files unknown; ', true]);

  assert.equal(scopeFilter({ ...base, changed: null, changedLines: null }, 'lines').prefix, 'changed lines unknown; changed files unknown; ');
  assert.equal(scopeFilter({ ...base, changed: null, changedLines: null }, 'all').prefix, '');
});

test('git ranges are used only when the merge commit is the one of this pull request', async () => {
  const head = 'c'.repeat(40);
  const diff = { code: 0, stdout: '--- a/A.php\n+++ b/A.php\n@@ -1 +5,2 @@\n' };
  const git = (second) => async (args) => (args[0] === 'rev-parse' ? { code: 0, stdout: `${second}\n` } : diff);
  const apiFiles = [{ filename: 'A.php', status: 'modified', patch: '@@ -1 +1 @@\n-x\n+y' }];
  const base = { repository: 'acme/demo', api: 'https://api.example', token: 't', event: { pull_request: { number: 7, head: { sha: head } } },
    request: async () => ({ ok: true, json: async () => apiFiles }) };
  assert.deepEqual(await changedLines({ ...base, git: git(head) }), { 'A.php': [[5, 6]] });
  // A head checkout whose last commit merges the base branch: HEAD^2 is not the head of the pull request.
  assert.deepEqual(await changedLines({ ...base, git: git('d'.repeat(40)) }), { 'A.php': [[1, 1]] });
});

test('a content line that looks like a file header does not end the file', () => {
  const diff = ['diff --git a/A.php b/A.php', '--- a/A.php', '+++ b/A.php', '@@ -1 +1,2 @@', '+++ looks like a header', '+x', '@@ -9 +10 @@', '+y'].join('\n');
  assert.deepEqual(Object.fromEntries(hunkRanges(diff)), { 'A.php': [[1, 2], [10, 10]] });
});

test('git ranges keep file names with non-ASCII characters', async () => {
  const { execFileSync } = require('node:child_process');
  const { runGit } = require('../src/changed-lines');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-git-')));
  const git = (...args) => execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { stdio: 'pipe' });
  const name = 'Zażółć.php';
  fs.writeFileSync(path.join(root, name), 'a\n');
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'base');
  git('switch', '-q', '-c', 'feature');
  fs.writeFileSync(path.join(root, name), 'a\nb\n');
  git('commit', '-q', '-am', 'feature');
  git('switch', '-q', 'main');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  const head = execFileSync('git', ['-C', root, 'rev-parse', 'feature'], { encoding: 'utf8' }).trim();
  const lines = await changedLines({ event: { pull_request: { number: 1, head: { sha: head } } }, repository: 'acme/demo', git: runGit(root), request: async () => ({ ok: false }) });
  assert.deepEqual(lines, { [name]: [[2, 2]] });
});

test('scope finds PHPStan findings reported in the context of a class', () => {
  const { scopeFilter } = require('../src/scope');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-scope-')));
  fs.writeFileSync(path.join(root, 'T.php'), '<?php trait T {}');
  const ctx = { config: { workspace: root, extension: root }, changed: new Set(['T.php']), changedLines: { 'T.php': [[1, 1]] } };
  const key = `${path.join(root, 'T.php')} (in context of class Foo)`;
  assert.equal(scopeFilter(ctx, 'changed').keep(key, 1), true);
  assert.equal(scopeFilter(ctx, 'lines').keep(key, 1), true);
});

test('changed files outside the workspace make the scope step down instead of passing', () => {
  const { scopeFilter } = require('../src/scope');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mec-scope-')));
  fs.writeFileSync(path.join(root, 'A.php'), '<?php');
  // Checked out into a subdirectory: the API names paths from the repository root.
  const ctx = { config: { workspace: root, extension: root }, changed: new Set(['ext/A.php']), changedLines: { 'ext/A.php': null } };
  const changed = scopeFilter(ctx, 'changed');
  assert.deepEqual([changed.scope, changed.prefix, changed.keep(path.join(root, 'A.php'), 1)], ['all', 'changed files not in the workspace; ', true]);
  assert.equal(scopeFilter(ctx, 'lines').prefix, 'changed lines not in the workspace; changed files not in the workspace; ');
  assert.equal(scopeFilter({ ...ctx, changed: new Set(), changedLines: {} }, 'changed').scope, 'changed');
});
