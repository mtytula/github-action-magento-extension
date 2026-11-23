'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { inScope } = require('./changed-lines');

const property = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const data = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function repositoryPath(reported, workspace, extension) {
  // PHPStan reports findings in a trait as `<file> (in context of class <name>)`.
  const file = String(reported).replace(/ \(in context of .*\)$/, '');
  let real = file;
  for (const candidate of [file, path.join(extension, file.replace(/^\/+/, ''))]) {
    try {
      real = fs.realpathSync(candidate);
      break;
    } catch {
      // The next candidate may exist.
    }
  }
  return real.startsWith(workspace + path.sep) ? real.slice(workspace.length + 1) : null;
}

/**
 * Turns a PHPCS or PHPStan JSON report into findings. `threshold` is a severity or `errors`.
 */
function findingsFromReport(tool, report, { workspace, extension, threshold = '10' }) {
  const findings = [];
  for (const [file, entry] of Object.entries((report && report.files) || {})) {
    const repoPath = repositoryPath(file, workspace, extension);
    if (repoPath === null) {
      continue;
    }
    for (const message of entry.messages || []) {
      if (tool === 'phpcs') {
        const fails = threshold === 'errors' ? message.type === 'ERROR' : Number(message.severity || 0) >= Number(threshold);
        findings.push({
          level: fails ? 'error' : 'warning',
          file: repoPath,
          line: Number(message.line || 1),
          col: Number(message.column || 0),
          title: `PHPCS ${message.source || ''}`,
          message: String(message.message || ''),
        });
      } else {
        findings.push({
          level: 'error',
          file: repoPath,
          line: Number(message.line || 1),
          col: 0,
          title: `PHPStan${message.identifier ? ` ${message.identifier}` : ''}`,
          message: String(message.message || ''),
        });
      }
    }
  }
  return findings;
}

/**
 * GitHub keeps 10 errors and 10 warnings per step, so findings in changed files go first and the
 * budget is shared between the checks of a step.
 *
 * @param {?Set<string>} changed repository paths changed by the pull request, or null when unknown
 * @param {?Object} changedLines when given, only findings on these lines are shown
 * @returns {{lines: string[], budget: {error: number, warning: number}}}
 */
function annotationLines(tool, findings, changed, budget, changedLines = null) {
  let shownFindings = findings;
  if (changedLines) {
    shownFindings = shownFindings.filter((finding) => inScope(changedLines, finding.file, finding.line));
  }
  // PHPStan analyses the whole extension, but only findings in changed files belong in the diff.
  if (tool === 'phpstan' && changed) {
    shownFindings = shownFindings.filter((finding) => changed.has(finding.file));
  }
  const rank = (finding) => (changed && changed.has(finding.file) ? 0 : 2) + (finding.level === 'error' ? 0 : 1);
  const sorted = [...shownFindings].sort((a, b) => rank(a) - rank(b) || a.file.localeCompare(b.file) || a.line - b.line);

  const remaining = { ...budget };
  const lines = [];
  for (const finding of sorted) {
    if ((remaining[finding.level] || 0) <= 0) {
      continue;
    }
    remaining[finding.level] -= 1;
    let position = `file=${property(finding.file)},line=${Math.max(1, finding.line)}`;
    if (finding.col > 0) {
      position += `,col=${finding.col}`;
    }
    lines.push(`::${finding.level} ${position},title=${property(finding.title)}::${data(finding.message)}`);
  }
  if (sorted.length > lines.length) {
    lines.push(`Showing ${lines.length} of ${sorted.length} ${tool} findings inline; the full list is in the log and the result files.`);
  }
  return { lines, budget: remaining };
}

module.exports = { findingsFromReport, annotationLines, repositoryPath, property, data };
