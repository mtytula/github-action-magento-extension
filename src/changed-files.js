'use strict';

const fs = require('node:fs');

/**
 * Lists the file entries of the GitHub API (`filename`, `status`, `patch`) changed by the current
 * pull request or push.
 *
 * @returns {Promise<?Object[]>} null when the list cannot be determined
 */
async function fetchChangedEntries({ event, repository, api, token, request = fetch }) {
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repository || '')) {
    return null;
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'magento-extension-check',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const get = async (url) => {
    try {
      const response = await request(url, { headers, signal: AbortSignal.timeout(20000) });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  };

  const number = event && event.pull_request ? event.pull_request.number : null;
  const before = String((event && event.before) || '');
  const after = String((event && event.after) || '');
  const sha = /^[0-9a-f]{40}$/;

  if (Number.isInteger(number)) {
    const entries = [];
    for (let page = 1; page <= 30; page += 1) {
      const files = await get(`${api}/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`);
      if (!Array.isArray(files)) {
        return null;
      }
      entries.push(...files);
      if (files.length < 100) {
        break;
      }
    }
    return entries;
  }
  if (sha.test(before) && sha.test(after) && before.replace(/0/g, '') !== '') {
    const comparison = await get(`${api}/repos/${repository}/compare/${before}...${after}`);
    if (!comparison || !Array.isArray(comparison.files) || comparison.files.length >= 300) {
      return null;
    }
    return comparison.files;
  }
  return null;
}

/** Entries of files that still exist after the change. */
function presentEntries(entries) {
  return entries.filter((file) => file && file.filename && file.status !== 'removed');
}

/**
 * Lists the repository paths changed by the current pull request or push.
 *
 * @returns {Promise<?string[]>} null when the list cannot be determined and every file should be checked
 */
async function changedFiles(options) {
  const entries = await fetchChangedEntries(options);
  return entries === null ? null : [...new Set(presentEntries(entries).map((file) => String(file.filename)))];
}

function readChangedFiles(file) {
  try {
    return new Set(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean));
  } catch {
    return null;
  }
}

module.exports = { changedFiles, fetchChangedEntries, presentEntries, readChangedFiles };
