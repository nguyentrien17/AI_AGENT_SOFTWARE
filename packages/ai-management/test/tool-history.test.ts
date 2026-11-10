import { describe, expect, it } from 'vitest';
import {
  AnthropicAdapter,
  type ChatMessage,
  GeminiAdapter,
  OpenAiCompatibleAdapter,
  type ProviderAdapter,
} from '../src/index.js';

/**
 * Regression: a tool result is only accepted by providers when the assistant turn that made the call is
 * replayed with its tool calls. TEST-ONLY capturing fetch (Blueprint §20.3).
 */
const history: ChatMessage[] = [
  { role: 'user', content: 'Read two files.' },
  {
    role: 'assistant',
    content: 'Reading.',
    toolCalls: [
      { id: 'call_1', name: 'fs_read_file', arguments: { path: 'a.ts' } },
      { id: 'call_2', name: 'fs_read_file', arguments: { path: 'b.ts' } },
    ],
  },
  { role: 'tool', content: 'A', toolCallId: 'call_1', toolName: 'fs_read_file' },
  { role: 'tool', content: 'B', toolCallId: 'call_2', toolName: 'fs_read_file' },
];

async function capture(adapter: (f: typeof fetch) => ProviderAdapter, okBody: unknown) {
  let body: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(okBody), { status: 200 });
  };
  await adapter(fetchImpl).invoke({ baseUrl: 'https://x.local/v1', apiKey: 'k-123456', config: {} }, {
    modelKey: 'm',
    messages: history,
  });
  return body;
}

describe('tool-call history serialization', () => {
  it('OpenAI-compatible: assistant tool_calls precede each tool result', async () => {
    const body = await capture((f) => new OpenAiCompatibleAdapter(f), {
      choices: [{ message: { role: 'assistant', content: 'done' } }],
    });
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Read two files.' },
      {
        role: 'assistant',
        content: 'Reading.',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'fs_read_file', arguments: '{"path":"a.ts"}' } },
          { id: 'call_2', type: 'function', function: { name: 'fs_read_file', arguments: '{"path":"b.ts"}' } },
        ],
      },
      { role: 'tool', content: 'A', tool_call_id: 'call_1' },
      { role: 'tool', content: 'B', tool_call_id: 'call_2' },
    ]);
  });

  it('Anthropic: tool_use blocks, then all tool_result blocks in one user message', async () => {
    const body = await capture((f) => new AnthropicAdapter(f), { content: [{ type: 'text', text: 'done' }] });
    expect(body['messages']).toEqual([
      { role: 'user', content: 'Read two files.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Reading.' },
          { type: 'tool_use', id: 'call_1', name: 'fs_read_file', input: { path: 'a.ts' } },
          { type: 'tool_use', id: 'call_2', name: 'fs_read_file', input: { path: 'b.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'A' },
          { type: 'tool_result', tool_use_id: 'call_2', content: 'B' },
        ],
      },
    ]);
  });

  it('Gemini: functionCall parts, then all functionResponse parts in one entry', async () => {
    const body = await capture((f) => new GeminiAdapter(f), {
      candidates: [{ content: { parts: [{ text: 'done' }] } }],
    });
    expect(body['contents']).toEqual([
      { role: 'user', parts: [{ text: 'Read two files.' }] },
      {
        role: 'model',
        parts: [
          { text: 'Reading.' },
          { functionCall: { name: 'fs_read_file', args: { path: 'a.ts' } } },
          { functionCall: { name: 'fs_read_file', args: { path: 'b.ts' } } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'fs_read_file', response: { result: 'A' } } },
          { functionResponse: { name: 'fs_read_file', response: { result: 'B' } } },
        ],
      },
    ]);
  });
});
