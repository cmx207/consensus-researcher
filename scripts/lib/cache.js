#!/usr/bin/env node
'use strict';

/**
 * Shared file cache — the reddit.js cache pattern, extracted for reuse
 * by all platform modules (HN, Lemmy, forums, pages).
 */

const { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } = require('fs');
const { join, resolve } = require('path');
const crypto = require('crypto');

function createFileCache({ dir, ttlMs, label = 'cache' }) {
  const cacheDir = resolve(process.cwd(), dir);

  function keyFor(id) {
    return crypto.createHash('md5').update(String(id)).digest('hex').slice(0, 16);
  }

  function get(id) {
    const file = join(cacheDir, `${keyFor(id)}.json`);
    if (!existsSync(file)) return null;
    try {
      const entry = JSON.parse(readFileSync(file, 'utf8'));
      const age = Date.now() - new Date(entry.fetchedAt).getTime();
      if (age > ttlMs) return null;
      return entry.data;
    } catch {
      try { unlinkSync(file); } catch {}
      return null;
    }
  }

  function set(id, data) {
    if (!existsSync(cacheDir)) mkdirSync(cacheDir, { recursive: true });
    const file = join(cacheDir, `${keyFor(id)}.json`);
    writeFileSync(file, JSON.stringify({ id, fetchedAt: new Date().toISOString(), data }), 'utf8');
  }

  function prune() {
    if (!existsSync(cacheDir)) return 0;
    let pruned = 0;
    for (const file of readdirSync(cacheDir).filter(f => f.endsWith('.json'))) {
      const filePath = join(cacheDir, file);
      try {
        const entry = JSON.parse(readFileSync(filePath, 'utf8'));
        if (Date.now() - new Date(entry.fetchedAt).getTime() > ttlMs) {
          unlinkSync(filePath);
          pruned++;
        }
      } catch {
        unlinkSync(filePath);
        pruned++;
      }
    }
    return pruned;
  }

  return { get, set, prune, label };
}

module.exports = { createFileCache };
