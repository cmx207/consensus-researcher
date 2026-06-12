'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createFetchLog } = require('../lib/fetchlog.js');
const { isDDGChallengePage, parseDDGLiteHtml } = require('../lib/search.js');

// --- fetch log ---

test('fetchLog: records entries and summarizes failures by platform', () => {
  const fetchLog = createFetchLog();
  fetchLog.record({ platform: 'reddit', stage: 'search', ok: true, count: 3 });
  fetchLog.record({ platform: 'amazon', stage: 'search', ok: false, error: 'HTTP 503' });
  fetchLog.record({ platform: 'amazon', stage: 'fetch', ok: false, error: 'timeout' });

  assert.equal(fetchLog.entries().length, 3);
  assert.equal(fetchLog.failures().length, 2);
  const summary = fetchLog.summary();
  assert.equal(summary.total, 3);
  assert.equal(summary.failed, 2);
  assert.deepEqual(summary.failedPlatforms, ['amazon']);
});

test('fetchLog: truncates huge error strings', () => {
  const fetchLog = createFetchLog();
  fetchLog.record({ platform: 'web', stage: 'search', ok: false, error: 'x'.repeat(5000) });
  assert.ok(fetchLog.entries()[0].error.length <= 300);
});

// --- DDG challenge detection ---

test('isDDGChallengePage: detects anomaly pages, passes real results', () => {
  const challenge = '<html><head><title>DuckDuckGo</title></head><body>' +
    '<p>Our systems have detected unusual traffic. Please complete the anomaly challenge.</p>' +
    '</body></html>' + ' '.repeat(3000);
  assert.equal(isDDGChallengePage(challenge), true);

  const real = '<html><body>' + 'filler '.repeat(500) +
    '<a class="result__a" href="https://example.com">Result</a></body></html>';
  assert.equal(isDDGChallengePage(real), false);
});

test('isDDGChallengePage: suspiciously tiny responses count as challenges', () => {
  assert.equal(isDDGChallengePage('<html><body>nope</body></html>'), true);
});

// --- DDG lite parser ---

test('parseDDGLiteHtml: parses table layout, skips ads, decodes redirects', () => {
  const html = [
    '<table>',
    '<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.reddit.com%2Fr%2FSupplements%2Fcomments%2Fabc%2F&amp;rut=x">Best creatine? : r/Supplements</a></td></tr>',
    '<tr><td class="result-snippet">Community discussion of creatine brands.</td></tr>',
    '<tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad_domain=spam.com">Sponsored result</a></td></tr>',
    '<tr><td class="result-snippet">Buy now!</td></tr>',
    '<tr><td><a rel="nofollow" href="https://examine.com/creatine">Creatine — Examine</a></td></tr>',
    '<tr><td class="result-snippet">Evidence-based analysis.</td></tr>',
    '</table>'
  ].join('\n');

  const results = parseDDGLiteHtml(html);
  assert.equal(results.length, 2);
  assert.equal(results[0].url, 'https://www.reddit.com/r/Supplements/comments/abc/');
  assert.equal(results[0].snippet, 'Community discussion of creatine brands.');
  assert.equal(results[1].url, 'https://examine.com/creatine');
  assert.equal(results[1].snippet, 'Evidence-based analysis.');
});

test('parseDDGLiteHtml: junk input yields empty array', () => {
  assert.deepEqual(parseDDGLiteHtml(''), []);
  assert.deepEqual(parseDDGLiteHtml('<html>nothing</html>'), []);
});
