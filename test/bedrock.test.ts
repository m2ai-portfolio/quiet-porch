import { describe, expect, it } from 'vitest';
import { bedrockConfigFromEnv, converse, imageBlock, parseModelJson } from '../src/bedrock.ts';

const cfg = { region: 'us-east-1', modelId: 'global.anthropic.claude-sonnet-4-6', apiKey: 'k' };

describe('parseModelJson', () => {
  it('parses bare JSON and the fenced form seen at the gate', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('fails closed on prose around the object', () => {
    expect(() => parseModelJson('Here you go: {"a":1}')).toThrow(/not JSON/);
    expect(() => parseModelJson('```json\n{"a":1}\n``` thanks')).toThrow(/not JSON/);
  });
});

describe('bedrockConfigFromEnv', () => {
  it('names every missing variable', () => {
    expect(() => bedrockConfigFromEnv({ AWS_REGION: 'us-east-1' })).toThrow(
      'bedrock: missing env BEDROCK_MODEL_ID, AWS_BEARER_TOKEN_BEDROCK',
    );
  });
});

describe('converse', () => {
  it('sends bearer auth, the encoded model id and base64 image, and joins text blocks', async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(
        JSON.stringify({
          output: { message: { content: [{ text: '{"a"' }, { text: ':1}' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 10, outputTokens: 3 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const r = await converse(cfg, [{ text: 'hi' }, imageBlock(Buffer.from('jpg'))], { fetchImpl });
    expect(seen!.url).toBe(
      'https://bedrock-runtime.us-east-1.amazonaws.com/model/global.anthropic.claude-sonnet-4-6/converse',
    );
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer k');
    const body = JSON.parse(String(seen!.init.body));
    expect(body.messages[0].content[1].image.source.bytes).toBe(
      Buffer.from('jpg').toString('base64'),
    );
    expect(r).toMatchObject({
      text: '{"a":1}',
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 3,
    });
  });
  it('throws with status on HTTP errors and on empty content', async () => {
    const err = (async () => new Response('denied', { status: 403 })) as unknown as typeof fetch;
    await expect(converse(cfg, [{ text: 'x' }], { fetchImpl: err })).rejects.toThrow(
      'HTTP 403 denied',
    );
    const empty = (async () =>
      new Response(JSON.stringify({ output: { message: { content: [] } } }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(converse(cfg, [{ text: 'x' }], { fetchImpl: empty })).rejects.toThrow(/no text/);
  });
});

describe('request ids for the friction log', () => {
  const ok = (headers: Record<string, string>) =>
    (async () =>
      new Response(
        JSON.stringify({
          output: { message: { content: [{ text: 'hi' }] } },
          stopReason: 'end_turn',
          usage: { inputTokens: 3, outputTokens: 1 },
        }),
        { status: 200, headers },
      )) as unknown as typeof fetch;
  const cfg = { region: 'us-east-1', modelId: 'm', apiKey: 'k' };

  it('keeps x-amzn-requestid from a good answer and puts it in an error message', async () => {
    const r = await converse(cfg, [{ text: 'x' }], {
      fetchImpl: ok({ 'x-amzn-requestid': 'rid-123' }),
    });
    expect(r.requestId).toBe('rid-123');
    const bad = (async () =>
      new Response('nope', {
        status: 429,
        headers: { 'x-amzn-requestid': 'rid-9' },
      })) as unknown as typeof fetch;
    await expect(converse(cfg, [{ text: 'x' }], { fetchImpl: bad })).rejects.toThrow(
      'HTTP 429 [rid-9]',
    );
  });

  it('has no requestId field when the service sent none', async () => {
    const r = await converse(cfg, [{ text: 'x' }], { fetchImpl: ok({}) });
    expect(r).not.toHaveProperty('requestId');
  });
});
