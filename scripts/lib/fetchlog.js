#!/usr/bin/env node
'use strict';

/**
 * Fetch log — turns collection failures into data instead of stderr noise.
 *
 * Every search/fetch stage in collectRawData records an entry. The log is
 * embedded in collection bundles and summarized in `research.js status`,
 * so a dead platform shows up in the report instead of silently producing
 * "no data".
 */

function createFetchLog() {
  const entries = [];

  return {
    record({ platform, stage, url = null, ok, error = null, ms = null, count = null }) {
      entries.push({
        platform,
        stage,
        url,
        ok: Boolean(ok),
        error: error ? String(error).slice(0, 300) : null,
        ms,
        count,
        at: new Date().toISOString()
      });
    },

    entries() {
      return entries.slice();
    },

    failures() {
      return entries.filter(entry => !entry.ok);
    },

    summary() {
      const failures = entries.filter(entry => !entry.ok);
      return {
        total: entries.length,
        failed: failures.length,
        failedPlatforms: [...new Set(failures.map(entry => entry.platform))]
      };
    }
  };
}

module.exports = { createFetchLog };
