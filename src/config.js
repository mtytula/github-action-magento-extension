'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ConfigError } = require('./errors');
const { selectChecks } = require('./plan');

const PACKAGE_NAME = /^[a-z0-9]([_.-]?[a-z0-9]+)*\/[a-z0-9]([_.-]?[a-z0-9]+)*$/;

/**
 * Parses the `composer-repositories` input: a JSON list in the format of Composer's own
 * `repositories` section. Returns null when the input is empty.
 */
function parseRepositories(raw) {
  if (raw.trim() === '') {
    return null;
  }
  let list;
  try {
    list = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`composer-repositories is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(list) || list.length === 0) {
    throw new ConfigError('composer-repositories must be a JSON list with at least one repository.');
  }
  for (const entry of list) {
    const isObject = entry !== null && typeof entry === 'object' && !Array.isArray(entry);
    const disables = isObject && Object.keys(entry).length > 0 && Object.values(entry).every((value) => value === false);
    const describes = isObject && typeof entry.type === 'string' && (typeof entry.url === 'string' || entry.type === 'package');
    if (!disables && !describes) {
      throw new ConfigError('Every entry of composer-repositories must be a repository with "type" and "url", or a switch such as {"packagist.org": false}.');
    }
  }
  return list;
}

function requireMatch(value, pattern, message) {
  if (!pattern.test(value)) {
    throw new ConfigError(message);
  }
  return value;
}

/**
 * Reads and validates the inputs the action passes as MEC_* environment variables.
 */
function readConfig(env, { phpRuntime = '' } = {}) {
  const value = (name, fallback = '') => (env[name] === undefined || env[name] === '' ? fallback : String(env[name]));

  const installedMinor = (/^[0-9]+\.[0-9]+/.exec(phpRuntime) || [''])[0];
  const phpVersion = requireMatch(value('MEC_PHP_VERSION', installedMinor), /^[0-9]+\.[0-9]+$/,
    `php-version must be a minor such as 8.4, got '${value('MEC_PHP_VERSION')}'.`);
  if (installedMinor && installedMinor !== phpVersion) {
    throw new ConfigError(`php-version is ${phpVersion}, but the job has PHP ${phpRuntime}. Set up PHP ${phpVersion} before this action; see "Setting up PHP" in the README.`);
  }
  const magentoVersion = requireMatch(value('MEC_MAGENTO_VERSION'), /^([0-9]+\.[0-9]+\.[0-9]+(-p[0-9]+)?)?$/,
    `magento-version must be a release such as 2.4.8-p5, got '${value('MEC_MAGENTO_VERSION')}'.`);

  const workspace = fs.realpathSync(value('GITHUB_WORKSPACE', process.cwd()));
  const relativePath = value('MEC_PATH', '.');
  let extension;
  try {
    extension = fs.realpathSync(path.resolve(workspace, relativePath));
  } catch {
    throw new ConfigError(`path '${relativePath}' does not exist in the workspace.`);
  }
  if (extension !== workspace && !extension.startsWith(workspace + path.sep)) {
    throw new ConfigError('path must stay inside the workspace.');
  }
  if (!fs.existsSync(path.join(extension, 'composer.json'))) {
    throw new ConfigError(`No composer.json in '${relativePath}'.`);
  }
  let extensionName = '';
  try {
    extensionName = String(JSON.parse(fs.readFileSync(path.join(extension, 'composer.json'), 'utf8')).name || '');
  } catch {
    extensionName = '';
  }

  const config = {
    phpVersion,
    magentoVersion,
    workspace,
    extension,
    extensionName,
    checks: selectChecks(value('MEC_CHECKS', 'default'), magentoVersion),
    work: path.resolve(value('MEC_WORK_DIR', path.join(workspace, '.magento-extension-check'))),
    repositories: parseRepositories(value('MEC_COMPOSER_REPOSITORIES', value('MAGENTO_EXTENSION_CHECK_COMPOSER_REPOSITORIES')))
      || [{ type: 'composer', url: 'https://mirror.mage-os.org/' }],
    customRepositories: value('MEC_COMPOSER_REPOSITORIES', value('MAGENTO_EXTENSION_CHECK_COMPOSER_REPOSITORIES')).trim() !== '',
    phpcs: {
      severity: requireMatch(value('MEC_PHPCS_SEVERITY'), /^[0-9]*$/, 'phpcs-severity must be a whole number.'),
      scope: requireMatch(value('MEC_PHPCS_SCOPE', 'changed'), /^(changed|all|lines)$/, 'phpcs-scope must be changed, all or lines.'),
      config: value('MEC_PHPCS_CONFIG'),
    },
    phpstan: {
      level: requireMatch(value('MEC_PHPSTAN_LEVEL', '1'), /^([0-9]|10|max)$/, 'phpstan-level must be 0-10 or max.'),
      scope: requireMatch(value('MEC_PHPSTAN_SCOPE', 'all'), /^(all|changed|lines)$/, 'phpstan-scope must be all, changed or lines.'),
      config: value('MEC_PHPSTAN_CONFIG'),
      baseline: value('MEC_PHPSTAN_BASELINE'),
      includes: value('MEC_PHPSTAN_INCLUDES').split(/[,\n]/).map((item) => item.trim()).filter(Boolean),
    },
    annotations: requireMatch(value('MEC_ANNOTATIONS', 'true'), /^(true|false)$/, 'annotations must be true or false.') === 'true',
    testdox: requireMatch(value('MEC_PHPUNIT_TESTDOX', 'false'), /^(true|false)$/, 'testdox must be true or false.') === 'true',
    locales: requireMatch(value('MEC_LOCALES', 'en_US'), /^[A-Za-z_]+( [A-Za-z_]+)*$/,
      "locales must be a space-separated list such as 'en_US de_DE'.").split(' '),
    database: {
      host: value('MEC_DB_HOST', '127.0.0.1'),
      port: requireMatch(value('MEC_DB_PORT', '3306'), /^[0-9]+$/, 'db-port must be a number.'),
      user: value('MEC_DB_USER', 'root'),
      password: value('MEC_DB_PASSWORD'),
      name: requireMatch(value('MEC_DB_NAME', 'magento_integration_tests'), /^[A-Za-z0-9_]+$/, 'db-name may hold letters, digits and underscores only.'),
    },
    search: {
      engine: requireMatch(value('MEC_SEARCH_ENGINE', 'opensearch'), /^(opensearch|elasticsearch7|elasticsearch8)$/,
        'search-engine must be opensearch, elasticsearch7 or elasticsearch8.'),
      host: value('MEC_SEARCH_HOST', '127.0.0.1'),
      port: requireMatch(value('MEC_SEARCH_PORT', '9200'), /^[0-9]+$/, 'search-port must be a number.'),
    },
    stepSummary: value('MAGENTO_EXTENSION_CHECK_SUMMARY', 'true') !== 'false',
    job: `${value('GITHUB_RUN_ID', '0')}-${value('GITHUB_RUN_ATTEMPT', '0')}-${value('GITHUB_JOB', 'job')}`,
  };
  if (!PACKAGE_NAME.test(extensionName)) {
    throw new ConfigError('composer.json has no valid package name.');
  }
  config.results = path.join(config.work, 'results');
  config.magentoRoot = path.join(config.work, 'magento');
  config.tools = path.join(config.work, 'tools');
  config.label = magentoVersion ? `Magento ${magentoVersion} @ PHP ${phpVersion}` : `PHP ${phpVersion}`;
  return config;
}

module.exports = { readConfig, parseRepositories, PACKAGE_NAME };
