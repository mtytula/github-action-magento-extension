'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CheckFailed } = require('../errors');
const { toolPackages, readComposer, installTools } = require('../tools');
const { phpstanTotals, firstVersion } = require('../reports');
const { resolveToolConfig, workspaceFile } = require('./tool-config');

function defaultConfiguration({ extensionNeon, baseline, includes = [], level, work, extension }) {
  return [
    'includes:',
    `    - ${extensionNeon}`,
    ...(baseline ? [`    - ${baseline}`] : []),
    ...includes.map((file) => `    - ${file}`),
    'parameters:',
    `    level: ${level}`,
    `    tmpDir: ${work}/phpstan-tmp`,
    '    paths:',
    `        - ${extension}`,
    '    excludePaths:',
    '        analyseAndScan:',
    `            - ${extension}/vendor/* (?)`,
    '',
  ].join('\n');
}

/**
 * Files of the `phpstan-includes` input, which extend only the default configuration.
 *
 * @param {?string} usedConfiguration label of a repository or configured file in use, null for the default
 * @returns {{files: string[], label: string}}
 */
function resolveIncludes(config, usedConfiguration) {
  const requested = config.phpstan.includes || [];
  if (requested.length === 0) {
    return { files: [], label: '' };
  }
  if (usedConfiguration) {
    throw new CheckFailed(`phpstan includes extend the default configuration, but ${usedConfiguration} is used`);
  }
  const files = requested.map((item) => {
    const file = workspaceFile(config.workspace, item);
    if (!file) {
      throw new CheckFailed(`include '${item}' does not exist in the workspace`);
    }
    return file;
  });
  return { files, label: ` + includes ${requested.join(', ')}` };
}

function analyse(ctx, binary, configuration, options) {
  const { magentoRoot } = ctx.config;
  return ctx.sh.exec(binary, ['analyse', '--no-progress', '--memory-limit=-1', `--configuration=${configuration}`,
    `--autoload-file=${path.join(magentoRoot, 'vendor', 'autoload.php')}`, ...options.args], { cwd: magentoRoot, allowFailure: true, ...options.exec });
}

/**
 * An older Magento extension for PHPStan may not cope with a newer PHP or Magento. A two-line
 * probe tells whether generated classes and the classes of Magento's test framework resolve.
 */
async function resolvesGeneratedClasses(ctx, binary, extensionNeon) {
  const probe = path.join(ctx.config.work, 'phpstan-probe');
  fs.rmSync(probe, { recursive: true, force: true });
  fs.mkdirSync(probe, { recursive: true });
  fs.writeFileSync(path.join(probe, 'probe.php'),
    '<?php\nfunction magentoExtensionCheckProbe(\\Magento\\Framework\\DataObjectFactory $factory, \\Magento\\TestFramework\\Helper\\Bootstrap $bootstrap): void\n{\n}\n');
  fs.writeFileSync(path.join(probe, 'phpstan.neon'),
    `includes:\n    - ${extensionNeon}\nparameters:\n    level: 2\n    tmpDir: ${probe}/tmp\n    paths:\n        - ${probe}/probe.php\n`);
  const result = await analyse(ctx, binary, path.join(probe, 'phpstan.neon'), { args: ['--error-format=raw'], exec: { echo: false } });
  return result.code === 0;
}

async function phpstan(ctx) {
  const { config } = ctx;
  const resolved = resolveToolConfig(ctx, config.phpstan.config, ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon']);
  let configuration = resolved.file;
  let label = resolved.label;
  const includes = resolveIncludes(config, configuration ? label : null);

  // Order of preference: the versions the extension asks for, then PHPStan as the Magento release
  // under test resolves it (with the Magento extension that fits that PHPStan), then current releases.
  const defaults = ['phpstan/phpstan', 'bitexpert/phpstan-magento'];
  const standalone = async () => {
    const installed = await installTools(ctx, 'phpstan', defaults);
    return {
      binary: path.join(installed.directory, 'vendor', 'bin', 'phpstan'),
      extensionNeon: path.join(installed.directory, 'vendor', 'bitexpert', 'phpstan-magento', 'extension.neon'),
      toolsLabel: installed.source,
    };
  };
  const fromRelease = path.join(config.magentoRoot, 'vendor', 'bin', 'phpstan');
  let tools;
  if (toolPackages(readComposer(config.extension), 'phpstan').length === 0 && fs.existsSync(fromRelease)
    && (await ctx.sh.exec('composer', [`--working-dir=${config.magentoRoot}`, 'require', '--dev', '--no-progress', '--no-audit', '--quiet',
      'bitexpert/phpstan-magento'], { allowFailure: true })).code === 0) {
    tools = {
      binary: fromRelease,
      extensionNeon: path.join(config.magentoRoot, 'vendor', 'bitexpert', 'phpstan-magento', 'extension.neon'),
      toolsLabel: `from Magento ${config.magentoVersion}`,
    };
    if (!(await resolvesGeneratedClasses(ctx, tools.binary, tools.extensionNeon))) {
      ctx.log(`PHPStan from Magento ${config.magentoVersion} does not resolve generated or test framework classes with the extension it allows; using current releases.`);
      tools = await standalone();
      tools.toolsLabel = "current releases; the release's own could not resolve generated or test framework classes";
    }
  } else {
    tools = await standalone();
  }
  const versions = `PHPStan ${firstVersion((await ctx.sh.exec(tools.binary, ['--version', '--no-ansi'], { echo: false })).stdout)}`;
  ctx.log(`${versions} (${tools.toolsLabel})`);

  if (!configuration) {
    let baseline = null;
    if (config.phpstan.baseline) {
      baseline = workspaceFile(config.workspace, config.phpstan.baseline);
      if (!baseline) {
        throw new CheckFailed(`baseline '${config.phpstan.baseline}' does not exist in the workspace`);
      }
      label += ` with baseline ${config.phpstan.baseline}`;
    }
    configuration = path.join(config.work, 'phpstan.neon');
    fs.writeFileSync(configuration, defaultConfiguration({
      extensionNeon: tools.extensionNeon, baseline, includes: includes.files, level: config.phpstan.level, work: config.work, extension: config.extension,
    }));
    label += `${includes.label}, level ${config.phpstan.level}`;
  }

  const report = path.join(config.results, 'phpstan.json');
  const run = await analyse(ctx, tools.binary, configuration, { args: ['--error-format=json'], exec: { stdoutFile: report } });
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(report, 'utf8'));
  } catch {
    parsed = null;
  }
  const totals = phpstanTotals(parsed);
  if (!totals) {
    ctx.log(fs.existsSync(report) ? fs.readFileSync(report, 'utf8') : '');
    fs.rmSync(report, { force: true });
    throw new CheckFailed(`PHPStan configuration could not be loaded (${label})`);
  }
  if (totals.lines.length > 0) {
    ctx.log(totals.lines.join('\n'));
  }
  return { status: run.code === 0 ? 'passed' : 'failed', note: `${label}; ${versions} (${tools.toolsLabel}); ${totals.count} finding(s)` };
}

module.exports = { phpstan, defaultConfiguration, resolveIncludes };
