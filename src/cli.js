#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./errors');
const { readConfig, composerCacheMode } = require('./config');
const { runChecks, writeStepSummary } = require('./run');
const { detectPrepared } = require('./workdir');
const { changedFiles } = require('./changed-files');
const { changedLines, runGit } = require('./changed-lines');

function output(values) {
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''));
  }
}

/**
 * The actions do not install PHP or Composer; the job provides them.
 */
function toolVersion(command, args, name) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    throw new ConfigError(`${name} is not on the PATH. Set it up before this action; see "Setting up PHP" in the README.`);
  }
}

function job(env) {
  return `${env.GITHUB_RUN_ID || '0'}-${env.GITHUB_RUN_ATTEMPT || '0'}-${env.GITHUB_JOB || 'job'}`;
}

const commands = {
  async run() {
    const phpRuntime = toolVersion('php', ['-r', 'echo PHP_VERSION;'], 'PHP');
    const composer = toolVersion('composer', ['--version', '--no-ansi'], 'Composer');
    if (!/^Composer version 2\./m.test(composer)) {
      throw new ConfigError(`Composer 2 is needed, found: ${composer.split('\n')[0]}`);
    }
    const config = readConfig(process.env, { phpRuntime });
    process.env.COMPOSER_NO_INTERACTION = '1';
    process.env.COMPOSER_MEMORY_LIMIT = '-1';
    process.env.COMPOSER_ALLOW_SUPERUSER = '1';
    const result = await runChecks(config, require('./checks'), { phpRuntime });
    writeStepSummary(config, result, process.env.GITHUB_STEP_SUMMARY);
    output({ status: result.status, 'result-path': config.results });
    return result.status === 'passed' ? 0 : 1;
  },

  async prepare() {
    const env = process.env;
    composerCacheMode(env.MEC_COMPOSER_CACHE);
    const phpRuntime = toolVersion('php', ['-r', 'echo PHP_VERSION;'], 'PHP');
    toolVersion('composer', ['--version', '--no-ansi'], 'Composer');
    const prepared = detectPrepared({ work: env.MEC_WORK_DIR, job: job(env), cacheId: env.MEC_CACHE_ID });
    output({ ...prepared, 'php-version': phpRuntime.split('.').slice(0, 2).join('.') });
    return 0;
  },

  async 'changed-files'() {
    const env = process.env;
    const target = path.join(env.MEC_WORK_DIR, 'changed-files.txt');
    const linesTarget = path.join(env.MEC_WORK_DIR, 'changed-lines.json');
    fs.mkdirSync(env.MEC_WORK_DIR, { recursive: true });
    fs.rmSync(target, { force: true });
    fs.rmSync(linesTarget, { force: true });
    let event = {};
    try {
      event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
    } catch {
      event = {};
    }
    const source = {
      event,
      repository: env.GITHUB_REPOSITORY,
      api: (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, ''),
      token: env.MEC_TOKEN,
    };
    const lines = await changedLines({ ...source, git: runGit(env.GITHUB_WORKSPACE || '.') });
    if (lines !== null) {
      fs.writeFileSync(linesTarget, JSON.stringify(lines));
    }
    const files = await changedFiles(source);
    if (files === null) {
      console.log('Changed files are not known; checks that depend on them cover every file.');
      return 0;
    }
    fs.writeFileSync(target, files.length > 0 ? `${files.join('\n')}\n` : '');
    console.log(`${files.length} changed file(s)`);
    return 0;
  },
};

async function main() {
  const command = commands[process.argv[2]];
  if (!command) {
    throw new ConfigError(`Unknown command '${process.argv[2]}'.`);
  }
  return command();
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = error instanceof ConfigError ? error.message : `${error.stack || error}`;
    console.log(`::error title=Magento Extension Check::${message.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}`);
    process.exitCode = 1;
  },
);
