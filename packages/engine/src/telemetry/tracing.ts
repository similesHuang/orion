import { SpanContext, AgentYield } from '../types/index.js';

export interface TelemetrySpan {
  setAttribute(key: string, value: unknown): void;
  end(): void;
}

export interface TelemetryTracer {
  startSpan(name: string, attributes?: Record<string, unknown>): TelemetrySpan;
}

export interface TelemetryHooks {
  tracer: TelemetryTracer;
  onTurnStart(turn: number, messages: unknown[]): TelemetrySpan;
  onToolCall(toolName: string, args: Record<string, unknown>): TelemetrySpan;
  onYield(yield_: AgentYield): void;
}

const noopSpan: TelemetrySpan = { setAttribute() {}, end() {} };
const noopTracer: TelemetryTracer = { startSpan(_name, _attrs) { return noopSpan; } };

export const NoopTelemetry: TelemetryHooks = {
  tracer: noopTracer,
  onTurnStart(_turn, _messages) { return noopSpan; },
  onToolCall(_name, _args) { return noopSpan; },
  onYield(_y) {},
};

let currentTelemetry: TelemetryHooks = NoopTelemetry;

export function setTelemetry(telemetry: TelemetryHooks): void {
  currentTelemetry = telemetry;
}

export function getTelemetry(): TelemetryHooks {
  return currentTelemetry;
}

export function createSpanContext(name: string, attributes?: Record<string, unknown>): SpanContext {
  return {
    traceId: crypto.randomUUID(),
    spanId: crypto.randomUUID(),
    name,
    attributes,
  };
}
