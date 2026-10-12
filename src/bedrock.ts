// Bedrock Converse client. Bearer auth with a Bedrock API key (AWS_BEARER_TOKEN_BEDROCK), no SigV4.
// Gate 2026-10-06: global.anthropic.claude-sonnet-4-6 wraps JSON in a code fence even when told
// not to, so callers parse through parseModelJson rather than JSON.parse.

export interface BedrockConfig {
  region: string;
  modelId: string;
  apiKey: string;
  timeoutMs?: number;
}

export type ContentBlock =
  { text: string } | { image: { format: 'jpeg' | 'png'; source: { bytes: string } } };

export interface ConverseResult {
  text: string;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  requestId?: string; // x-amzn-requestid, for the friction log
}

export function bedrockConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BedrockConfig {
  const region = env.AWS_REGION;
  const modelId = env.BEDROCK_MODEL_ID;
  const apiKey = env.AWS_BEARER_TOKEN_BEDROCK;
  const missing = [
    ['AWS_REGION', region],
    ['BEDROCK_MODEL_ID', modelId],
    ['AWS_BEARER_TOKEN_BEDROCK', apiKey],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) throw new Error(`bedrock: missing env ${missing.join(', ')}`);
  return { region: region!, modelId: modelId!, apiKey: apiKey! };
}

export function imageBlock(jpeg: Buffer): ContentBlock {
  return { image: { format: 'jpeg', source: { bytes: jpeg.toString('base64') } } };
}

export async function converse(
  cfg: BedrockConfig,
  content: ContentBlock[],
  opts: { maxTokens?: number; fetchImpl?: typeof fetch } = {},
): Promise<ConverseResult> {
  const url = `https://bedrock-runtime.${cfg.region}.amazonaws.com/model/${encodeURIComponent(cfg.modelId)}/converse`;
  const started = Date.now();
  const res = await (opts.fetchImpl ?? fetch)(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [{ role: 'user', content }],
      inferenceConfig: { maxTokens: opts.maxTokens ?? 400, temperature: 0 },
    }),
    signal: AbortSignal.timeout(cfg.timeoutMs ?? 15_000),
  });
  const requestId = res.headers.get('x-amzn-requestid') ?? undefined;
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`bedrock: HTTP ${res.status}${requestId ? ` [${requestId}]` : ''} ${detail}`);
  }
  const body = (await res.json()) as {
    output?: { message?: { content?: { text?: string }[] } };
    stopReason?: string;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  const text = (body.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
  if (!text) throw new Error('bedrock: response has no text content');
  return {
    text,
    stopReason: body.stopReason ?? 'unknown',
    inputTokens: body.usage?.inputTokens ?? 0,
    outputTokens: body.usage?.outputTokens ?? 0,
    latencyMs: Date.now() - started,
    ...(requestId ? { requestId } : {}),
  };
}

// Accepts bare JSON or one fenced block (``` or ```json). Anything else is an error, so prose
// around the object fails closed instead of being guessed at.
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch (e) {
    throw new Error(`bedrock: model output is not JSON (${(e as Error).message})`);
  }
}
