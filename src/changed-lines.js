'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { fetchChangedEntries, presentEntries } = require('./changed-files');

const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;
const SHA = /^[0-9a-f]{40}$/;

/** The new-side line range of a hunk header, or null for a hunk that only removes lines. */
function hunkRange(line) {
  const match = HUNK.exec(line);
  if (!match) {
    return null;
  }
  const start = Number(match[1]);
  const count = match[2] === undefined ? 1 : Number(match[2]);
  return count > 0 ? [start, start + count - 1] : null;
}

/**
 * Parses `git diff --unified=0` output.
 *
 * @returns {Map<string, Array<[number, number]>>} path after the change to its changed line ranges
 */
function hunkRanges(diff) {
  const ranges = new Map();
  let current = null;
  for (const line of String(diff).split('\n')) {
    if (line.startsWith('+++ ')) {
      const target = line.slice(4);
      current = target === '/dev/null' ? null : target.replace(/^b\//, '');
      if (current !== null && !ranges.has(current)) {
        ranges.set(current, []);
      }
      continue;
    }
    if (current !== null) {
      const range = hunkRange(line);
      if (range) {
        ranges.get(current).push(range);
      }
    }
  }
  for (const [file, list] of ranges) {
    if (list.length === 0) {
      ranges.delete(file);
    }
  }
  return ranges;
}

/** Line ranges of the `patch` field of one file entry of the GitHub API. */
function patchRanges(patch) {
  return String(patch || '').split('\n').map(hunkRange).filter(Boolean);
}

/** Runs git; never throws. */
function runGit(directory) {
  return (args) => new Promise((resolve) => {
    execFile('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout || '' });
    });
  });
}

async function linesFromGit(event, git) {
  let range = null;
  if (event && event.pull_request) {
    // The checkout of a pull request is a merge commit; its first parent is the base branch.
    if ((await git(['rev-parse', '--verify', '-q', 'HEAD^2'])).code === 0) {
      range = ['HEAD^1', 'HEAD'];
    }
  } else {
    const before = String((event && event.before) || '');
    if (SHA.test(before) && before.replace(/0/g, '') !== '' && (await git(['cat-file', '-e', `${before}^{commit}`])).code === 0) {
      range = [before, 'HEAD'];
    }
  }
  if (!range) {
    return null;
  }
  const diff = await git(['diff', '--unified=0', '--no-color', '--no-ext-diff', '--relative', ...range]);
  return diff.code === 0 ? Object.fromEntries(hunkRanges(diff.stdout)) : null;
}

/**
 * Lines changed by the current pull request or push: git first, as its line numbers match the
 * checkout; the API patches otherwise, which are numbered on the head branch.
 *
 * @param {{event: Object, repository: string, api: string, token: string, request?: Function, git: Function}} options
 * @returns {Promise<?Object<string, ?Array<[number, number]>>>} null when unknown; a null value marks a whole file
 */
async function changedLines({ git, ...options }) {
  const fromGit = await linesFromGit(options.event, git);
  if (fromGit) {
    return fromGit;
  }
  const entries = await fetchChangedEntries(options);
  if (entries === null) {
    return null;
  }
  const lines = {};
  for (const entry of presentEntries(entries)) {
    // A file without a patch (binary, or a diff too big for the API) counts as changed as a whole.
    lines[String(entry.filename)] = typeof entry.patch === 'string' ? patchRanges(entry.patch) : null;
  }
  return lines;
}

function readChangedLines(file) {
  try {
    const lines = JSON.parse(fs.readFileSync(file, 'utf8'));
    return lines && typeof lines === 'object' && !Array.isArray(lines) ? lines : null;
  } catch {
    return null;
  }
}

/** Whether a line of a repository path was changed. */
function inScope(changed, repoPath, line) {
  if (!changed || repoPath === null || repoPath === undefined || !Object.hasOwn(changed, repoPath)) {
    return false;
  }
  const ranges = changed[repoPath];
  return ranges === null || ranges.some(([start, end]) => line >= start && line <= end);
}

module.exports = { hunkRanges, patchRanges, changedLines, readChangedLines, inScope, runGit };
