/**
 * observability.test.ts — Unit tests for the structured telemetry module.
 *
 * Tests the REAL exported API of observability.ts:
 *   - logDecision / getEvents (with kind/tokenAddress/since filters)
 *   - recordMetric / getMetrics (with name/since filters)
 *   - exportPrometheus (Prometheus text format)
 *   - correlation-id lifecycle (getCorrelationId / newCorrelationId)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  observability,
  logDecision,
  recordMetric,
  getEvents,
  getMetrics,
  exportPrometheus,
} from './observability';

describe('observability', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // logDecision emits a JSON line per event — silence it for test output
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  describe('logDecision / getEvents', () => {
    it('records a decision event with generated eventId and timestamp', () => {
      const event = logDecision({
        kind: 'ENTRY_ADMIT',
        correlationId: observability.getCorrelationId(),
        tokenAddress: 'TOKEN_A',
        reason: 'score above threshold',
        payload: { score: 85 },
        source: 'test',
      });

      expect(event.eventId).toBeTruthy();
      expect(event.timestamp).toBeGreaterThan(0);
      expect(event.kind).toBe('ENTRY_ADMIT');
      expect(event.tokenAddress).toBe('TOKEN_A');

      const found = getEvents({ kind: 'ENTRY_ADMIT', tokenAddress: 'TOKEN_A' });
      expect(found.some(e => e.eventId === event.eventId)).toBe(true);
    });

    it('filters events by kind', () => {
      logDecision({
        kind: 'SAFETY_VETO',
        correlationId: 'c1',
        tokenAddress: 'TOKEN_VETO',
        reason: 'honeypot detected',
        payload: {},
        source: 'test',
      });

      const vetoes = getEvents({ kind: 'SAFETY_VETO' });
      expect(vetoes.length).toBeGreaterThan(0);
      expect(vetoes.every(e => e.kind === 'SAFETY_VETO')).toBe(true);
    });

    it('filters events by tokenAddress', () => {
      const events = getEvents({ tokenAddress: 'TOKEN_A' });
      expect(events.length).toBeGreaterThan(0);
      expect(events.every(e => e.tokenAddress === 'TOKEN_A')).toBe(true);
    });

    it('filters events by since timestamp', () => {
      const future = Date.now() + 60_000;
      const events = getEvents({ since: future });
      expect(events.length).toBe(0);
    });
  });

  describe('recordMetric / getMetrics', () => {
    it('records a metric point with labels', () => {
      recordMetric('entry_latency_ms', 123, { provider: 'jupiter' });

      const points = getMetrics('entry_latency_ms');
      expect(points.length).toBeGreaterThan(0);
      const latest = points[points.length - 1];
      expect(latest.value).toBe(123);
      expect(latest.labels.provider).toBe('jupiter');
    });

    it('filters metrics by name', () => {
      recordMetric('other_metric', 1);
      const points = getMetrics('other_metric');
      expect(points.every(p => p.name === 'other_metric')).toBe(true);
    });

    it('filters metrics by since timestamp', () => {
      const future = Date.now() + 60_000;
      expect(getMetrics('entry_latency_ms', future).length).toBe(0);
    });
  });

  describe('exportPrometheus', () => {
    it('emits name{labels} value timestamp lines', () => {
      recordMetric('prom_test_metric', 42, { tier: 'LEGENDARY' });
      const text = exportPrometheus();
      expect(text).toContain('prom_test_metric{tier=LEGENDARY} 42');
    });

    it('returns a string', () => {
      expect(typeof exportPrometheus()).toBe('string');
    });
  });

  describe('correlation ids', () => {
    it('getCorrelationId returns a stable id until rotated', () => {
      const id1 = observability.getCorrelationId();
      const id2 = observability.getCorrelationId();
      expect(id1).toBe(id2);
    });

    it('newCorrelationId rotates to a fresh id', () => {
      const before = observability.getCorrelationId();
      const after = observability.newCorrelationId();
      expect(after).not.toBe(before);
      expect(observability.getCorrelationId()).toBe(after);
    });
  });
});
