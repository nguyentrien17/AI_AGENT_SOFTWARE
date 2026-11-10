import { Ajv, type ErrorObject } from 'ajv';

/**
 * The output contract every agent must return (docs/HANDOFF.md, Blueprint §6.4). The runtime — not the
 * agent — persists artifacts and emits the handoff, so the model only ever produces data.
 */
export interface AgentOutputEnvelope {
  status: 'completed' | 'needs_input' | 'failed';
  summary: string;
  artifacts: Array<{ path: string; type: string; content: string }>;
  handoff: {
    to_agent?: string;
    decisions: string[];
    assumptions: string[];
    open_questions: string[];
    required_actions: string[];
  };
  result: Record<string, unknown>;
}

const stringList = { type: 'array', items: { type: 'string', minLength: 1, maxLength: 2000 }, maxItems: 100 };

/** JSON Schema of the envelope with the agent's own `output_schema` in the `result` slot. */
export function buildEnvelopeSchema(outputSchema: Record<string, unknown>): Record<string, unknown> {
  const result = Object.keys(outputSchema).length > 0 ? outputSchema : { type: 'object' };
  return {
    type: 'object',
    additionalProperties: false,
    required: ['status', 'summary', 'artifacts', 'handoff', 'result'],
    properties: {
      status: { type: 'string', enum: ['completed', 'needs_input', 'failed'] },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      artifacts: {
        type: 'array',
        maxItems: 50,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['path', 'type', 'content'],
          properties: {
            path: { type: 'string', minLength: 1, maxLength: 500 },
            type: { type: 'string', minLength: 1, maxLength: 60 },
            content: { type: 'string', minLength: 1 },
          },
        },
      },
      handoff: {
        type: 'object',
        additionalProperties: false,
        required: ['decisions', 'assumptions', 'open_questions', 'required_actions'],
        properties: {
          to_agent: { type: 'string', pattern: '^[a-z][a-z0-9_]{1,39}$' },
          decisions: stringList,
          assumptions: stringList,
          open_questions: stringList,
          required_actions: stringList,
        },
      },
      result,
    },
  };
}

/** Checks that a document is a usable JSON Schema; returns the compile error message or null. */
export function jsonSchemaError(schema: Record<string, unknown>): string | null {
  try {
    new Ajv({ strict: false, allErrors: true }).compile(schema);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`.trim());
}

export type ParsedAgentOutput =
  | { ok: true; envelope: AgentOutputEnvelope }
  | { ok: false; errors: string[] };

/** Models often wrap JSON in a Markdown fence; the payload itself must still be pure JSON. */
function extractJson(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n```\s*$/i.exec(text);
  return (fenced ? fenced[1]! : text).trim();
}

/**
 * Parses and validates a model response against the envelope. An agent's claim is never trusted on its
 * own: a response that does not satisfy the schema is rejected with the precise violations.
 */
export function parseAgentOutput(
  response: { text: string; structuredOutput: unknown },
  outputSchema: Record<string, unknown>,
): ParsedAgentOutput {
  let candidate: unknown = response.structuredOutput;
  if (candidate === null || candidate === undefined) {
    try {
      candidate = JSON.parse(extractJson(response.text));
    } catch {
      return { ok: false, errors: ['output is not valid JSON'] };
    }
  }
  const ajv = new Ajv({ strict: false, allErrors: true });
  // The envelope is checked first; `result` must satisfy the agent's own schema only when it claims
  // completion — a clarifying question or a reported failure has no result to deliver.
  const validateEnvelope = ajv.compile(buildEnvelopeSchema({}));
  if (!validateEnvelope(candidate)) return { ok: false, errors: formatErrors(validateEnvelope.errors) };
  const envelope = candidate as AgentOutputEnvelope;
  if (envelope.status === 'completed' && Object.keys(outputSchema).length > 0) {
    const validateResult = ajv.compile(outputSchema);
    if (!validateResult(envelope.result)) {
      return {
        ok: false,
        // formatErrors yields "/path message" or "/ message" for the root: re-anchor it under /result.
        errors: formatErrors(validateResult.errors).map((e) => `/result${e.startsWith('/ ') ? e.slice(1) : e}`),
      };
    }
  }
  if (envelope.status === 'needs_input' && envelope.handoff.open_questions.length === 0) {
    return { ok: false, errors: ['/handoff/open_questions must list at least one question when status is needs_input'] };
  }
  if (envelope.status !== 'completed' && envelope.artifacts.length > 0) {
    return { ok: false, errors: ['/artifacts must be empty unless status is completed'] };
  }
  return { ok: true, envelope };
}
