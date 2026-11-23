'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CheckFailed } = require('../errors');
const { withExtension, templateRepositoryUrl } = require('../project');
const { mirrorDirectory, differences } = require('../copy');

const HELPERS = path.join(__dirname, '..', 'php');

function magento(ctx, args, options = {}) {
  return ctx.sh.exec('php', ['-d', 'memory_limit=-1', 'bin/magento', ...args, '--no-ansi'], { cwd: ctx.config.magentoRoot, ...options });
}

const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$/;

/**
 * The version the checkout is installed as: none, the `package-version` input, or the nearest tag.
 * A dependency that requires the extension at `^1.0` cannot resolve against a `dev-` version.
 */
async function resolvePackageVersion(ctx) {
  const requested = ctx.config.packageVersion;
  if (requested !== 'tag') {
    return requested;
  }
  const described = await ctx.sh.exec('git', ['-C', ctx.config.extension, 'describe', '--tags', '--abbrev=0'], { echo: false, allowFailure: true });
  if (described.code !== 0) {
    throw new CheckFailed('package-version tag needs the tags in the checkout; use fetch-depth: 0 in actions/checkout');
  }
  const tag = described.stdout.trim();
  const version = tag.replace(/^v/, '');
  if (!VERSION.test(version)) {
    throw new CheckFailed(`package-version tag: the nearest tag '${tag}' is not a version such as 1.4.0`);
  }
  return version;
}

async function install(ctx) {
  const { config } = ctx;
  const { magentoRoot: root, extension, extensionName, repositories } = config;
  const version = await resolvePackageVersion(ctx);
  const template = templateRepositoryUrl(repositories);
  await ctx.sh.exec('composer', ['create-project', '--no-install', '--no-progress', ...(template ? [`--repository-url=${template}`] : []),
    `magento/project-community-edition=${config.magentoVersion}`, root]);
  fs.mkdirSync(path.join(root, 'app', 'etc'), { recursive: true });
  const composerFile = path.join(root, 'composer.json');
  const project = withExtension(JSON.parse(fs.readFileSync(composerFile, 'utf8')), extension, extensionName, repositories, version);
  fs.writeFileSync(composerFile, `${JSON.stringify(project, null, 4)}\n`);

  // Old release lines carry dependencies with published advisories; Composer would refuse to
  // resolve them, which says nothing about the extension under test.
  await ctx.sh.exec('composer', ['config', 'audit.block-insecure', 'false'], { cwd: root });
  await ctx.sh.exec('composer', ['update', '--no-progress', '--no-audit'], { cwd: root });

  const shown = await ctx.sh.exec('composer', ['show', '--path', extensionName], { cwd: root, echo: false });
  const installed = fs.realpathSync(shown.stdout.trim().split(/\s+/)[1] || '');
  if (!installed.startsWith(path.join(fs.realpathSync(root), 'vendor') + path.sep)) {
    throw new CheckFailed(`Composer installed ${extensionName} at an unexpected place: ${installed}`);
  }
  // Composer leaves out what .gitattributes marks export-ignore, which usually includes the tests.
  // The checks are about the checkout, so the copy is completed from it.
  mirrorDirectory(extension, installed);
  const different = differences(extension, installed);
  if (different.length > 0) {
    ctx.log(different.join('\n'));
    throw new CheckFailed(`the installed ${extensionName} is not identical to the checkout`);
  }

  const registrar = 'require $argv[1] . "/vendor/autoload.php";'
    + '$path = (new \\Magento\\Framework\\Component\\ComponentRegistrar())->getPath("module", $argv[2]);'
    + 'echo $path ? realpath($path) : "";';
  for (const module of ctx.modules) {
    const registered = (await ctx.sh.exec('php', ['-r', registrar, root, module], { echo: false })).stdout.trim();
    if (registered !== installed && !registered.startsWith(installed + path.sep)) {
      throw new CheckFailed(`${module} is not registered from the checkout (found: ${registered || 'nowhere'})`);
    }
  }
  fs.writeFileSync(path.join(config.work, 'installed-path'), installed);

  const product = await ctx.sh.exec('composer', ['show', 'magento/product-community-edition'], { cwd: root, echo: false });
  ctx.log(product.stdout.split('\n').filter((line) => line.startsWith('versions')).join('\n'));
  const composerVersion = (await ctx.sh.exec('composer', ['--version', '--no-ansi'], { echo: false })).stdout.split(/\s+/)[2];
  return { status: 'passed', note: `Composer ${composerVersion}, ${extensionName} installed as an exact copy of the checkout${version ? `, as version ${version}` : ''}` };
}

async function enableModules(ctx) {
  const enabled = await magento(ctx, ['module:enable', '--all'], { echo: false, allowFailure: true });
  if (enabled.code !== 0) {
    ctx.log(enabled.output.trim());
    throw new CheckFailed(firstError(enabled.output, 'bin/magento module:enable stops with an error'));
  }
  ctx.log(enabled.output.trim().split('\n').slice(-3).join('\n'));
}

function firstError(output, prefix) {
  const line = output.split('\n').find((candidate) => /fatal|error|exception/i.test(candidate)) || '';
  return `${prefix}: ${line.trim().slice(0, 180)}`;
}

async function compile(ctx) {
  await enableModules(ctx);
  for (const module of ctx.modules) {
    const status = await magento(ctx, ['module:status', module], { echo: false, allowFailure: true });
    if (status.code !== 0) {
      ctx.log(status.output.trim());
      throw new CheckFailed(firstError(status.output, 'bin/magento stops with an error once the extension is enabled'));
    }
    if (!/enabled/i.test(status.output)) {
      throw new CheckFailed(`${module} is not enabled`);
    }
  }
  await magento(ctx, ['setup:di:compile']);
  return { status: 'passed', note: ctx.modules.length > 0 ? `no database; enabled: ${ctx.modules.join(' ')}` : 'no database' };
}

async function staticContent(ctx) {
  const { config } = ctx;
  if (!fs.existsSync(path.join(config.magentoRoot, 'app', 'etc', 'config.php'))) {
    await enableModules(ctx);
  }
  await ctx.sh.exec('php', [path.join(HELPERS, 'static-content-config.php'), config.magentoRoot]);
  await magento(ctx, ['setup:static-content:deploy', '--force', '--jobs=4', ...config.locales]);
  return { status: 'passed', note: `no database; locales: ${config.locales.join(' ')}` };
}

module.exports = { install, compile, staticContent, resolvePackageVersion, HELPERS };
