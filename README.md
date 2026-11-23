# Magento Extension Check

[![CI](https://github.com/lbajsarowicz/github-action-magento-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/lbajsarowicz/github-action-magento-extension/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/lbajsarowicz/github-action-magento-extension?sort=semver)](https://github.com/lbajsarowicz/github-action-magento-extension/releases/latest)
[![GitHub Marketplace](https://img.shields.io/badge/marketplace-magento--extension--check-blue?logo=github)](https://github.com/marketplace/actions/magento-extension-check)
[![License: MIT](https://img.shields.io/github/license/lbajsarowicz/github-action-magento-extension)](LICENSE)

Checks a Magento 2 extension against one Magento Open Source release and one PHP version: Composer metadata, PHP syntax, the Magento coding standard, a real install from the Mage-OS mirror, `setup:di:compile`, unit and integration tests, and PHPStan. Combine it with [Magento Version Matrix](https://github.com/lbajsarowicz/github-action-magento-matrix) to cover every supported release in one pull request.

## Quick start

One Magento release, one PHP version, every check the inputs allow, in a single job:

```yaml
name: Magento Check

on:
  pull_request:
  push:
    branches: [main]

permissions: {}

jobs:
  check:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
      pull-requests: read # list the files changed by the pull request
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - uses: shivammathur/setup-php@eb7c497e18156a6bbabfef1d3a82760b9eda3962 # 2.40.0
        with:
          php-version: '8.4'
          extensions: bcmath, ctype, curl, dom, ftp, gd, hash, iconv, intl, mbstring, openssl, pdo_mysql, simplexml, soap, sockets, sodium, xsl, zip
          coverage: none
          tools: composer:v2
      - uses: lbajsarowicz/github-action-magento-extension@v1
        with:
          magento-version: '2.4.8-p5'
          php-version: '8.4'
```

For every supported release and PHP version at once, with one result table per pull request, see Usage.

## Checks

| Check | What it does | Needs Magento |
|---|---|---|
| `validate` | `composer validate`; `registration.php` and `etc/module.xml` agree on the module name. A package whose Composer type is not `magento2-module` may declare no module, for example one that registers console commands through an autoloaded file | no |
| `lint` | PHP syntax of every `.php` and `.phtml` file | no |
| `phpcs` | PHPCS on the PHP files changed by the pull request or push, with the repository's ruleset or the official Magento 2 coding standard | no |
| `install` | Installs the release from the Mage-OS mirror with your checkout as a Composer path package, then proves the installed and registered module is an exact copy of the checkout | yes |
| `compile` | `module:enable --all` and `setup:di:compile`, without a database | yes |
| `unit` | PHPUnit shipped with that release, on `Test/Unit` | yes |
| `phpstan` | PHPStan with the repository's configuration, or a default that loads `bitexpert/phpstan-magento` | yes |

A check with nothing to run is reported as `skipped`. When `Test/Unit` or `Test/Integration` exists but PHPUnit runs no test from it, the check is reported as `warning`, which does not fail the step. `compile`, `unit` and `phpstan` are `blocked` when `install` fails.

## Actions in this repository

One action per kind of check, so every step or job says what it does. None of them installs PHP; see Setting up PHP.

| Reference | Runs | Needs |
|---|---|---|
| `lbajsarowicz/github-action-magento-extension/static` | `composer validate`, module metadata, PHP syntax | PHP only |
| `lbajsarowicz/github-action-magento-extension/phpcs` | Coding standard on changed files | Magento release |
| `lbajsarowicz/github-action-magento-extension/phpstan` | Static analysis | Magento release |
| `lbajsarowicz/github-action-magento-extension/compile` | `setup:di:compile` and `setup:static-content:deploy`, without a database | Magento release |
| `lbajsarowicz/github-action-magento-extension/phpunit` | Unit tests (`suite: unit`) or integration tests (`suite: integration`) | Magento release; integration also MariaDB/MySQL and OpenSearch services |
| `lbajsarowicz/github-action-magento-extension/install` | Installs the release with the extension, for later steps of the same job | Magento release |
| `lbajsarowicz/github-action-magento-extension/report` | One table with the results of every job; fails when any check failed | Result artifacts of the check jobs |
| `lbajsarowicz/github-action-magento-extension` | Several of the above in one job (`checks` input) | Magento release |

Each action that needs a Magento release installs it first and proves the installed module is your checkout.

## Usage

One job per Magento and PHP combination. The pull request shows one row per combination and a `Result` row with a table of every check. This is the workflow of a module with integration tests; without them, drop `services` and the `Integration tests` step.

```yaml
name: Magento Check

on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:

permissions: {}

concurrency:
  group: magento-check-${{ github.ref }}
  cancel-in-progress: true

jobs:
  matrix:
    name: Version matrix
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions: {}
    outputs:
      matrix: ${{ steps.matrix.outputs.matrix }}
    steps:
      - id: matrix
        uses: lbajsarowicz/github-action-magento-matrix@v1

  check:
    name: "Magento ${{ matrix.magento }} @ PHP ${{ matrix.php }}"
    needs: matrix
    runs-on: ubuntu-24.04
    timeout-minutes: 60
    permissions:
      contents: read
      pull-requests: read # list the files changed by the pull request
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.matrix.outputs.matrix) }}
    env:
      # The Result job shows one table for the whole run instead of one per step.
      MAGENTO_EXTENSION_CHECK_SUMMARY: 'false'
    services:
      mariadb:
        image: mariadb:${{ matrix.mariadb }} # zizmor: ignore[unpinned-images] the version follows the Magento release under test
        env:
          MARIADB_ROOT_PASSWORD: magento
        ports:
          - 3306:3306
        options: >-
          --health-cmd "healthcheck.sh --connect --innodb_initialized"
          --health-interval 10s --health-timeout 5s --health-retries 12
      opensearch:
        image: opensearchproject/opensearch:${{ matrix.opensearch }} # zizmor: ignore[unpinned-images] the version follows the Magento release under test
        env:
          discovery.type: single-node
          DISABLE_SECURITY_PLUGIN: 'true'
          DISABLE_INSTALL_DEMO_CONFIG: 'true'
        ports:
          - 9200:9200
        options: >-
          --health-cmd "curl -fs http://localhost:9200/_cluster/health"
          --health-interval 10s --health-timeout 5s --health-retries 30
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      - name: Set up PHP ${{ matrix.php }}
        uses: shivammathur/setup-php@eb7c497e18156a6bbabfef1d3a82760b9eda3962 # 2.40.0
        with:
          php-version: ${{ matrix.php }}
          extensions: bcmath, ctype, curl, dom, ftp, gd, hash, iconv, intl, mbstring, openssl, pdo_mysql, simplexml, soap, sockets, sodium, xsl, zip
          coverage: none
          tools: composer:v2

      - name: Composer and syntax
        id: static
        uses: lbajsarowicz/github-action-magento-extension/static@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          checks: validate,lint

      - name: Install Magento ${{ matrix.magento }}
        id: install
        uses: lbajsarowicz/github-action-magento-extension/install@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}

      - name: PHPCS
        id: phpcs
        uses: lbajsarowicz/github-action-magento-extension/phpcs@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          annotations: ${{ strategy.job-index == 0 }}

      - name: Compile and static content
        id: compile
        if: ${{ !cancelled() && steps.install.outcome == 'success' }}
        uses: lbajsarowicz/github-action-magento-extension/compile@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}

      - name: Unit tests
        id: unit
        if: ${{ !cancelled() && steps.compile.outcome == 'success' }}
        uses: lbajsarowicz/github-action-magento-extension/phpunit@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          suite: unit
          testdox: true

      - name: Integration tests
        id: integration
        if: ${{ !cancelled() && steps.unit.outcome == 'success' }}
        uses: lbajsarowicz/github-action-magento-extension/phpunit@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          suite: integration
          testdox: true
          db-password: magento

      - name: PHPStan
        id: phpstan
        if: ${{ !cancelled() && steps.compile.outcome == 'success' }}
        uses: lbajsarowicz/github-action-magento-extension/phpstan@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          annotations: ${{ strategy.job-index == 0 }}

      - name: Upload results
        if: ${{ always() && steps.static.outputs.result-path != '' }}
        uses: actions/upload-artifact@v7
        with:
          name: magento-check-${{ matrix.magento }}-php${{ matrix.php }}
          path: ${{ steps.static.outputs.result-path }}
          retention-days: 7

  result:
    name: Result
    if: ${{ always() }}
    needs: [matrix, check]
    runs-on: ubuntu-24.04
    timeout-minutes: 5
    permissions: {}
    steps:
      - uses: actions/download-artifact@v8
        with:
          pattern: magento-check-*
          path: magento-check-results
      - uses: lbajsarowicz/github-action-magento-extension/report@v1
        with:
          matrix: ${{ needs.matrix.outputs.matrix }}
          checks: validate,lint,install,phpcs,compile,static-content,unit,integration,phpstan
      - name: Fail unless every job succeeded
        if: ${{ always() }}
        env:
          RESULTS: ${{ join(needs.*.result, ' ') }}
        run: |
          echo "Jobs: $RESULTS"
          [[ ! "$RESULTS" =~ (failure|cancelled|skipped) ]]
```

- Magento is installed once per job. Each later step reuses the install and the Composer cache of the steps before it.
- A step that fails names the check that failed. The steps that depend on it are skipped: nothing runs after a failed install, unit tests and PHPStan need a successful compilation, integration tests need passing unit tests.
- `report` reads the results of all jobs and writes one table to the run summary. Make `Result` the required check in branch protection.
- `MAGENTO_EXTENSION_CHECK_SUMMARY: 'false'` turns off the per-step summaries, so the table of the `Result` job is the only one.

| Mark | Meaning |
|---|---|
| ✅ | passed |
| ❌ | failed; the reason and the end of the log are below the table |
| ⚠️ | passed with a warning, such as a `Test/Unit` directory from which PHPUnit ran no test |
| ➖ | nothing to run, such as no `Test/Unit` directory |
| ⛔ | blocked by a failed install |
| ⚪ | not run because an earlier check failed |
| ❔ | the job uploaded no result |

## Setting up PHP

The actions do not install PHP. The job provides it, which lets the same actions run on a plain runner and inside a container image of your choice. They need on the `PATH`:

| Tool | Notes |
|---|---|
| PHP | The version of the matrix cell, with the extensions Magento requires |
| Composer 2 | |
| Node.js 20 or newer | Runs the actions themselves; present on GitHub-hosted runners and in the Warden images |
| `git`, `unzip` | For Composer |
| `mysql` client | Optional; used by integration tests to prepare the database |

`php-version` is a safeguard, not a setup instruction: the action fails when the PHP of the job is another version, and without the input it accepts whatever PHP is there.

### On a GitHub-hosted runner

A step before the first action, as in the workflow above:

```yaml
      - name: Set up PHP ${{ matrix.php }}
        uses: shivammathur/setup-php@eb7c497e18156a6bbabfef1d3a82760b9eda3962 # 2.40.0
        with:
          php-version: ${{ matrix.php }}
          extensions: bcmath, ctype, curl, dom, ftp, gd, hash, iconv, intl, mbstring, openssl, pdo_mysql, simplexml, soap, sockets, sodium, xsl, zip
          coverage: none
          tools: composer:v2
```

### In a container image: Warden

The [Warden](https://warden.dev) images `wardenenv/php-fpm:<php>-magento2` carry PHP with Magento's extensions, Composer, Node.js, `git` and the MySQL client. The job runs in the image, and the PHP version of the matrix picks the tag. Three things differ from the workflow above:

```yaml
  check:
    name: "Magento ${{ matrix.magento }} @ PHP ${{ matrix.php }}"
    needs: matrix
    runs-on: ubuntu-24.04
    container:
      image: wardenenv/php-fpm:${{ matrix.php }}-magento2
      options: --user 1001
    # strategy, env and services as above
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false

      # In place of the "Set up PHP" step. A job container starts without the entrypoint of the
      # image, which is what selects Composer 2.
      - name: Select Composer 2
        run: |
          mkdir -p "$HOME/bin"
          ln -sf /usr/bin/composer2 "$HOME/bin/composer"
          echo "$HOME/bin" >> "$GITHUB_PATH"

      # ... the same steps ...

      - name: Integration tests
        id: integration
        if: ${{ !cancelled() && steps.unit.outcome == 'success' }}
        uses: lbajsarowicz/github-action-magento-extension/phpunit@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          suite: integration
          db-password: magento
          db-host: mariadb
          search-host: opensearch
```

1. `container:` with `--user 1001`. That is the user GitHub-hosted runners work as, and the workspace and the runner's own files belong to it. The image's default user (`www-data`, 1000) cannot write there, so `actions/checkout` fails. Root is not needed; on a self-hosted runner use the uid of the runner's user.
2. `Select Composer 2` in place of `Set up PHP`. The image holds Composer as `composer2`; the step links it as `composer` in the user's own `bin` directory and adds that to the `PATH`.
3. Services are reached by their name (`mariadb`, `opensearch`), not through `127.0.0.1`.

Any other image works the same way, as long as it has the tools in the table. On a self-hosted runner a container image is the better choice, because nothing is installed on the host.

## One job per check

Every sub-action can also be its own job, which gives one row per check and combination, such as `Compile: Magento 2.4.9 @ PHP 8.5`. Each job then sets up PHP and installs Magento itself.

```yaml
  compile:
    name: "Compile: Magento ${{ matrix.magento }} @ PHP ${{ matrix.php }}"
    needs: matrix
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    permissions:
      contents: read
    strategy:
      fail-fast: false
      matrix: ${{ fromJSON(needs.matrix.outputs.matrix) }}
    steps:
      - uses: actions/checkout@v7
        with:
          persist-credentials: false
      - name: Set up PHP ${{ matrix.php }}
        uses: shivammathur/setup-php@eb7c497e18156a6bbabfef1d3a82760b9eda3962 # 2.40.0
        with:
          php-version: ${{ matrix.php }}
          extensions: bcmath, ctype, curl, dom, ftp, gd, hash, iconv, intl, mbstring, openssl, pdo_mysql, simplexml, soap, sockets, sodium, xsl, zip
          coverage: none
          tools: composer:v2
      - uses: lbajsarowicz/github-action-magento-extension/compile@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
```

## Inputs

These are the inputs of the root action. Each sub-action takes the subset that applies to it, with shorter names where there is no ambiguity (`config`, `severity`, `scope`, `level`, `baseline`); see its `action.yml`.

The static action takes `php-version`, `checks`, `path`, `phpcs-config`, `phpcs-severity`, `phpcs-scope`, `annotations` and `github-token` with the same meaning.

| Input | Default | Meaning |
|---|---|---|
| `php-version` | empty | PHP minor the job is expected to provide, such as `8.4`; see Setting up PHP |
| `magento-version` | empty | Exact release, such as `2.4.8-p5`; empty runs static checks only |
| `checks` | `default` | Comma-separated list; `default` is every check the inputs allow |
| `path` | `.` | Directory with the extension's `composer.json` |
| `phpcs-config` | empty | Path to a PHPCS ruleset; see Configuration |
| `phpcs-severity` | empty | Findings at or above this severity fail `phpcs`; see Configuration |
| `phpstan-config` | empty | Path to a PHPStan configuration; see Configuration |
| `phpstan-baseline` | empty | Baseline loaded on top of the default PHPStan configuration |
| `phpcs-scope` | `changed` | `changed` checks files touched by the pull request or push, `all` checks every file, `lines` checks the changed files but fails only on findings in the lines the pull request or push changed (needs `fetch-depth: 2` on pull requests for exact lines, otherwise the API diff is used) |
| `annotations` | `true` | Show PHPCS and PHPStan findings inline in the pull request diff |
| `github-token` | `github.token` | Only reads the list of changed files |
| `phpstan-level` | `1` | Level of the default PHPStan configuration |
| `phpstan-scope` | `all` | `all` fails on any PHPStan finding, `changed` only on findings in files the pull request or push touched, `lines` only on findings in the changed lines (needs `fetch-depth: 2` on pull requests for exact lines, otherwise the API diff is used); general errors always fail |
| `phpunit-testdox` | `false` | Print every test name as a readable sentence (PHPUnit `--testdox`); `testdox` in the `phpunit` action |
| `composer-repositories` | empty | JSON list replacing the public Magento mirror as the source of dependencies; see Private Composer repositories |


## Configuration

PHPCS and PHPStan use the first of these that exists:

| Order | PHPCS | PHPStan |
|---|---|---|
| 1. Input | `phpcs-config` | `phpstan-config` |
| 2. File in the extension | `.phpcs.xml`, `phpcs.xml`, `.phpcs.xml.dist`, `phpcs.xml.dist` | `phpstan.neon`, `phpstan.neon.dist`, `phpstan.dist.neon` |
| 3. Default | Official `Magento2` standard from `magento/magento-coding-standard`, unchanged | `bitexpert/phpstan-magento` at `phpstan-level` |

A path given by input that does not exist fails the check. The job summary names the configuration that was used, and says so when the pull request itself changed it.

With the default ruleset `phpcs` fails at severity 10 and reports the rest as warnings. With a repository ruleset it fails on what that ruleset reports as errors. `phpcs-severity` overrides both.

A repository PHPStan configuration brings its baseline through its own `includes:`. Without a configuration, `phpstan-baseline` loads a baseline on top of the default.

## Private Composer repositories

By default Magento and its dependencies come from the public mirror `mirror.mage-os.org` and from Packagist. `composer-repositories` replaces that with your own list, in the format of the `repositories` section of a `composer.json`. Credentials go in `COMPOSER_AUTH`.

```yaml
      - uses: lbajsarowicz/github-action-magento-extension/install@v1
        with:
          magento-version: ${{ matrix.magento }}
          php-version: ${{ matrix.php }}
          composer-repositories: |
            [
              {"type": "composer", "url": "https://repo.packagist.com/acme/"},
              {"packagist.org": false}
            ]
        env:
          COMPOSER_AUTH: ${{ secrets.COMPOSER_AUTH }}
```

- The list is used for the Magento project and for the separate directory that PHPCS and PHPStan are installed into. Every action that runs Composer takes the input: `static`, `install`, `phpcs`, `phpstan`, `compile`, `phpunit` and the root action.
- `magento/project-community-edition` is read from the first entry of type `composer`. If your repository does not carry the Magento packages, add `{"type": "composer", "url": "https://mirror.mage-os.org/"}` to the list.
- The checkout stays first and is the only source of the extension. The action adds the extension to `exclude` of every repository in the list, or removes it from `only`, so a published release of the package cannot be installed in place of the pull request's code.
- `{"packagist.org": false}` switches Packagist off, as in a `composer.json`.
- An input that is not a JSON list of repositories fails before Composer runs.

With several steps in one job, set the list once for the job and leave the input out. `COMPOSER_AUTH` can be set the same way.

```yaml
  check:
    env:
      MAGENTO_EXTENSION_CHECK_COMPOSER_REPOSITORIES: |
        [{"type": "composer", "url": "https://repo.packagist.com/acme/"}, {"packagist.org": false}]
      COMPOSER_AUTH: ${{ secrets.COMPOSER_AUTH }}
```

The input of a step takes precedence over the variable of the job.

## Tool versions

Every Magento release declares its own development tools, and the checks use them:

| Tool | Version used |
|---|---|
| PHPUnit | The one the release under test resolves (9.6 on 2.4.7, 10.5 on 2.4.8, 12.5 on 2.4.9 today) |
| PHPStan | From the extension's `require-dev` when it lists PHPStan packages, with its constraints (current releases of the same packages when those cannot be installed); otherwise the release's own PHPStan with the `bitexpert/phpstan-magento` version that fits it |
| PHPCS and coding standard | From the extension's `require-dev` when it lists them; otherwise what the release resolves; in the static action, which installs no Magento, current releases |

The summary of every check names the version it ran and where it came from.

## Inline findings

PHPCS and PHPStan findings appear as annotations on the affected lines in the pull request's "Files changed" tab. PHPStan analyses the whole extension, but only findings in changed files are annotated. With `phpcs-scope` or `phpstan-scope` set to `lines`, only findings on the changed lines are annotated. GitHub keeps 10 errors and 10 warnings per step, so findings in changed files are listed first; the complete list is in the job log and in `result-path`.

When the same check runs in several matrix jobs, switch `annotations` off in all but one, or every finding appears once per job:

```yaml
annotations: ${{ strategy.job-index == 0 }}
```

## Outputs

| Output | Meaning |
|---|---|
| `status` | `passed` or `failed` |
| `result-path` | Directory with `results.json` and one log per check |

## Permissions

`contents: read` for the checkout. In a private repository add `pull-requests: read` so the action can list the changed files; without it PHPCS checks every file.

## Known limits

- One Composer package per run (it may hold several modules); Magento Open Source only.
- The release's own development dependencies are installed together with the extension, in one dependency graph.
- Composer's block on packages with published advisories is switched off inside the temporary Magento project, because older release lines would not resolve otherwise.
- The extension's own `phpunit.xml`, `require-dev` and `autoload-dev` are not honoured yet.
- Each job installs Magento once, which costs 30 to 45 seconds.
- No pull-request comment.
- With `phpstan-scope` set to `changed` or `lines`, an error that a change causes in unchanged code (for example a call to a method whose signature changed) does not fail the check.

## Releases

Every merge to `main` publishes a release candidate (`vX.Y.Z-rc.N`). Marking a candidate as a full release retags it to `vX.Y.Z` and moves the major tag. Pin `@v1` to follow compatible releases, or a full `vX.Y.Z` tag or commit SHA to stay on one.

## License

MIT
