'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('../src/config');
const { runChecks, writeStepSummary } = require('../src/run');
const { CheckFailed } = require('../src/errors');
const { workspace } = require('./helpers');

const pass = (note = '') => async () => ({ status: 'passed', note });

function step(env, checks, implementations) {
  const output = [];
  const config = readConfig({ ...env, MEC_CHECKS: checks });
  return runChecks(config, implementations, { write: (text) => output.push(text) })
    .then((result) => ({ ...result, output: output.join(''), config }));
}

test('checks run in order and their results are recorded', async () => {
  const { env } = workspace();
  const order = [];
  const record = (name) => async () => {
    order.push(name);
    return { status: 'passed', note: `${name} ok` };
  };
  const result = await step(env, 'unit,compile', { install: record('install'), compile: record('compile'), unit: record('unit') });
  assert.deepEqual(order, ['install', 'compile', 'unit']);
  assert.equal(result.status, 'passed');
  const saved = JSON.parse(fs.readFileSync(path.join(result.config.results, 'results.json'), 'utf8'));
  assert.equal(saved.magento, '2.4.8-p5');
  assert.equal(saved.status, 'passed');
  assert.deepEqual(saved.checks.map((check) => [check.check, check.status]), [['install', 'passed'], ['compile', 'passed'], ['unit', 'passed']]);
});

test('a failed install blocks the checks that need it and is not repeated by later steps', async () => {
  const { env } = workspace();
  let installs = 0;
  const implementations = {
    install: async () => {
      installs += 1;
      throw new CheckFailed('Composer could not resolve');
    },
    compile: pass(),
    unit: pass(),
  };
  const first = await step(env, 'compile', implementations);
  assert.equal(first.status, 'failed');
  assert.deepEqual(first.ran.map((row) => [row.check, row.status]), [['install', 'failed'], ['compile', 'blocked']]);
  assert.match(first.output, /::error title=Magento 2\.4\.8-p5 @ PHP 8\.4%3A install failed::Composer could not resolve/);

  const second = await step(env, 'unit', implementations);
  assert.equal(installs, 1);
  assert.deepEqual(second.ran.map((row) => [row.check, row.status]), [['unit', 'blocked']]);
});

test('later steps reuse a passed install and add to the results of the job', async () => {
  const { env } = workspace();
  let installs = 0;
  const implementations = {
    install: async () => {
      installs += 1;
      return { status: 'passed', note: '' };
    },
    compile: pass(),
    unit: async () => ({ status: 'skipped', note: 'no Test/Unit directory' }),
    validate: pass(),
  };
  await step({ ...env, MEC_MAGENTO_VERSION: '2.4.8-p5' }, 'validate', implementations);
  await step(env, 'install', implementations);
  await step(env, 'compile', implementations);
  const last = await step(env, 'unit', implementations);
  assert.equal(installs, 1);
  assert.deepEqual(last.ran.map((row) => row.check), ['unit']);
  assert.equal(last.status, 'passed');
  assert.deepEqual(last.checks.map((check) => check.check), ['validate', 'install', 'compile', 'unit']);
});

test('an unexpected error fails the check without stopping the others', async () => {
  const { env } = workspace();
  const result = await step(env, 'validate,lint', {
    validate: async () => {
      throw new Error('composer exited with 2');
    },
    lint: pass('1 files'),
  });
  assert.deepEqual(result.ran.map((row) => [row.check, row.status]), [['validate', 'failed'], ['lint', 'passed']]);
  assert.match(result.output, /See the 'validate' group in the log/);
  assert.match(fs.readFileSync(path.join(result.config.results, 'validate.log'), 'utf8'), /composer exited with 2/);
});

test('output of a check cannot issue workflow commands', async () => {
  const { env } = workspace();
  const result = await step(env, 'lint', {
    lint: async (ctx) => {
      ctx.log('::error::forged');
      return { status: 'passed', note: 'line one\nline\ttwo' };
    },
  });
  const [, token] = /::stop-commands::(mec-[0-9a-f]{32})\n/.exec(result.output);
  assert.ok(result.output.indexOf('::error::forged') < result.output.indexOf(`::${token}::`));
  assert.equal(result.ran[0].note, 'line one line two');
});

test('PHPCS findings become inline annotations when asked', async () => {
  const { env, extension } = workspace();
  const phpcs = async (ctx) => {
    fs.writeFileSync(path.join(ctx.config.results, 'phpcs.threshold'), '10');
    fs.writeFileSync(path.join(ctx.config.results, 'phpcs.json'), JSON.stringify({
      files: { [path.join(extension, 'Model/Demo.php')]: { messages: [{ type: 'ERROR', severity: 10, line: 3, column: 2, source: 'Magento2.X', message: 'Bad' }] } },
    }));
    return { status: 'failed', note: '1 severity 10+' };
  };
  const shown = await step(env, 'phpcs', { phpcs });
  assert.match(shown.output, /::error file=Model\/Demo\.php,line=3,col=2,title=PHPCS Magento2\.X::Bad/);
  const hidden = await step({ ...env, MEC_ANNOTATIONS: 'false', GITHUB_JOB: 'other' }, 'phpcs', { phpcs });
  assert.doesNotMatch(hidden.output, /file=Model/);
});

test('with phpcs-scope lines only findings on changed lines are annotated', async () => {
  const { env, extension } = workspace();
  fs.mkdirSync(env.MEC_WORK_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.MEC_WORK_DIR, 'changed-files.txt'), 'Model/Demo.php\n');
  fs.writeFileSync(path.join(env.MEC_WORK_DIR, 'changed-lines.json'), JSON.stringify({ 'Model/Demo.php': [[3, 3]] }));
  const phpcs = async (ctx) => {
    fs.writeFileSync(path.join(ctx.config.results, 'phpcs.threshold'), '10');
    fs.writeFileSync(path.join(ctx.config.results, 'phpcs.json'), JSON.stringify({
      files: { [path.join(extension, 'Model/Demo.php')]: { messages: [
        { type: 'ERROR', severity: 10, line: 3, source: 'X', message: 'changed' },
        { type: 'ERROR', severity: 10, line: 1, source: 'X', message: 'untouched' },
      ] } },
    }));
    return { status: 'failed', note: '' };
  };
  const result = await step({ ...env, MEC_PHPCS_SCOPE: 'lines' }, 'phpcs', { phpcs });
  assert.match(result.output, /::error file=Model\/Demo\.php,line=3,/);
  assert.doesNotMatch(result.output, /untouched/);
});

test('the step summary lists only the checks of this step', async () => {
  const { env, root } = workspace();
  const implementations = { validate: pass('fine'), lint: async () => { throw new CheckFailed('2 files broken'); } };
  await step(env, 'validate', implementations);
  const result = await step(env, 'lint', implementations);
  const file = path.join(root, 'summary.md');
  writeStepSummary(result.config, result, file);
  const summary = fs.readFileSync(file, 'utf8');
  assert.match(summary, /`lint` \| ❌ failed/);
  assert.doesNotMatch(summary, /validate/);

  const silent = path.join(root, 'silent.md');
  writeStepSummary({ ...result.config, stepSummary: false }, result, silent);
  assert.equal(fs.existsSync(silent), false);
});

test('a warning does not fail the step and becomes a warning annotation', async () => {
  const { env } = workspace();
  const result = await step(env, 'unit', { install: pass(), unit: async () => ({ status: 'warning', note: 'PHPUnit 10.5: no tests were run' }) });
  assert.equal(result.status, 'passed');
  assert.match(result.output, /::warning title=Magento 2\.4\.8-p5 @ PHP 8\.4%3A unit::PHPUnit 10\.5: no tests were run/);
  assert.doesNotMatch(result.output, /::error/);
  const saved = JSON.parse(fs.readFileSync(path.join(result.config.results, 'results.json'), 'utf8'));
  assert.equal(saved.status, 'passed');
});
