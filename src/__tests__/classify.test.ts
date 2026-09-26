import { classifyNetworkQuality, isQualityAtLeast } from '../classify';
import { DEFAULT_CONFIG } from '../constants';
import type { NetworkQuality, ProbeFailure, QualityThresholds } from '../types';
import { NOW, probe, snapshot } from './fixtures';

describe('classifyNetworkQuality', () => {
  const failure = (overrides: Partial<ProbeFailure> = {}): ProbeFailure => ({
    code: 'E_PROBE_FAILED',
    message: 'No internet response',
    transport: 'wifi',
    timestamp: NOW,
    ...overrides,
  });

  it('reports an offline snapshot before considering metrics', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ isConnected: false, downlinkKbps: 100_000 }),
        probe(),
        undefined,
        NOW
      )
    ).toEqual({
      quality: 'offline',
      qualitySource: 'none',
      effectiveDownlinkKbps: null,
      effectiveRttMs: null,
      reasons: ['not-connected'],
    });
  });

  it.each([
    [{ isCaptivePortal: true } as const, 'captive-portal'],
    [{ isValidated: false } as const, 'not-validated'],
  ])('forces poor quality for %o', (overrides, reason) => {
    expect(
      classifyNetworkQuality(snapshot(overrides), probe(), undefined, NOW)
    ).toMatchObject({
      quality: 'poor',
      qualitySource: 'none',
      reasons: [reason],
    });
  });

  it.each([
    [20_001, 'excellent'],
    [20_000, 'excellent'],
    [19_999, 'good'],
    [5_001, 'good'],
    [5_000, 'good'],
    [4_999, 'moderate'],
    [1_001, 'moderate'],
    [1_000, 'moderate'],
    [999, 'poor'],
  ] as const)('classifies %d kbps as %s', (downlinkKbps, quality) => {
    expect(
      classifyNetworkQuality(snapshot({ downlinkKbps }), null, undefined, NOW)
    ).toMatchObject({ quality, qualitySource: 'os-estimate' });
  });

  it.each([
    [49, 'excellent'],
    [50, 'excellent'],
    [51, 'good'],
    [149, 'good'],
    [150, 'good'],
    [151, 'moderate'],
    [399, 'moderate'],
    [400, 'moderate'],
    [401, 'poor'],
  ] as const)('classifies %d ms RTT as %s', (rttMs, quality) => {
    expect(
      classifyNetworkQuality(
        snapshot(),
        probe({ rttMs, downlinkKbps: null }),
        undefined,
        NOW
      )
    ).toMatchObject({ quality, qualitySource: 'probe' });
  });

  it('uses the worse of downlink and RTT tiers', () => {
    expect(
      classifyNetworkQuality(
        snapshot(),
        probe({ downlinkKbps: 25_000, rttMs: 200 }),
        undefined,
        NOW
      )
    ).toMatchObject({ quality: 'moderate', qualitySource: 'probe' });
  });

  it('forces poor probe quality for a fresh same-transport failure', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ downlinkKbps: 25_000 }),
        null,
        undefined,
        NOW,
        { lastProbeFailure: failure() }
      )
    ).toMatchObject({
      quality: 'poor',
      qualitySource: 'probe',
      reasons: ['probe failed: E_PROBE_FAILED'],
    });
  });

  it('ignores a stale probe failure', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ downlinkKbps: 5_000 }),
        null,
        undefined,
        NOW,
        {
          lastProbeFailure: failure({
            timestamp: NOW - DEFAULT_CONFIG.probe.resultTtlMs - 1,
          }),
        }
      )
    ).toMatchObject({ quality: 'good', qualitySource: 'os-estimate' });
  });

  it('ignores a probe failure from another transport', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ downlinkKbps: 5_000 }),
        null,
        undefined,
        NOW,
        { lastProbeFailure: failure({ transport: 'cellular' }) }
      )
    ).toMatchObject({ quality: 'good', qualitySource: 'os-estimate' });
  });

  it('lets a later successful probe supersede a failure', () => {
    expect(
      classifyNetworkQuality(
        snapshot(),
        probe({ timestamp: NOW }),
        undefined,
        NOW,
        { lastProbeFailure: failure({ timestamp: NOW - 1 }) }
      )
    ).toMatchObject({ quality: 'excellent', qualitySource: 'probe' });
  });

  it('does not apply validation grace to isValidated null on iOS', () => {
    for (const networkChangedAt of [
      NOW,
      NOW - DEFAULT_CONFIG.validationGraceMs,
    ]) {
      const result = classifyNetworkQuality(
        snapshot({ isConnected: true, isValidated: null }),
        probe(),
        undefined,
        NOW,
        { networkChangedAt }
      );

      expect(result).toMatchObject({
        quality: 'excellent',
        qualitySource: 'probe',
      });
      expect(result.reasons).not.toContain('validating');
      expect(result.reasons).not.toContain('not-validated');
    }
  });

  it('reports validating during the validation grace period', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ isValidated: false }),
        null,
        undefined,
        NOW,
        { networkChangedAt: NOW - DEFAULT_CONFIG.validationGraceMs + 1 }
      )
    ).toMatchObject({ quality: 'unknown', reasons: ['validating'] });
  });

  it('reports poor after the validation grace period', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ isValidated: false }),
        null,
        undefined,
        NOW,
        { networkChangedAt: NOW - DEFAULT_CONFIG.validationGraceMs }
      )
    ).toMatchObject({ quality: 'poor', reasons: ['not-validated'] });
  });

  it('reports a captive portal immediately during the grace period', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ isValidated: false, isCaptivePortal: true }),
        null,
        undefined,
        NOW,
        { networkChangedAt: NOW }
      )
    ).toMatchObject({ quality: 'poor', reasons: ['captive-portal'] });
  });

  it('ignores a probe that has expired', () => {
    const result = classifyNetworkQuality(
      snapshot({ downlinkKbps: 5_000 }),
      probe({ timestamp: NOW - DEFAULT_CONFIG.probe.resultTtlMs - 1 }),
      undefined,
      NOW
    );

    expect(result).toMatchObject({
      quality: 'good',
      qualitySource: 'os-estimate',
    });
    expect(result.reasons).toContain('probe stale (expired)');
  });

  it('accepts a probe exactly at the TTL boundary', () => {
    expect(
      classifyNetworkQuality(
        snapshot({ downlinkKbps: 1_000 }),
        probe({ timestamp: NOW - DEFAULT_CONFIG.probe.resultTtlMs }),
        undefined,
        NOW
      )
    ).toMatchObject({ quality: 'excellent', qualitySource: 'probe' });
  });

  it('ignores a probe from another transport', () => {
    const result = classifyNetworkQuality(
      snapshot({ downlinkKbps: 5_000 }),
      probe({ transport: 'cellular' }),
      undefined,
      NOW
    );

    expect(result).toMatchObject({
      quality: 'good',
      qualitySource: 'os-estimate',
    });
    expect(result.reasons).toContain('probe stale (transport changed)');
  });

  it('falls back to the OS estimate when fresh probe downlink is null', () => {
    const result = classifyNetworkQuality(
      snapshot({ downlinkKbps: 5_000 }),
      probe({ downlinkKbps: null, rttMs: null }),
      undefined,
      NOW
    );

    expect(result).toMatchObject({
      quality: 'good',
      qualitySource: 'os-estimate',
      effectiveDownlinkKbps: 5_000,
    });
  });

  it('uses a fresh RTT and an OS downlink together with probe source', () => {
    const result = classifyNetworkQuality(
      snapshot({ downlinkKbps: 25_000 }),
      probe({ downlinkKbps: null, rttMs: 200 }),
      undefined,
      NOW
    );

    expect(result).toMatchObject({
      quality: 'moderate',
      qualitySource: 'probe',
      effectiveDownlinkKbps: 25_000,
      effectiveRttMs: 200,
    });
  });

  it('does not mutate the snapshot, probe, or configuration', () => {
    const inputSnapshot = snapshot({ downlinkKbps: 5_000 });
    const inputProbe = probe({ rttMs: 100 });
    const snapshotBefore = { ...inputSnapshot };
    const probeBefore = { ...inputProbe };

    classifyNetworkQuality(inputSnapshot, inputProbe, DEFAULT_CONFIG, NOW);

    expect(inputSnapshot).toEqual(snapshotBefore);
    expect(inputProbe).toEqual(probeBefore);
    expect(DEFAULT_CONFIG.thresholds.good.minDownlinkKbps).toBe(5_000);
  });

  it.each([
    ['5g', 'good'],
    ['4g', 'good'],
    ['3g', 'moderate'],
    ['2g', 'poor'],
  ] as const)(
    'uses the %s cellular heuristic',
    (cellularGeneration, quality) => {
      expect(
        classifyNetworkQuality(
          snapshot({ cellularGeneration }),
          null,
          undefined,
          NOW
        )
      ).toMatchObject({ quality, qualitySource: 'heuristic' });
    }
  );

  it('returns unknown when no metric or heuristic exists', () => {
    expect(
      classifyNetworkQuality(snapshot(), null, undefined, NOW)
    ).toMatchObject({ quality: 'unknown', qualitySource: 'none' });
  });

  it('uses custom thresholds', () => {
    const thresholds: QualityThresholds = {
      excellent: { minDownlinkKbps: 100, maxRttMs: 10 },
      good: { minDownlinkKbps: 80, maxRttMs: 20 },
      moderate: { minDownlinkKbps: 60, maxRttMs: 30 },
    };

    expect(
      classifyNetworkQuality(
        snapshot({ downlinkKbps: 80 }),
        null,
        { thresholds, probe: DEFAULT_CONFIG.probe },
        NOW
      ).quality
    ).toBe('good');
  });
});

describe('isQualityAtLeast', () => {
  it.each([
    ['excellent', 'good', true],
    ['good', 'good', true],
    ['moderate', 'good', false],
    ['offline', 'poor', false],
    ['unknown', 'poor', false],
    ['good', 'unknown', false],
  ] as [NetworkQuality, NetworkQuality, boolean][])(
    '%s >= %s is %s',
    (a, b, expected) => {
      expect(isQualityAtLeast(a, b)).toBe(expected);
    }
  );
});
