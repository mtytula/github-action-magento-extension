'use strict';

/** Test counts of the first test suite of a JUnit report. */
function junitTotals(xml) {
  const suite = /<testsuite\b[^>]*>/.exec(String(xml || ''));
  const attribute = (name) => {
    const match = suite ? new RegExp(`\\b${name}="(\\d+)"`).exec(suite[0]) : null;
    return match ? Number(match[1]) : 0;
  };
  return { tests: attribute('tests'), assertions: attribute('assertions'), broken: attribute('failures') + attribute('errors') };
}

/**
 * Counts PHPCS messages that fail the check and the rest. `threshold` is a severity or `errors`;
 * `keep(file, line)` limits the failing messages, the ones it drops are counted as `outside`.
 *
 * @returns {?{failing: number, other: number, outside: number}} null when the report is not a PHPCS report
 */
function phpcsTotals(report, threshold, keep = () => true) {
  if (!report || typeof report !== 'object' || !report.files) {
    return null;
  }
  let failing = 0;
  let other = 0;
  let outside = 0;
  for (const [name, file] of Object.entries(report.files)) {
    for (const message of file.messages || []) {
      const fails = threshold === 'errors' ? message.type === 'ERROR' : Number(message.severity) >= Number(threshold);
      if (!fails) {
        other += 1;
      } else if (keep(name, Number(message.line || 1))) {
        failing += 1;
      } else {
        outside += 1;
      }
    }
  }
  return { failing, other, outside };
}

/**
 * `failing` counts the file findings `keep(file, line)` accepts plus every general error.
 *
 * @returns {?{count: number, failing: number, lines: string[]}} null when PHPStan could not load its configuration
 */
function phpstanTotals(report, keep = () => true) {
  if (!report || typeof report !== 'object' || !report.totals) {
    return null;
  }
  const lines = [...(report.errors || []).map(String)];
  let failing = Number(report.totals.errors || 0);
  for (const [file, entry] of Object.entries(report.files || {})) {
    for (const message of entry.messages || []) {
      lines.push(`${file}:${message.line ?? '?'}  ${message.message}`);
      if (keep(file, Number(message.line || 1))) {
        failing += 1;
      }
    }
  }
  return { count: Number(report.totals.file_errors || 0) + Number(report.totals.errors || 0), failing, lines };
}

function firstVersion(text) {
  const match = /[0-9]+\.[0-9]+\.[0-9]+/.exec(String(text));
  return match ? match[0] : 'unknown';
}

module.exports = { junitTotals, phpcsTotals, phpstanTotals, firstVersion };
