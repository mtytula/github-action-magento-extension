'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { CheckFailed } = require('./errors');
const { NEEDS_INSTALL } = require('./plan');
const { prepareWorkDirectory, readInstallState, writeInstallState } = require('./workdir');
const { loadChecks, recordCheck, saveResults, oneLine, FAILING } = require('./results');
const { stepSummary, tail } = require('./summary');
const { findingsFromReport, annotationLines, property, data } = require('./annotations');
const { readChangedFiles } = require('./changed-files');
const { readChangedLines } = require('./changed-lines');
const { moduleNames } = require('./extension');
const { createShell } = require('./shell');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs one check with its output in a log group and in the check's log file.
 *
 * @returns {Promise<{status: string, note: string}>}
 */
async function runCheck(name, implementation, ctx, write) {
  const log = fs.createWriteStream(path.join(ctx.config.results, `${name}.log`));
  const emit = (text) => {
    write(text);
    log.write(text);
  };
  // Output of the extension's own code must not be able to issue workflow commands.
  const token = `mec-${crypto.randomBytes(16).toString('hex')}`;
  write(`::group::${name}\n::stop-commands::${token}\n`);
  let outcome;
  try {
    outcome = await implementation({
      ...ctx,
      sh: createShell(emit),
      log: (text) => emit(`${text}\n`),
    });
  } catch (error) {
    if (!(error instanceof CheckFailed)) {
      emit(`${error.message}\n`);
    }
    outcome = { status: 'failed', note: error instanceof CheckFailed ? error.note : '' };
  }
  await new Promise((resolve) => log.end(resolve));
  write(`::${token}::\n::endgroup::\n`);
  return outcome;
}

function annotate(check, ctx, write) {
  const { config } = ctx;
  const report = readJson(path.join(config.results, `${check}.json`));
  if (!config.annotations || !report) {
    return;
  }
  let threshold = '10';
  try {
    threshold = fs.readFileSync(path.join(config.results, 'phpcs.threshold'), 'utf8').trim() || '10';
  } catch {
    threshold = '10';
  }
  const budgetFile = path.join(config.results, 'annotation-budget.json');
  const findings = findingsFromReport(check, report, { workspace: config.workspace, extension: config.extension, threshold });
  const { lines, budget } = annotationLines(check, findings, ctx.changed, readJson(budgetFile) || { error: 10, warning: 10 });
  fs.writeFileSync(budgetFile, JSON.stringify(budget));
  for (const line of lines) {
    write(`${line}\n`);
  }
}

/**
 * Runs the selected checks of one step and records them next to the results of earlier steps.
 *
 * @param {Object<string, Function>} implementations check name to async function
 * @returns {Promise<{status: string, ran: Array, checks: Array}>}
 */
async function runChecks(config, implementations, { write = (text) => process.stdout.write(text), phpRuntime = null, now = Date.now } = {}) {
  prepareWorkDirectory(config);
  const ctx = {
    config,
    modules: moduleNames(config.extension),
    changed: readChangedFiles(path.join(config.work, 'changed-files.txt')),
    changedLines: readChangedLines(path.join(config.work, 'changed-lines.json')),
    installedPath: () => fs.readFileSync(path.join(config.work, 'installed-path'), 'utf8').trim(),
  };

  let checks = loadChecks(config);
  const ran = [];
  const failures = [];
  const warnings = [];
  const installed = readInstallState(config);
  let installStatus = installed ? installed.status : '';

  for (const check of config.checks) {
    if (check === 'install' && installed) {
      continue;
    }
    const started = now();
    let outcome;
    if (NEEDS_INSTALL.includes(check) && installStatus !== 'passed') {
      outcome = { status: 'blocked', note: 'install did not pass' };
    } else {
      outcome = await runCheck(check, implementations[check], ctx, write);
      if (['phpcs', 'phpstan'].includes(check)) {
        annotate(check, ctx, write);
      }
    }
    if (check === 'install') {
      installStatus = outcome.status;
      writeInstallState(config, outcome.status);
    }
    const row = { check, status: outcome.status, seconds: Math.round((now() - started) / 1000), note: oneLine(outcome.note || '') };
    checks = recordCheck(checks, row);
    ran.push(row);
    if (FAILING.includes(row.status)) {
      failures.push(`::error title=${property(`${config.label}: ${check} ${row.status}`)}::${data(row.note || `See the '${check}' group in the log.`)}`);
    }
    if (row.status === 'warning') {
      warnings.push(`::warning title=${property(`${config.label}: ${check}`)}::${data(row.note)}`);
    }
  }
  // Printed last: inline findings come first in GitHub's limit of 10 errors per step.
  for (const line of [...failures, ...warnings]) {
    write(`${line}\n`);
  }
  saveResults(config, checks, phpRuntime);
  return { status: failures.length === 0 ? 'passed' : 'failed', ran, checks };
}

function writeStepSummary(config, result, summaryFile) {
  if (!config.stepSummary || !summaryFile) {
    return;
  }
  const tails = {};
  for (const row of result.ran.filter((candidate) => candidate.status === 'failed')) {
    try {
      tails[row.check] = tail(fs.readFileSync(path.join(config.results, `${row.check}.log`), 'utf8'));
    } catch {
      // A check without a log has nothing to show.
    }
  }
  fs.appendFileSync(summaryFile, stepSummary(config.label, result.status, result.ran, tails));
}

module.exports = { runChecks, runCheck, writeStepSummary };
