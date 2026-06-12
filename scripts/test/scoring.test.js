'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSignalGroup,
  chooseMajorityPolarity,
  computeDraftScore,
  dedupeClaims,
  groupThemes
} = require('../research.js');

function mkClaim(overrides = {}) {
  return {
    brand: 'Nutricost',
    dimension: 'value',
    polarity: 'positive',
    sourceType: 'reddit',
    sourceId: 'src1#c1',
    independentSourceId: 'src1',
    subreddit: 'r/Supplements',
    score: 10,
    scoreKind: 'upvotes',
    quote: 'great value for money',
    url: 'https://reddit.com/r/Supplements/comments/x',
    ...overrides
  };
}

function mkTheme(overrides = {}) {
  return {
    brand: 'Nutricost',
    dimension: 'value',
    polarity: 'positive',
    frequency: 3,
    convergence: 1,
    positiveCount: 3,
    negativeCount: 0,
    mixedCount: 0,
    sourceTypes: ['reddit', 'amazon', 'expert'],
    claims: [mkClaim()],
    ...overrides
  };
}

// --- chooseMajorityPolarity ---

test('chooseMajorityPolarity: positive majority wins', () => {
  assert.equal(chooseMajorityPolarity(2, 1, 0), 'positive');
});

test('chooseMajorityPolarity: negative majority wins', () => {
  assert.equal(chooseMajorityPolarity(1, 2, 0), 'negative');
});

test('chooseMajorityPolarity: tie between positive and negative is mixed', () => {
  assert.equal(chooseMajorityPolarity(1, 1, 0), 'mixed');
});

test('chooseMajorityPolarity: only mixed claims is mixed', () => {
  assert.equal(chooseMajorityPolarity(0, 0, 3), 'mixed');
});

test('chooseMajorityPolarity: mixed plurality beats positive', () => {
  assert.equal(chooseMajorityPolarity(2, 0, 3), 'mixed');
});

// --- buildSignalGroup ---

test('buildSignalGroup: frequency counts independent sources, not claims', () => {
  const claims = [
    mkClaim({ sourceId: 'src1#c1', independentSourceId: 'src1' }),
    mkClaim({ sourceId: 'src1#c2', independentSourceId: 'src1' }),
    mkClaim({ sourceId: 'src2#c1', independentSourceId: 'src2', polarity: 'negative' })
  ];
  const group = buildSignalGroup(claims, 'Nutricost', 'value');
  assert.equal(group.frequency, 2);
  assert.equal(group.polarity, 'positive');
  assert.equal(group.positiveCount, 2);
  assert.equal(group.negativeCount, 1);
  assert.equal(group.convergence, 0.67);
});

// --- groupThemes ---

test('groupThemes: 2+ independent sources become a theme, 1 stays weak signal', () => {
  const claims = [
    mkClaim({ sourceId: 'src1#c1', independentSourceId: 'src1' }),
    mkClaim({ sourceId: 'src2#c1', independentSourceId: 'src2' }),
    mkClaim({ dimension: 'taste', sourceId: 'src1#c9', independentSourceId: 'src1' })
  ];
  const { themes, weakSignals } = groupThemes(claims);
  assert.equal(themes.length, 1);
  assert.equal(themes[0].dimension, 'value');
  assert.equal(themes[0].frequency, 2);
  assert.equal(weakSignals.length, 1);
  assert.equal(weakSignals[0].dimension, 'taste');
});

test('groupThemes: brandless claims always land in weak signals', () => {
  const claims = [
    mkClaim({ brand: null, sourceId: 'src1#c1', independentSourceId: 'src1' }),
    mkClaim({ brand: null, sourceId: 'src2#c1', independentSourceId: 'src2' })
  ];
  const { themes, weakSignals } = groupThemes(claims);
  assert.equal(themes.length, 0);
  assert.equal(weakSignals.length, 2);
});

// --- dedupeClaims ---

test('dedupeClaims: same brand/dimension/polarity/sourceId keeps highest score', () => {
  const claims = [
    mkClaim({ score: 5, quote: 'low score copy' }),
    mkClaim({ score: 50, quote: 'high score copy' })
  ];
  const deduped = dedupeClaims(claims);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].score, 50);
});

test('dedupeClaims: different sourceIds are kept separately', () => {
  const claims = [
    mkClaim({ sourceId: 'src1#c1' }),
    mkClaim({ sourceId: 'src2#c1', independentSourceId: 'src2' })
  ];
  assert.equal(dedupeClaims(claims).length, 2);
});

// --- computeDraftScore ---

test('computeDraftScore: brand with no themes scores baseline 5.0', () => {
  const result = computeDraftScore([], [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(result.brandScores['Nutricost'], 5);
  assert.equal(result.topPick, 'Nutricost');
  assert.equal(result.confidence, 'high');
});

test('computeDraftScore: confirmed positive theme (3+ sources) adds 0.5', () => {
  const result = computeDraftScore([mkTheme()], [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(result.brandScores['Nutricost'], 5.5);
});

test('computeDraftScore: testing dimension gets quality bonus (+0.75 total)', () => {
  const result = computeDraftScore(
    [mkTheme({ dimension: 'testing' })],
    [{ brand: 'Nutricost' }],
    'HIGH'
  );
  assert.equal(result.brandScores['Nutricost'], 5.75);
});

test('computeDraftScore: notable positive theme (2 sources) adds only 0.25', () => {
  const result = computeDraftScore(
    [mkTheme({ frequency: 2 })],
    [{ brand: 'Nutricost' }],
    'HIGH'
  );
  assert.equal(result.brandScores['Nutricost'], 5.25);
});

test('computeDraftScore: confirmed safety issue subtracts 1.5 and disqualifies from top pick', () => {
  const themes = [
    mkTheme({ dimension: 'side-effects', polarity: 'negative', frequency: 3 })
  ];
  const signals = [{ brand: 'Nutricost' }, { brand: 'Thorne' }];
  const result = computeDraftScore(themes, signals, 'HIGH');
  assert.equal(result.brandScores['Nutricost'], 3.5);
  assert.equal(result.topPick, 'Thorne');
});

test('computeDraftScore: notable safety issue (2 sources) applies half weight', () => {
  const themes = [
    mkTheme({ dimension: 'side-effects', polarity: 'negative', frequency: 2 })
  ];
  const result = computeDraftScore(themes, [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(result.brandScores['Nutricost'], 4.25);
});

test('computeDraftScore: confirmed value issue subtracts only 0.25', () => {
  const themes = [
    mkTheme({ polarity: 'negative', frequency: 3 })
  ];
  const result = computeDraftScore(themes, [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(result.brandScores['Nutricost'], 4.75);
});

test('computeDraftScore: score is clamped to [1, 10]', () => {
  const negatives = Array.from({ length: 4 }, () =>
    mkTheme({ dimension: 'side-effects', polarity: 'negative', frequency: 3 })
  );
  const low = computeDraftScore(negatives, [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(low.brandScores['Nutricost'], 1);

  const positives = Array.from({ length: 8 }, () =>
    mkTheme({ dimension: 'testing', frequency: 3 })
  );
  const high = computeDraftScore(positives, [{ brand: 'Nutricost' }], 'HIGH');
  assert.equal(high.brandScores['Nutricost'], 10);
});

test('computeDraftScore: empty input yields null top pick', () => {
  const result = computeDraftScore([], [], 'LOW');
  assert.equal(result.topPick, null);
  assert.equal(result.confidence, 'low');
  assert.deepEqual(result.brandScores, {});
});
