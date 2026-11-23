'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readConfig } = require('../src/config');
const { workspace } = require('./helpers');

test('reads a valid configuration with defaults', () => {
  const { env, extension } = workspace();
  const config = readConfig(env);
  assert.equal(config.extension, extension);
  assert.equal(config.extensionName, 'acme/module-demo');
  assert.equal(config.label, 'Magento 2.4.8-p5 @ PHP 8.4');
  assert.equal(config.results, path.join(env.MEC_WORK_DIR, 'results'));
  assert.deepEqual(config.locales, ['en_US']);
  assert.equal(config.phpcs.scope, 'changed');
  assert.equal(config.annotations, true);
  assert.equal(config.testdox, false);
  assert.equal(config.stepSummary, true);
});

test('phpstan-includes is a list split on commas or new lines', () => {
  const { env } = workspace();
  assert.deepEqual(readConfig(env).phpstan.includes, []);
  assert.deepEqual(readConfig({ ...env, MEC_PHPSTAN_INCLUDES: 'a.neon, b.neon\n\n c.neon\n' }).phpstan.includes, ['a.neon', 'b.neon', 'c.neon']);
});

test('label without a Magento release names PHP only', () => {
  const { env } = workspace();
  assert.equal(readConfig({ ...env, MEC_MAGENTO_VERSION: '', MEC_CHECKS: 'validate' }).label, 'PHP 8.4');
});

for (const [name, override, message] of [
  ['php version', { MEC_PHP_VERSION: '8' }, /php-version/],
  ['magento version', { MEC_MAGENTO_VERSION: '2.4' }, /magento-version/],
  ['severity', { MEC_PHPCS_SEVERITY: 'high' }, /phpcs-severity/],
  ['level', { MEC_PHPSTAN_LEVEL: '11' }, /phpstan-level/],
  ['scope', { MEC_PHPCS_SCOPE: 'some' }, /phpcs-scope/],
  ['annotations', { MEC_ANNOTATIONS: 'yes' }, /annotations/],
  ['testdox', { MEC_PHPUNIT_TESTDOX: '1' }, /testdox/],
  ['locales', { MEC_LOCALES: 'en_US; rm -rf /' }, /locales/],
  ['database name', { MEC_DB_NAME: 'a`b' }, /db-name/],
  ['search engine', { MEC_SEARCH_ENGINE: 'solr' }, /search-engine/],
  ['path outside the workspace', { MEC_PATH: '..' }, /inside the workspace/],
  ['missing path', { MEC_PATH: 'nope' }, /does not exist/],
]) {
  test(`refuses an invalid ${name}`, () => {
    const { env } = workspace();
    assert.throws(() => readConfig({ ...env, ...override }), message);
  });
}

test('php-version is checked against the PHP of the job, and taken from it when empty', () => {
  const { env } = workspace();
  assert.equal(readConfig(env, { phpRuntime: '8.4.12' }).phpVersion, '8.4');
  assert.equal(readConfig({ ...env, MEC_PHP_VERSION: '' }, { phpRuntime: '8.3.30' }).phpVersion, '8.3');
  assert.throws(() => readConfig(env, { phpRuntime: '8.3.30' }), /php-version is 8\.4, but the job has PHP 8\.3\.30/);
  assert.throws(() => readConfig({ ...env, MEC_PHP_VERSION: '' }), /php-version must be a minor/);
});

test('refuses a package without a valid name or composer.json', () => {
  assert.throws(() => readConfig(workspace({ 'composer.json': '{"name": "Not Valid"}' }).env), /valid package name/);
  assert.throws(() => readConfig(workspace({ 'composer.json': null }).env), /No composer.json/);
});

test('the public Magento mirror is the default repository', () => {
  const config = readConfig(workspace().env);
  assert.deepEqual(config.repositories, [{ type: 'composer', url: 'https://mirror.mage-os.org/' }]);
  assert.equal(config.customRepositories, false);
});

test('composer-repositories replaces the default, from the input or from the job environment', () => {
  const { env } = workspace();
  const list = [{ type: 'composer', url: 'https://repo.example/acme/' }, { 'packagist.org': false }];
  const fromInput = readConfig({ ...env, MEC_COMPOSER_REPOSITORIES: JSON.stringify(list), MAGENTO_EXTENSION_CHECK_COMPOSER_REPOSITORIES: '[{"type":"composer","url":"https://other.example/"}]' });
  assert.deepEqual(fromInput.repositories, list);
  assert.equal(fromInput.customRepositories, true);
  const fromJob = readConfig({ ...env, MAGENTO_EXTENSION_CHECK_COMPOSER_REPOSITORIES: JSON.stringify(list) });
  assert.deepEqual(fromJob.repositories, list);
});

for (const [name, raw] of [
  ['broken JSON', '[{'],
  ['an object', '{"type":"composer","url":"https://repo.example/"}'],
  ['an empty list', '[]'],
  ['an entry without a URL', '[{"type":"composer"}]'],
  ['a string entry', '["https://repo.example/"]'],
  ['an enabling switch', '[{"packagist.org": true}]'],
]) {
  test(`refuses composer-repositories with ${name}`, () => {
    const { env } = workspace();
    assert.throws(() => readConfig({ ...env, MEC_COMPOSER_REPOSITORIES: raw }), /composer-repositories/);
  });
}

test('step summaries can be turned off', () => {
  const { env } = workspace();
  assert.equal(readConfig({ ...env, MAGENTO_EXTENSION_CHECK_SUMMARY: 'false' }).stepSummary, false);
});
