import { describe, expect, it } from 'vitest';
import { escalatedComplexity, jsonSchemaError, normalizeDefinition, parseAgentOutput } from '../src/index.js';

const schema = {
  type: 'object',
  required: ['verdict'],
  properties: { verdict: { type: 'string', enum: ['approved', 'changes_requested'] } },
};
const handoff = { decisions: [], assumptions: [], open_questions: [], required_actions: [] };
const reply = (value: unknown) => ({ text: typeof value === 'string' ? value : JSON.stringify(value), structuredOutput: null });

describe('agent output contract (P5-02)', () => {
  it('accepts a valid envelope, including one wrapped in a Markdown fence', () => {
    const env = { status: 'completed', summary: 's', artifacts: [], handoff, result: { verdict: 'approved' } };
    expect(parseAgentOutput(reply(env), schema)).toEqual({ ok: true, envelope: env });
    expect(parseAgentOutput(reply('```json\n' + JSON.stringify(env) + '\n```'), schema).ok).toBe(true);
    expect(parseAgentOutput({ text: '', structuredOutput: env }, schema).ok).toBe(true);
  });

  it('names every violation precisely', () => {
    expect(parseAgentOutput(reply('The answer is 42.'), schema)).toEqual({ ok: false, errors: ['output is not valid JSON'] });
    const missing = parseAgentOutput(reply({ status: 'completed', summary: 's' }), schema);
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.errors.join('|')).toMatch(/must have required property 'artifacts'/);
    const badResult = parseAgentOutput(
      reply({ status: 'completed', summary: 's', artifacts: [], handoff, result: { verdict: 'maybe' } }),
      schema,
    );
    expect(!badResult.ok && badResult.errors).toEqual(['/result/verdict must be equal to one of the allowed values']);
    const emptyResult = parseAgentOutput(reply({ status: 'completed', summary: 's', artifacts: [], handoff, result: {} }), schema);
    expect(!emptyResult.ok && emptyResult.errors).toEqual(["/result must have required property 'verdict'"]);
  });

  it('does not demand a result from a clarifying question, but demands the question', () => {
    const asks = { status: 'needs_input', summary: 's', artifacts: [], handoff: { ...handoff, open_questions: ['Who?'] }, result: {} };
    expect(parseAgentOutput(reply(asks), schema).ok).toBe(true);
    const silent = parseAgentOutput(reply({ ...asks, handoff }), schema);
    expect(!silent.ok && silent.errors[0]).toMatch(/open_questions must list at least one question/);
    const sneaky = parseAgentOutput(
      reply({ ...asks, artifacts: [{ path: 'a.md', type: 't', content: 'x' }] }),
      schema,
    );
    expect(!sneaky.ok && sneaky.errors[0]).toMatch(/artifacts must be empty/);
  });

  it('validates agent definitions and escalates complexity on retries', () => {
    expect(jsonSchemaError({ type: 'not-a-type' })).not.toBeNull();
    expect(() => normalizeDefinition({ systemInstruction: ' ' })).toThrow(/systemInstruction/);
    expect(() => normalizeDefinition({ systemInstruction: 'x', outputSchema: { type: 'nope' } })).toThrow(/valid JSON Schema/);
    expect(normalizeDefinition({ systemInstruction: 'x', allowedTools: ['b', 'a', 'a'] }).allowedTools).toEqual(['a', 'b']);
    expect(escalatedComplexity('medium', 1)).toBe('medium');
    expect(escalatedComplexity('medium', 2)).toBe('high');
    expect(escalatedComplexity('critical', 3)).toBe('critical');
  });
});
