'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inScope } = require('./changed-lines');
const { repositoryPath } = require('./annotations');

/**
 * Which findings fail a check with scope `lines`, `changed` or `all`. Without the changed lines,
 * `lines` steps down to `changed`; without the changed files, `changed` steps down to `all`, and
 * the prefix says so in the note.
 *
 * @returns {{scope: string, prefix: string, keep: function(string, number): boolean}}
 */
function scopeFilter(ctx, scope) {
  const { workspace, extension } = ctx.config;
  const repoPath = (file) => repositoryPath(file, workspace, extension);
  // Paths that name no file of the workspace (a checkout into a subdirectory) would match nothing
  // and let every finding pass.
  const usable = (paths) => paths.length === 0 || paths.some((name) => fs.existsSync(path.join(workspace, name)));
  let prefix = '';
  let effective = scope;
  if (effective === 'lines' && !ctx.changedLines) {
    prefix += 'changed lines unknown; ';
    effective = 'changed';
  } else if (effective === 'lines' && !usable(Object.keys(ctx.changedLines))) {
    prefix += 'changed lines not in the workspace; ';
    effective = 'changed';
  }
  if (effective === 'changed' && !ctx.changed) {
    prefix += 'changed files unknown; ';
    effective = 'all';
  } else if (effective === 'changed' && !usable([...ctx.changed])) {
    prefix += 'changed files not in the workspace; ';
    effective = 'all';
  }
  if (effective === 'lines') {
    return { scope: effective, prefix, keep: (file, line) => inScope(ctx.changedLines, repoPath(file), line) };
  }
  if (effective === 'changed') {
    return { scope: effective, prefix, keep: (file) => ctx.changed.has(repoPath(file)) };
  }
  return { scope: 'all', prefix, keep: () => true };
}

module.exports = { scopeFilter };
