'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CheckFailed } = require('../errors');
const { phpFiles, unregisteredModules } = require('../extension');
const { toolPackages, readComposer, installTools } = require('../tools');
const { phpcsTotals, firstVersion } = require('../reports');
const { resolveToolConfig } = require('./tool-config');
const { scopeFilter } = require('../scope');

async function validate(ctx) {
  const { extension, extensionName } = ctx.config;
  await ctx.sh.exec('composer', ['validate', '--no-check-lock', `--working-dir=${extension}`]);
  if (ctx.modules.length === 0) {
    const type = readComposer(extension).type || 'library';
    if (type === 'magento2-module') {
      throw new CheckFailed('no etc/module.xml declaring a module was found');
    }
    return { status: 'passed', note: `${extensionName} is a ${type} package and declares no module` };
  }
  const missing = unregisteredModules(extension, ctx.modules);
  if (missing.length > 0) {
    throw new CheckFailed(`no registration.php registers: ${missing.join(' ')}`);
  }
  return { status: 'passed', note: `${extensionName} registers ${ctx.modules.join(' ')}` };
}

async function lint(ctx) {
  const files = phpFiles(ctx.config.extension);
  if (files.length === 0) {
    return { status: 'skipped', note: 'no PHP files found' };
  }
  let broken = 0;
  let crashed = null;
  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
      // Without php.ini: a syntax check needs no extension, and a faulty one cannot get in its way.
      const result = await ctx.sh.exec('php', ['-n', '-l', file], { echo: false, allowFailure: true });
      if (result.code === 0) {
        continue;
      }
      if (/(Parse|Fatal) error|Errors parsing/i.test(result.output)) {
        broken += 1;
        ctx.log(result.output.trim());
      } else {
        crashed = crashed || `php -l stopped with exit code ${result.code} on ${file}`;
        ctx.log(`${crashed}\n${result.output.trim()}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  if (crashed) {
    throw new CheckFailed(`PHP itself failed, which says nothing about the code: ${crashed}`);
  }
  if (broken > 0) {
    throw new CheckFailed(`${broken} of ${files.length} files have syntax errors`);
  }
  return { status: 'passed', note: `${files.length} files` };
}

async function phpcs(ctx) {
  const { config } = ctx;
  const { file: ruleset, label } = resolveToolConfig(ctx, config.phpcs.config, ['.phpcs.xml', 'phpcs.xml', '.phpcs.xml.dist', 'phpcs.xml.dist']);
  const standard = ruleset || path.join(__dirname, '..', '..', 'defaults', 'phpcs.xml');
  // The action default fails at severity 10 as Adobe's Marketplace review does; a repository
  // ruleset decides for itself what is an error.
  const threshold = config.phpcs.severity || (ruleset ? 'errors' : '10');
  fs.writeFileSync(path.join(config.results, 'phpcs.threshold'), threshold);

  let files;
  let scope = 'every file';
  if (['changed', 'lines'].includes(config.phpcs.scope) && ctx.changed) {
    scope = 'changed files';
    files = [...ctx.changed]
      .filter((file) => /\.(php|phtml)$/.test(file))
      .map((file) => path.join(config.workspace, file))
      .filter((file) => file.startsWith(config.extension + path.sep) && fs.existsSync(file));
    if (files.length === 0) {
      return { status: 'skipped', note: 'no PHP file changed' };
    }
  } else {
    files = phpFiles(config.extension);
    if (files.length === 0) {
      return { status: 'skipped', note: 'no PHP files found' };
    }
  }
  const list = path.join(config.work, 'phpcs-files.txt');
  fs.writeFileSync(list, `${files.join('\n')}\n`);

  // Order of preference: the versions the extension asks for, then the ones the Magento release
  // under test resolves, then current releases.
  const fromRelease = path.join(config.magentoRoot, 'vendor', 'bin', 'phpcs');
  let binary;
  let toolsRoot;
  let toolsLabel;
  if (toolPackages(readComposer(config.extension), 'phpcs').length === 0 && fs.existsSync(fromRelease)) {
    binary = fromRelease;
    toolsRoot = config.magentoRoot;
    toolsLabel = `from Magento ${config.magentoVersion}`;
  } else {
    const installed = await installTools(ctx, 'phpcs', ['magento/magento-coding-standard']);
    binary = path.join(installed.directory, 'vendor', 'bin', 'phpcs');
    toolsRoot = installed.directory;
    toolsLabel = installed.source;
  }
  const version = firstVersion((await ctx.sh.exec(binary, ['--version'], { echo: false })).stdout);
  const standardInfo = await ctx.sh.exec('composer', [`--working-dir=${toolsRoot}`, 'show', '--no-ansi', 'magento/magento-coding-standard'], { echo: false, allowFailure: true });
  const standardVersion = (/^versions\s*:.*?(\S+)\s*$/m.exec(standardInfo.stdout) || [])[1] || 'unknown';
  const versions = `PHPCS ${version}, coding standard ${standardVersion}`;
  ctx.log(`${versions} (${toolsLabel})`);

  const report = path.join(config.results, 'phpcs.json');
  await ctx.sh.exec(binary, ['-d', 'memory_limit=-1', `--standard=${standard}`, '-s', `--file-list=${list}`, '--report-full', `--report-json=${report}`],
    { cwd: config.extension, allowFailure: true });
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch {
    parsed = null;
  }
  const filter = config.phpcs.scope === 'lines' ? scopeFilter(ctx, 'lines') : { scope: config.phpcs.scope, prefix: '', keep: () => true };
  const totals = phpcsTotals(parsed, threshold, filter.keep);
  if (!totals) {
    throw new CheckFailed(`PHPCS configuration could not be loaded (${label})`);
  }
  const rule = threshold === 'errors' ? 'errors' : `severity ${threshold}+`;
  return phpcsOutcome(totals, { prefix: filter.prefix, lines: filter.scope === 'lines', summary: `${label}; ${versions} (${toolsLabel}); ${files.length} ${scope}`, rule });
}

/** Status and note of PHPCS from its totals. */
function phpcsOutcome(totals, { prefix, lines, summary, rule }) {
  const counts = lines
    ? `${totals.failing} ${rule} on changed lines, ${totals.outside} elsewhere in changed files, ${totals.other} other`
    : `${totals.failing} ${rule}, ${totals.other} other`;
  return { status: totals.failing === 0 ? 'passed' : 'failed', note: `${prefix}${summary}: ${counts}` };
}

module.exports = { validate, lint, phpcs, phpcsOutcome };
