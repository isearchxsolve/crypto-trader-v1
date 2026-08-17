/**
 * observability.ts — Structured telemetry / audit log schema for every decision.
 *
 * Provides:
 *   - DecisionEvent types for VETO/ADMIT/EXIT/SCORE/ENTRY
 *   - Structured logger with JSON output for ingestion (Loki, Datadog, etc.)
 *   - Correlation IDs for request tracing
 *   - Metrics counters for Prometheus-style scraping
 */
import { randomUUID } from 'crypto';

export type DecisionKind =
  | 'DISCOVERY_VETO'
  | 'DISCOVERY_ADMIT'
  | 'SCORING_COMPOSITE'
  | 'SAFETY_VETO'
  | 'SAFETY_PASS'
  | 'ENTRY_ADMIT'
  | 'ENTRY_REJECT'
  | 'EXIT_PARTIAL'
  | 'EXIT_FULL'
  | 'EXIT_HOLD'
  | 'RISK_CIRCUIT_BREAK'
  | 'RISK_PORTFOLIO_HEAT'
  | 'PROVIDER_CIRCUIT_OPEN'
  | 'PROVIDER_DEGRADED_MODE'
  | 'ML_PREDICTION';

export interface DecisionEvent {
  eventId: string;
  timestamp: number;
  kind: DecisionKind;
  correlationId: string;
  tokenAddress?: string;
  /** Human-readable reason for the decision */
  reason: string;
  /** Structured payload for programmatic analysis */
  payload: Record<string, unknown>;
  /** Latency of the decision path in ms */
  latencyMs?: number;
  /** Source module that emitted the event */
  source: string;
}

export interface MetricPoint {
  name: string;
  value: number;
  labels: Record<string, string>;
  timestamp: number;
}

class Observability {
  private events: DecisionEvent[] = [];
  private metrics: MetricPoint[] = [];
  private maxEvents = 10000;
  private maxMetrics = 50000;
  private correlationId: string;

  constructor() {
    this.correlationId = randomUUID();
  }

  newCorrelationId(): string {
    this.correlationId = randomUUID();
    return this.correlationId;
  }

  getCorrelationId(): string {
    return this.correlationId;
  }

  logDecision(event: Omit<DecisionEvent, 'eventId' | 'timestamp'>): DecisionEvent {
    const fullEvent: DecisionEvent = {
      ...event,
      eventId: randomUUID(),
      timestamp: Date.now(),
    };
    this.events.push(fullEvent);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }
    // Console JSON for log aggregation
    console.log(JSON.stringify(fullEvent));
    return fullEvent;
  }

  recordMetric(name: string, value: number, labels: Record<string, string> = {}) {
    const point: MetricPoint = {
      name,
      value,
      labels,
      timestamp: Date.now(),
    };
    this.metrics.push(point);
    if (this.metrics.length > this.maxMetrics) {
      this.metrics.shift();
    }
  }

  getEvents(filter?: { kind?: DecisionKind; tokenAddress?: string; since?: number }): DecisionEvent[] {
    let result = this.events;
    if (filter?.kind) result = result.filter(e => e.kind === filter.kind);
    if (filter?.tokenAddress) result = result.filter(e => e.tokenAddress === filter.tokenAddress);
    const since = filter?.since;
    if (since) result = result.filter(e => e.timestamp >= since);
    return result;
  }

  getMetrics(name?: string, since?: number): MetricPoint[] {
    let result = this.metrics;
    if (name) result = result.filter(m => m.name === name);
    if (since) result = result.filter(m => m.timestamp >= since);
    return result;
  }

  // Prometheus-style text format export
  exportPrometheus(): string {
    const lines: string[] = [];
    const byName = new Map<string, MetricPoint[]>();
    for (const m of this.metrics) {
      if (!byName.has(m.name)) byName.set(m.name, []);
      byName.get(m.name)!.push(m);
    }
    for (const [name, points] of byName) {
      const latest = points[points.length - 1];
      const labels = Object.entries(latest.labels)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      lines.push(
        `${name}{${labels}} ${latest.value} ${latest.timestamp}`,
      );
    }
    return lines.join('\n');
  }
}

export const observability = new Observability();

// Helper for callers
export function logDecision(event: Omit<DecisionEvent, 'eventId' | 'timestamp'>): DecisionEvent {
  return observability.logDecision(event);
}

export function recordMetric(name: string, value: number, labels: Record<string, string> = {}): void {
  observability.recordMetric(name, value, labels);
}

export function getEvents(filter?: { kind?: DecisionKind; tokenAddress?: string; since?: number }): DecisionEvent[] {
  return observability.getEvents(filter);
}

export function getMetrics(name?: string, since?: number): MetricPoint[] {
  return observability.getMetrics(name, since);
}

export function exportPrometheus(): string {
  return observability.exportPrometheus();
}
