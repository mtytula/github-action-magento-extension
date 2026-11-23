'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { moduleNames, phpFiles, unregisteredModules, testDirectories } = require('../src/extension');
const { toolPackages, installTools } = require('../src/tools');
const { withExtension, templateRepositoryUrl } = require('../src/project');
const { junitTotals, phpcsTotals, phpstanTotals, firstVersion } = require('../src/reports');
const { findingsFromReport, annotationLines } = require('../src/annotations');
const { changedFiles } = require('../src/changed-files');
const { recordCheck, overallStatus } = require('../src/results');
const { mirrorDirectory, differences } = require('../src/copy');
const { unitConfiguration, runPhpunit } = require('../src/checks/phpunit');
const { CheckFailed } = require('../src/errors');
const { defaultConfiguration, resolveIncludes } = require('../src/checks/phpstan');
const { resolveToolConfig } = require('../src/checks/tool-config');
const { validate } = require('../src/checks/static');
const { workspace } = require('./helpers');

test('modules, PHP files and test directories of an extension', () => {
  const { extension } = workspace({
    'view/frontend/templates/a.phtml': '<?php ?>',
    'vendor/other/etc/module.xml': '<config><module name="Other_Thing"/></config>',
    'vendor/other/Thing.php': '<?php',
    'Test/Unit/_files/etc/module.xml': '<config><module name="Fixture_Module"/></config>',
    'Test/Unit/DemoTest.php': '<?php',
    'Test/Integration/DemoTest.php': '<?php',
  });
  assert.deepEqual(moduleNames(extension), ['Acme_Demo']);
  assert.deepEqual(phpFiles(extension).map((file) => path.relative(extension, file)), [
    'Model/Demo.php', 'Test/Integration/DemoTest.php', 'Test/Unit/DemoTest.php', 'registration.php', 'view/frontend/templates/a.phtml',
  ]);
  assert.deepEqual(testDirectories(extension, 'Unit'), [path.join(extension, 'Test/Unit')]);
  assert.deepEqual(unregisteredModules(extension, ['Acme_Demo', 'Acme_Missing']), ['Acme_Missing']);
});

test('tool packages come from require-dev and must look like packages', () => {
  const composer = {
    'require-dev': {
      'phpstan/phpstan': '^2.0',
      'bitexpert/phpstan-magento': '~0.44',
      'Slevomat/Coding-Standard': '^8.0',
      'phpunit/phpunit': '^10',
      'acme/phpstan-rules': '1.0; rm -rf /',
    },
  };
  assert.deepEqual(toolPackages(composer, 'phpstan'), ['phpstan/phpstan:^2.0', 'bitexpert/phpstan-magento:~0.44']);
  assert.deepEqual(toolPackages(composer, 'phpcs'), ['slevomat/coding-standard:^8.0']);
  assert.deepEqual(toolPackages({}, 'phpcs'), []);
});

test('the tools directory uses the custom repositories', async () => {
  const { root, extension } = workspace();
  const manifest = async (config) => {
    const directory = path.join(root, 'tools', 'phpcs');
    const sh = {
      exec: async (command, args) => {
        if (args.includes('init')) {
          fs.writeFileSync(path.join(directory, 'composer.json'), '{"name": "x/y"}');
        }
        return { code: 0, stdout: '', output: '' };
      },
    };
    await installTools({ config: { tools: path.join(root, 'tools'), extension, ...config }, sh, log: () => {} }, 'phpcs', ['magento/magento-coding-standard']);
    return JSON.parse(fs.readFileSync(path.join(directory, 'composer.json'), 'utf8'));
  };
  const repositories = [{ type: 'composer', url: 'https://repo.example/acme/' }, { 'packagist.org': false }];
  assert.deepEqual((await manifest({ customRepositories: true, repositories })).repositories, repositories);
  assert.equal((await manifest({ customRepositories: false, repositories })).repositories, undefined);
});

test('tool installs keep the require-dev constraints and fall back to the same packages', async () => {
  const { root, extension } = workspace();
  fs.writeFileSync(path.join(extension, 'composer.json'), JSON.stringify({
    'require-dev': { 'phpstan/phpstan': '^2.1', 'bitexpert/phpstan-magento': '^0.44', 'phpstan/extension-installer': '^1.4' },
  }));
  const install = async (failing) => {
    const requires = [];
    const sh = {
      exec: async (command, args) => {
        const index = args.indexOf('require');
        if (index === -1) {
          return { code: 0, stdout: '', output: '' };
        }
        const packages = args.slice(index + 1).filter((arg) => !arg.startsWith('--'));
        requires.push(packages);
        return { code: requires.length <= failing ? 1 : 0, stdout: '', output: '' };
      },
    };
    const result = await installTools({ config: { tools: path.join(root, 'tools'), extension }, sh, log: () => {} },
      'phpstan', ['phpstan/phpstan', 'bitexpert/phpstan-magento', 'acme/default-only']);
    return { requires, source: result.source };
  };

  const constrained = await install(0);
  assert.deepEqual(constrained.requires, [['phpstan/phpstan:^2.1', 'bitexpert/phpstan-magento:^0.44', 'phpstan/extension-installer:^1.4', 'acme/default-only']]);
  assert.equal(constrained.source, "versions from the extension's require-dev");

  const current = await install(1);
  assert.deepEqual(current.requires[1], ['phpstan/phpstan', 'bitexpert/phpstan-magento', 'phpstan/extension-installer', 'acme/default-only']);
  assert.equal(current.source, "current releases of the extension's require-dev tools");

  const defaults = await install(2);
  assert.deepEqual(defaults.requires[2], ['phpstan/phpstan', 'bitexpert/phpstan-magento', 'acme/default-only']);
  assert.equal(defaults.source, 'action defaults');
});

test('the checkout is the only source of the extension in the project', () => {
  const project = withExtension({ require: { 'magento/product-community-edition': '2.4.9' }, repositories: { old: {} } },
    '/work/ext', 'acme/module-demo', [{ type: 'composer', url: 'https://mirror.example/' }]);
  assert.deepEqual(project.repositories, [
    { type: 'path', url: '/work/ext', options: { symlink: false } },
    { type: 'composer', url: 'https://mirror.example/', exclude: ['acme/module-demo'] },
  ]);
  assert.equal(project.require['acme/module-demo'], '*@dev');
  assert.equal(project.require['magento/product-community-edition'], '2.4.9');
});

test('custom repositories can never provide the extension', () => {
  const repositories = [
    { type: 'composer', url: 'https://repo.example/acme/', exclude: ['other/package'] },
    { type: 'vcs', url: 'https://git.example/x.git', only: ['acme/module-demo', 'acme/library'] },
    { 'packagist.org': false },
  ];
  const project = withExtension({}, '/work/ext', 'acme/module-demo', repositories);
  assert.deepEqual(project.repositories, [
    { type: 'path', url: '/work/ext', options: { symlink: false } },
    { type: 'composer', url: 'https://repo.example/acme/', exclude: ['other/package', 'acme/module-demo'] },
    { type: 'vcs', url: 'https://git.example/x.git', only: ['acme/library'] },
    { 'packagist.org': false },
  ]);
  assert.equal(templateRepositoryUrl(repositories), 'https://repo.example/acme/');
  assert.equal(templateRepositoryUrl([{ type: 'vcs', url: 'https://git.example/x.git' }]), null);
});

test('report parsers', () => {
  assert.deepEqual(junitTotals('<testsuites><testsuite name="" tests="41" assertions="90" errors="1" failures="2"><testsuite tests="3"/>'),
    { tests: 41, assertions: 90, broken: 3 });
  assert.deepEqual(junitTotals(''), { tests: 0, assertions: 0, broken: 0 });

  const phpcs = { files: { a: { messages: [{ type: 'ERROR', severity: 10 }, { type: 'ERROR', severity: 8 }, { type: 'WARNING', severity: 6 }] } } };
  assert.deepEqual(phpcsTotals(phpcs, '10'), { failing: 1, other: 2 });
  assert.deepEqual(phpcsTotals(phpcs, 'errors'), { failing: 2, other: 1 });
  assert.equal(phpcsTotals({ unexpected: true }, '10'), null);

  const phpstan = { totals: { errors: 1, file_errors: 2 }, errors: ['Ignored error pattern'], files: { 'a.php': { messages: [{ line: 4, message: 'Bad' }, { message: 'Worse' }] } } };
  assert.deepEqual(phpstanTotals(phpstan), { count: 3, lines: ['Ignored error pattern', 'a.php:4  Bad', 'a.php:?  Worse'] });
  assert.equal(phpstanTotals(null), null);
  assert.equal(firstVersion('PHP_CodeSniffer version 3.13.6 (stable)'), '3.13.6');
});

test('annotations prefer changed files, respect the budget and limit PHPStan to changed files', () => {
  const { extension } = workspace({ 'Model/Other.php': '<?php' });
  const report = {
    files: {
      [path.join(extension, 'Model/Other.php')]: { messages: [{ type: 'ERROR', severity: 10, line: 1, message: 'other, file: 100%' }] },
      [path.join(extension, 'Model/Demo.php')]: { messages: [{ type: 'WARNING', severity: 6, line: 9, source: 'A.B', message: 'warn' }, { type: 'ERROR', severity: 10, line: 2, message: 'err' }] },
      '/elsewhere/x.php': { messages: [{ type: 'ERROR', severity: 10, line: 1, message: 'outside' }] },
    },
  };
  const options = { workspace: extension, extension, threshold: '10' };
  const findings = findingsFromReport('phpcs', report, options);
  assert.equal(findings.length, 3);

  const changed = new Set(['Model/Demo.php']);
  const all = annotationLines('phpcs', findings, changed, { error: 10, warning: 10 });
  assert.match(all.lines[0], /^::error file=Model\/Demo\.php,line=2,/);
  assert.match(all.lines[1], /^::warning file=Model\/Demo\.php,line=9,title=PHPCS A\.B::warn$/);
  assert.match(all.lines[2], /::other, file: 100%25$/);
  assert.deepEqual(all.budget, { error: 8, warning: 9 });

  const limited = annotationLines('phpcs', findings, changed, { error: 1, warning: 0 });
  assert.equal(limited.lines.length, 2);
  assert.match(limited.lines[1], /Showing 1 of 3 phpcs findings inline/);

  const phpstan = annotationLines('phpstan', findingsFromReport('phpstan', report, options), changed, { error: 10, warning: 10 });
  assert.equal(phpstan.lines.length, 2);
  assert.ok(phpstan.lines.every((line) => line.includes('Model/Demo.php')));
});

test('changed files of a pull request and of a push', async () => {
  const calls = [];
  const request = (pages) => async (url, options) => {
    calls.push([url, options.headers.Authorization]);
    return { ok: true, json: async () => pages.shift() };
  };
  const base = { repository: 'acme/demo', api: 'https://api.example', token: 't' };

  const page = Array.from({ length: 100 }, (_, index) => ({ filename: `f${index}.php`, status: 'modified' }));
  const pull = await changedFiles({ ...base, event: { pull_request: { number: 7 } },
    request: request([page, [{ filename: 'gone.php', status: 'removed' }, { filename: 'new.php', status: 'added' }]]) });
  assert.equal(pull.length, 101);
  assert.ok(pull.includes('new.php') && !pull.includes('gone.php'));
  assert.deepEqual(calls[1], ['https://api.example/repos/acme/demo/pulls/7/files?per_page=100&page=2', 'Bearer t']);

  const push = await changedFiles({ ...base, event: { before: 'a'.repeat(40), after: 'b'.repeat(40) }, request: request([{ files: [{ filename: 'x.php' }] }]) });
  assert.deepEqual(push, ['x.php']);

  assert.equal(await changedFiles({ ...base, event: { before: '0'.repeat(40), after: 'b'.repeat(40) }, request: request([]) }), null);
  assert.equal(await changedFiles({ ...base, event: { pull_request: { number: 7 } }, request: async () => ({ ok: false }) }), null);
  assert.equal(await changedFiles({ ...base, repository: 'not a repo', event: {}, request: request([]) }), null);
});

test('the installed copy is made identical to the checkout, except .git and vendor', () => {
  const { root, extension } = workspace({ '.git/HEAD': 'ref', 'vendor/dep/a.php': '<?php', 'Test/Unit/DemoTest.php': '<?php', 'sub/.git/x': 'y' });
  const installed = path.join(root, 'installed');
  fs.mkdirSync(path.join(installed, 'vendor/kept'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'stale.php'), '<?php');
  fs.writeFileSync(path.join(installed, 'registration.php'), 'old');

  assert.deepEqual(differences(extension, installed, 2), ['Model/Demo.php: only in the checkout', 'Test/Unit/DemoTest.php: only in the checkout']);
  mirrorDirectory(extension, installed);
  assert.deepEqual(differences(extension, installed), []);
  assert.ok(fs.existsSync(path.join(installed, 'Test/Unit/DemoTest.php')));
  assert.ok(fs.existsSync(path.join(installed, 'vendor/kept')));
  for (const absent of ['stale.php', '.git', 'vendor/dep', 'sub/.git']) {
    assert.equal(fs.existsSync(path.join(installed, absent)), false, absent);
  }
  fs.writeFileSync(path.join(installed, 'registration.php'), 'changed');
  fs.writeFileSync(path.join(installed, 'extra.php'), '');
  assert.deepEqual(differences(extension, installed), ['extra.php: only in the installed copy', 'registration.php: differs']);
});

test('results keep one row per check and fail on failed or blocked', () => {
  let checks = recordCheck([], { check: 'unit', status: 'failed', seconds: 1, note: 'a' });
  checks = recordCheck(checks, { check: 'unit', status: 'passed', seconds: 2, note: 'b' });
  assert.deepEqual(checks, [{ check: 'unit', status: 'passed', seconds: 2, note: 'b' }]);
  assert.equal(overallStatus(checks), 'passed');
  assert.equal(overallStatus([{ status: 'skipped' }, { status: 'blocked' }]), 'failed');
});

test('generated PHPUnit and PHPStan configurations', () => {
  assert.match(unitConfiguration(['/m/vendor/acme/a & b/Test/Unit']), /<directory>\/m\/vendor\/acme\/a &amp; b\/Test\/Unit<\/directory>/);
  const neon = defaultConfiguration({ extensionNeon: '/t/extension.neon', baseline: '/w/baseline.neon', level: '5', work: '/work', extension: '/w' });
  assert.match(neon, /includes:\n {4}- \/t\/extension\.neon\n {4}- \/w\/baseline\.neon\nparameters:\n {4}level: 5\n/);
  assert.doesNotMatch(defaultConfiguration({ extensionNeon: '/t/e.neon', baseline: null, level: '1', work: '/work', extension: '/w' }), /baseline/);
  const shared = defaultConfiguration({ extensionNeon: '/t/ext.neon', baseline: '/w/b.neon', includes: ['/w/ci/shared.neon'], level: 'max', work: '/wk', extension: '/w/ext' });
  assert.match(shared, /includes:\n {4}- \/t\/ext\.neon\n {4}- \/w\/b\.neon\n {4}- \/w\/ci\/shared\.neon\nparameters:\n {4}level: max\n/);
});

test('phpstan includes must be workspace files and extend only the default configuration', () => {
  const { extension } = workspace({ 'ci/a.neon': 'parameters: {}', 'ci/b.neon': 'parameters: {}' });
  const config = { workspace: extension, phpstan: { includes: ['ci/a.neon', 'ci/b.neon'] } };
  assert.deepEqual(resolveIncludes(config, null), { files: [path.join(extension, 'ci/a.neon'), path.join(extension, 'ci/b.neon')], label: ' + includes ci/a.neon, ci/b.neon' });
  assert.deepEqual(resolveIncludes({ ...config, phpstan: { includes: [] } }, 'repository phpstan.neon'), { files: [], label: '' });
  assert.throws(() => resolveIncludes({ ...config, phpstan: { includes: ['ci/x.neon'] } }, null), /include 'ci\/x\.neon' does not exist in the workspace/);
  assert.throws(() => resolveIncludes(config, 'repository phpstan.neon'),
    /phpstan includes extend the default configuration, but repository phpstan\.neon is used/);
});

test('tool configuration: input, then repository file, then default', () => {
  const { extension } = workspace({ 'phpcs.xml.dist': '<ruleset/>', 'dev/custom.xml': '<ruleset/>' });
  const ctx = { config: { workspace: extension, extension }, changed: new Set(['phpcs.xml.dist']) };
  const candidates = ['.phpcs.xml', 'phpcs.xml', '.phpcs.xml.dist', 'phpcs.xml.dist'];
  assert.deepEqual(resolveToolConfig(ctx, 'dev/custom.xml', candidates), { file: path.join(extension, 'dev/custom.xml'), label: 'configured dev/custom.xml' });
  assert.deepEqual(resolveToolConfig(ctx, '', candidates), { file: path.join(extension, 'phpcs.xml.dist'), label: 'repository phpcs.xml.dist, changed in this pull request' });
  assert.throws(() => resolveToolConfig(ctx, 'missing.xml', candidates), /does not exist in the workspace/);
  assert.throws(() => resolveToolConfig(ctx, '../outside.xml', candidates), /does not exist in the workspace/);
  fs.rmSync(path.join(extension, 'phpcs.xml.dist'));
  assert.deepEqual(resolveToolConfig(ctx, '', candidates), { file: null, label: 'action default' });
});

test('PHPUnit without tests is a warning, without a report a failure', async () => {
  const { root } = workspace();
  const config = { magentoRoot: path.join(root, 'magento'), magentoVersion: '2.4.8-p5', results: path.join(root, 'results'), testdox: false };
  fs.mkdirSync(config.results, { recursive: true });
  const ctx = (report, code) => ({
    config,
    sh: {
      exec: async (command, args) => {
        if (args[0] === '--version') {
          return { code: 0, stdout: 'PHPUnit 10.5.45 by Sebastian Bergmann' };
        }
        const junit = args[args.indexOf('--log-junit') + 1];
        fs.rmSync(junit, { force: true });
        if (report !== null) {
          fs.writeFileSync(junit, report);
        }
        return { code, stdout: '' };
      },
    },
  });
  const empty = '<testsuites><testsuite name="extension" tests="0" assertions="0" failures="0" errors="0"></testsuite></testsuites>';
  const none = await runPhpunit(ctx(empty, 0), 'unit', [], root);
  assert.equal(none.status, 'warning');
  assert.match(none.note, /PHPUnit 10\.5\.45 .*no tests were run/);

  const ran = await runPhpunit(ctx(empty.replace('tests="0" assertions="0"', 'tests="2" assertions="3"'), 0), 'unit', [], root);
  assert.equal(ran.status, 'passed');

  await assert.rejects(runPhpunit(ctx(null, 255), 'unit', [], root), (error) => error instanceof CheckFailed && /did not finish \(exit code 255\)/.test(error.note));
});

test('validate requires a module only from a magento2-module package', async () => {
  const run = (composer) => {
    const { extension } = workspace({ 'composer.json': JSON.stringify(composer), 'registration.php': null, 'etc/module.xml': null });
    const ctx = {
      config: { extension, extensionName: composer.name },
      modules: moduleNames(extension),
      sh: { exec: async () => ({ code: 0, stdout: '', output: '' }) },
    };
    return validate(ctx);
  };
  await assert.rejects(run({ name: 'acme/module-demo', type: 'magento2-module' }),
    (error) => error instanceof CheckFailed && /no etc\/module.xml/.test(error.note));
  const library = await run({ name: 'acme/demo-commands', type: 'magento2-library' });
  assert.equal(library.status, 'passed');
  assert.equal(library.note, 'acme/demo-commands is a magento2-library package and declares no module');
  assert.match((await run({ name: 'acme/plain' })).note, /is a library package/);
});
