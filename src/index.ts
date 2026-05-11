import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const app = new Hono();

function generateRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ========== Configuration ==========

import { env } from "hono/adapter";
import type { Context } from "hono";


type RuntimeKey =
  | "BLOOME_API_KEY"
  | "CLIENT_API_KEY"
  | "ANTHROPIC_DEFAULT_MAX_TOKENS"
  | "GEMINI_DEFAULT_MAX_TOKENS";

function getEnv(c: Context, key: RuntimeKey): string {
  try {
    const runtimeEnv = env<Record<string, string>>(c);
    const val = runtimeEnv?.[key];
    if (val) return val;
  } catch (e) {
    // env() throws in some edge runtimes
  }
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return process.env[key] as string;
  }
  // __EDGESPARK_INJECT_VARS__
  return "";
}

function getProcessEnv(key: string): string {
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return process.env[key] as string;
  }
  return "";
}

function parsePositiveInt(value: string, fallback: number): number {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getDefaultMaxTokens(c: Context, key: RuntimeKey, fallback: number): number {
  return parsePositiveInt(getEnv(c, key), fallback);
}

function getAnthropicDefaultMaxTokens(c: Context, model: string): number {
  const configured = getEnv(c, "ANTHROPIC_DEFAULT_MAX_TOKENS");
  if (configured) return parsePositiveInt(configured, 8192);

  const m = String(model || "").toLowerCase();
  const exactDefaults: Record<string, number> = {
    "claude-opus-4-7": 128000,
    "claude-opus-4-7-thinking": 128000,
    "claude-opus-4-6": 128000,
    "claude-opus-4-6-thinking": 128000,
    "claude-sonnet-4-6": 128000,
    "claude-sonnet-4-6-thinking": 128000,
    "claude-haiku-4-5": 64000,
    "claude-haiku-4-5-thinking": 64000,
    "minimax-m2.7": 131072,
  };
  if (exactDefaults[m] !== undefined) return exactDefaults[m];
  return 8192;
}

function getGeminiDefaultMaxTokens(c: Context, model: string): number {
  const configured = getEnv(c, "GEMINI_DEFAULT_MAX_TOKENS");
  if (configured) return parsePositiveInt(configured, 65536);

  const m = String(model || "").toLowerCase();
  const exactDefaults: Record<string, number> = {
    "gemini-3.1-pro": 65536,
    "gemini-3.1-pro-thinking": 65536,
    "gemini-3-flash": 65536,
    "gemini-3-flash-thinking": 65536,
  };
  if (exactDefaults[m] !== undefined) return exactDefaults[m];
  return 65536;
}

function secureCompare(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

function getClientToken(c: Context): string {
  const auth = c.req.header("authorization");
  if (auth) {
    const bearer = auth.replace(/^Bearer\s+/i, "").trim();
    if (bearer) return bearer;
  }
  const xApiKey = c.req.header("x-api-key")?.trim();
  if (xApiKey) return xApiKey;
  return "";
}

const API_PREFIX = getProcessEnv("API_PREFIX") || "/api/public/v1";

app.use(`${API_PREFIX}/*`, async (c, next) => {
  const requestId = generateRequestId();
  const start = Date.now();

  c.header("x-request-id", requestId);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", "Authorization, Content-Type, x-api-key");
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Expose-Headers", "x-request-id");

  await next();

  const duration = Date.now() - start;
  console.log(JSON.stringify({
    type: "access",
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    durationMs: duration,
  }));
});

app.options(`${API_PREFIX}/*`, (c) => c.text("", 200, {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, x-api-key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "x-request-id",
  "x-request-id": c.res.headers.get("x-request-id") || generateRequestId(),
}));

app.get(`${API_PREFIX}/health`, async (c) => {
  const upstream = await checkUpstreamHealth(c);
  const status = upstream.ok ? "ok" : "degraded";
  return c.json({
    status,
    config: {
      bloomeApiKey: !!getEnv(c, "BLOOME_API_KEY"),
      clientApiKey: !!getEnv(c, "CLIENT_API_KEY"),
    },
    upstream,
    requestId: c.res.headers.get("x-request-id") || "",
  }, upstream.ok ? 200 : 503);
}); // EdgeSpark requires /api/*

app.use(`${API_PREFIX}/*`, async (c, next) => {
  if (c.req.method === "OPTIONS" || c.req.path === `${API_PREFIX}/health`) {
    await next();
    return;
  }

  const expectedKey = getEnv(c, "CLIENT_API_KEY");
  if (!expectedKey) {
    return c.json({ error: { message: "Server not configured: missing CLIENT_API_KEY", type: "server_error" }, request_id: c.res.headers.get("x-request-id") || "" }, 500);
  }

  const token = getClientToken(c);
  if (!secureCompare(token, expectedKey)) {
    return c.json({ error: { message: "Invalid API key", type: "authentication_error" }, request_id: c.res.headers.get("x-request-id") || "" }, 401);
  }
  await next();
});


const BLOOME_LLM_BASE = "https://stream.bloome.im/api/llm/proxy/reson";

async function checkUpstreamHealth(c: Context): Promise<any> {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return { ok: false, error: "missing BLOOME_API_KEY" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  const startedAt = Date.now();

  try {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "kimi-k2.6",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 1,
      }),
      signal: controller.signal,
    });

    const latencyMs = Date.now() - startedAt;
    const data = await resp.json().catch(() => null);
    const hasChoices = Array.isArray(data?.choices) && data.choices.length > 0;

    return {
      ok: resp.ok && hasChoices,
      status: resp.status,
      latencyMs,
      model: "kimi-k2.6",
      hasChoices,
      upstreamRequestId: resp.headers.get("x-request-id") || null,
      error: data?.error?.message || null,
    };
  } catch (err: any) {
    return {
      ok: false,
      status: null,
      latencyMs: Date.now() - startedAt,
      model: "kimi-k2.6",
      hasChoices: false,
      error: err?.name === "AbortError" ? "upstream timeout" : (err?.message || "upstream request failed"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const MODELS = [
  { id: "claude-opus-4-7", object: "model", created: 1687882411, owned_by: "reson", root: "claude-opus-4-7", parent: null },
  { id: "claude-opus-4-7-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "claude-opus-4-7-thinking", parent: "claude-opus-4-7" },
  { id: "claude-opus-4-6", object: "model", created: 1687882411, owned_by: "reson", root: "claude-opus-4-6", parent: null },
  { id: "claude-opus-4-6-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "claude-opus-4-6-thinking", parent: "claude-opus-4-6" },
  { id: "claude-sonnet-4-6", object: "model", created: 1687882411, owned_by: "reson", root: "claude-sonnet-4-6", parent: null },
  { id: "claude-sonnet-4-6-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "claude-sonnet-4-6-thinking", parent: "claude-sonnet-4-6" },
  { id: "claude-haiku-4-5", object: "model", created: 1687882411, owned_by: "reson", root: "claude-haiku-4-5", parent: null },
  { id: "claude-haiku-4-5-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "claude-haiku-4-5-thinking", parent: "claude-haiku-4-5" },
  { id: "gpt-5.4", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.4", parent: null },
  { id: "gpt-5.4-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.4-thinking", parent: "gpt-5.4" },
  { id: "gpt-5.4-mini", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.4-mini", parent: null },
  { id: "gpt-5.4-mini-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.4-mini-thinking", parent: "gpt-5.4-mini" },
  { id: "glm-5.1", object: "model", created: 1687882411, owned_by: "reson", root: "glm-5.1", parent: null },
  { id: "kimi-k2.6", object: "model", created: 1687882411, owned_by: "reson", root: "kimi-k2.6", parent: null },
  { id: "kimi-k2.5", object: "model", created: 1687882411, owned_by: "reson", root: "kimi-k2.5", parent: null },
  { id: "mimo-v2-pro", object: "model", created: 1687882411, owned_by: "reson", root: "mimo-v2-pro", parent: null },
  { id: "mimo-v2-omni", object: "model", created: 1687882411, owned_by: "reson", root: "mimo-v2-omni", parent: null },
  { id: "deepseek-v4-pro", object: "model", created: 1687882411, owned_by: "reson", root: "deepseek-v4-pro", parent: null },
  { id: "deepseek-v4-flash", object: "model", created: 1687882411, owned_by: "reson", root: "deepseek-v4-flash", parent: null },
  { id: "deepseek-v3-2", object: "model", created: 1687882411, owned_by: "reson", root: "deepseek-v3-2", parent: null },
  { id: "gemini-3.1-pro", object: "model", created: 1687882411, owned_by: "reson", root: "gemini-3.1-pro", parent: null },
  { id: "gemini-3.1-pro-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "gemini-3.1-pro-thinking", parent: "gemini-3.1-pro" },
  { id: "gemini-3-flash", object: "model", created: 1687882411, owned_by: "reson", root: "gemini-3-flash", parent: null },
  { id: "gemini-3-flash-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "gemini-3-flash-thinking", parent: "gemini-3-flash" },
  { id: "MiniMax-M2.7", object: "model", created: 1687882411, owned_by: "reson", root: "MiniMax-M2.7", parent: null }
];

// ========== Helpers ==========

function isClaudeModel(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("claude");
}

function isAnthropicModel(model: string): boolean {
  return isClaudeModel(model) || model === "MiniMax-M2.7";
}

function isClaudeThinkingAlias(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("claude") && model.toLowerCase().endsWith("-thinking");
}

function getClaudeThinkingConfig(model: string): { publicModel: string; upstreamModel: string; thinking?: any; output_config?: any } {
  const publicModel = model;
  const upstreamModel = isClaudeThinkingAlias(model) ? model.slice(0, -"-thinking".length) : model;

  if (!isClaudeThinkingAlias(model)) {
    return { publicModel, upstreamModel };
  }

  switch (upstreamModel) {
    case "claude-opus-4-7":
      return {
        publicModel,
        upstreamModel,
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
      };
    case "claude-opus-4-6":
    case "claude-sonnet-4-6":
      return {
        publicModel,
        upstreamModel,
        thinking: { type: "adaptive" },
      };
    case "claude-haiku-4-5":
      return {
        publicModel,
        upstreamModel,
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
    default:
      return { publicModel, upstreamModel };
  }
}


function isGoogleModel(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("gemini");
}

function isGoogleThinkingAlias(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("gemini") && model.toLowerCase().endsWith("-thinking");
}

function getGoogleThinkingConfig(model: string): { publicModel: string; upstreamModel: string; includeThoughts: boolean } {
  const publicModel = model;
  const upstreamModel = isGoogleThinkingAlias(model) ? model.slice(0, -"-thinking".length) : model;
  return { publicModel, upstreamModel, includeThoughts: isGoogleThinkingAlias(model) };
}

function isGPTThinkingAlias(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("gpt-5") && model.toLowerCase().endsWith("-thinking");
}

function getGPTThinkingConfig(model: string): { publicModel: string; upstreamModel: string; reasoningEffort?: string } {
  const publicModel = model;
  const upstreamModel = isGPTThinkingAlias(model) ? model.slice(0, -"-thinking".length) : model;
  return { publicModel, upstreamModel, reasoningEffort: isGPTThinkingAlias(model) ? "medium" : undefined };
}

function mapOpenAIToGoogleToolConfig(toolChoice: any): any {
  if (toolChoice === undefined || toolChoice === "auto") return undefined;
  if (toolChoice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (toolChoice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (toolChoice?.type === "function" && toolChoice.function?.name) {
    return {
      functionCallingConfig: {
        mode: "ANY",
        allowedFunctionNames: [toolChoice.function.name],
      },
    };
  }
  return undefined;
}

function isReasoningModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const m = model.toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

function hasLegacyFunctionUse(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.functions !== undefined || body.function_call !== undefined) {
    return true;
  }
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((m: any) =>
    m &&
    typeof m === "object" &&
    m.function_call !== undefined
  );
}

function hasToolUse(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  if (body.tools !== undefined || body.tool_choice !== undefined) return true;
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some((m: any) =>
    m &&
    typeof m === "object" &&
    (m.role === "tool" || m.tool_call_id !== undefined || m.tool_calls !== undefined)
  );
}

function openAIToolCallDelta(index: number, id?: string, name?: string, argumentsDelta?: string): any {
  const toolCall: any = { index, type: "function" };
  if (id !== undefined) toolCall.id = id;
  const fn: any = {};
  if (name !== undefined) fn.name = name;
  if (argumentsDelta !== undefined) fn.arguments = argumentsDelta;
  if (Object.keys(fn).length > 0) toolCall.function = fn;
  return { tool_calls: [toolCall] };
}

function getOpenAIFunctionTools(body: any): any[] {
  if (!Array.isArray(body?.tools)) return [];
  return body.tools
    .filter((tool: any) => tool?.type === "function" && tool.function?.name)
    .map((tool: any) => ({
      ...tool.function,
      cache_control: tool.function.cache_control ?? tool.cache_control,
    }));
}

function fallbackJsonSchema(): any {
  return { type: "object", properties: {} };
}

function parseToolArguments(args: any): any {
  if (args == null || args === "") return {};
  if (typeof args === "object") return args;
  if (typeof args !== "string") return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function stringifyToolArguments(args: any): string {
  if (args == null) return "{}";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return "{}";
  }
}

function stableJson(value: any): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function hashString(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function getSystemMessages(messages: any[]): any[] {
  if (!Array.isArray(messages)) return [];
  return messages
    .filter((m: any) => m?.role === "system")
    .map((m: any) => m.content);
}

function buildPromptCacheKey(body: any): string | undefined {
  const seed: any = {
    model: body.model,
    system: getSystemMessages(body.messages || []),
  };
  if (Array.isArray(body.tools) && body.tools.length > 0) seed.tools = body.tools;
  if (body.response_format !== undefined) seed.response_format = body.response_format;
  if (seed.system.length === 0 && seed.tools === undefined && seed.response_format === undefined) return undefined;
  return `bloome-${hashString(stableJson(seed))}`;
}

function maybeInjectOpenAIPromptCacheKey(body: any): void {
  if (body.prompt_cache === false || body.cache === false || body.prompt_cache_key !== undefined) return;
  if (!String(body.model || "").toLowerCase().startsWith("gpt-")) return;
  const key = buildPromptCacheKey(body);
  if (key) body.prompt_cache_key = key;
}

function stripInternalPromptCacheFlags(body: any): void {
  delete body.prompt_cache;
  if (typeof body.cache === "boolean") delete body.cache;
}

function normalizeToolResultContent(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function collectToolCallNames(messages: any[]): Record<string, string> {
  const names: Record<string, string> = {};
  if (!Array.isArray(messages)) return names;
  for (const m of messages) {
    if (!Array.isArray(m?.tool_calls)) continue;
    for (const call of m.tool_calls) {
      const id = call?.id;
      const name = call?.function?.name;
      if (id && name) names[id] = name;
    }
  }
  return names;
}

// ========== OpenAI ↔ Anthropic conversion ==========

function parseDataUrl(url: string) {
  if (!url) return null;
  const match = url.match(/^data:([a-zA-Z0-9]+\/[a-zA-Z0-9\-\+]+);base64,(.+)$/);
  if (match) return { mimeType: match[1], data: match[2] };
  return null;
}

function mapOpenAIToAnthropicToolChoice(toolChoice: any): any {
  if (toolChoice === undefined) return undefined;
  if (toolChoice === "none") return { type: "none" };
  if (toolChoice === "auto") return { type: "auto" };
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice?.type === "function" && toolChoice.function?.name) {
    return { type: "tool", name: toolChoice.function.name };
  }
  return undefined;
}

function normalizeAnthropicCacheControl(cacheControl: any): any | undefined {
  if (cacheControl === undefined || cacheControl === null || cacheControl === false) return undefined;
  if (cacheControl === true) return { type: "ephemeral", ttl: "5m" };
  if (typeof cacheControl !== "object") return undefined;

  const normalized: any = { type: cacheControl.type || "ephemeral" };
  if (typeof cacheControl.ttl === "string" && cacheControl.ttl) {
    normalized.ttl = cacheControl.ttl;
  }
  return normalized;
}

function defaultPromptCacheControl(): any {
  return { type: "ephemeral", ttl: "5m" };
}

function hasCacheControl(value: any): boolean {
  if (!value || typeof value !== "object") return false;
  if (value.cache_control !== undefined) return true;
  if (Array.isArray(value)) return value.some(hasCacheControl);
  return Object.values(value).some(hasCacheControl);
}

function attachCacheControl(block: any, cacheControl: any): any {
  const normalized = normalizeAnthropicCacheControl(cacheControl);
  return normalized ? { ...block, cache_control: normalized } : block;
}

function attachCacheControlToLastTextBlock(blocks: any[], cacheControl: any): any[] {
  const normalized = normalizeAnthropicCacheControl(cacheControl);
  if (!normalized) return blocks;

  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === "text") {
      blocks[i] = { ...blocks[i], cache_control: normalized };
      break;
    }
  }
  return blocks;
}

/**
 * Convert OpenAI chat completions request to Anthropic Messages format.
 * - Extracts `system` messages to top-level `system` field
 * - Maps `max_tokens` (Anthropic requires it)
 * - Preserves Anthropic `cache_control` on text/tool blocks
 */
function openaiToAnthropicRequest(body: any, defaultMaxTokens: number): any {
  const thinkingCfg = getClaudeThinkingConfig(body.model || "");
  const autoPromptCache = body.prompt_cache !== false && body.cache !== false;
  const out: any = {
    model: thinkingCfg.upstreamModel,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? defaultMaxTokens,
    messages: [],
  };
  if (body.stream) out.stream = true;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (thinkingCfg.thinking) out.thinking = thinkingCfg.thinking;
  if (thinkingCfg.output_config) out.output_config = thinkingCfg.output_config;
  const tools = getOpenAIFunctionTools(body);
  if (tools.length > 0) {
    out.tools = tools.map((tool: any) => attachCacheControl({
      name: tool.name,
      description: tool.description || "",
      input_schema: tool.parameters || fallbackJsonSchema(),
    }, tool.cache_control));
  }
  const toolChoice = mapOpenAIToAnthropicToolChoice(body.tool_choice);
  if (toolChoice) out.tool_choice = toolChoice;

  const explicitCacheControl = hasCacheControl(body);
  const systemBlocks: any[] = [];
  const systemTextParts: string[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "system") {
        if (typeof m.content === "string") {
          systemBlocks.push(attachCacheControl({ type: "text", text: m.content }, m.cache_control));
          systemTextParts.push(m.content);
        } else if (Array.isArray(m.content)) {
          const blocks: any[] = [];
          const texts: string[] = [];
          for (const p of m.content) {
            if (!p) continue;
            if (typeof p === "string") {
              blocks.push({ type: "text", text: p });
              texts.push(p);
            } else if (p.type === "text") {
              blocks.push(attachCacheControl({ type: "text", text: p.text || "" }, p.cache_control));
              texts.push(p.text || "");
            }
          }
          systemBlocks.push(...attachCacheControlToLastTextBlock(blocks, m.cache_control));
          systemTextParts.push(texts.join(""));
        }
        continue;
      }
      if (m.role === "tool") {
        out.messages.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: m.tool_call_id || "",
            content: normalizeToolResultContent(m.content),
          }],
        });
        continue;
      }
      let content: any = m.content;
      const contentBlocks: any[] = [];
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p) continue;
          if (typeof p === "string") contentBlocks.push({ type: "text", text: p });
          else if (p.type === "text") contentBlocks.push(attachCacheControl({ type: "text", text: p.text || "" }, p.cache_control));
          else if (p.type === "image_url" && p.image_url?.url) {
            const parsed = parseDataUrl(p.image_url.url);
            if (parsed) {
              contentBlocks.push({ type: "image", source: { type: "base64", media_type: parsed.mimeType, data: parsed.data } });
            } else {
              contentBlocks.push({ type: "text", text: `[Image URL: ${p.image_url.url}]` });
            }
          }
        }
        content = attachCacheControlToLastTextBlock(contentBlocks, m.cache_control);
      } else if (content == null) {
        content = "";
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        const assistantBlocks: any[] = [];
        if (typeof m.content === "string" && m.content) {
          assistantBlocks.push({ type: "text", text: m.content });
        } else if (Array.isArray(content)) {
          assistantBlocks.push(...content.filter((p: any) => p?.type === "text"));
        }
        for (const call of m.tool_calls) {
          if (call?.type !== "function" || !call.function?.name) continue;
          assistantBlocks.push({
            type: "tool_use",
            id: call.id || "",
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          });
        }
        content = assistantBlocks;
      }
      out.messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    }
  }
  if (autoPromptCache && !explicitCacheControl) {
    if (systemBlocks.length > 0) {
      attachCacheControlToLastTextBlock(systemBlocks, defaultPromptCacheControl());
    } else if (Array.isArray(out.tools) && out.tools.length > 0) {
      out.tools[out.tools.length - 1] = attachCacheControl(out.tools[out.tools.length - 1], defaultPromptCacheControl());
    }
  }
  if (systemBlocks.length > 0) {
    out.system = hasCacheControl(systemBlocks)
      ? systemBlocks
      : systemTextParts.join("\n\n");
  }
  return out;
}

function mapAnthropicStopReason(stop: string | null | undefined): string | null {
  switch (stop) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return stop || null;
  }
}

function normalizeOpenAIUsage(usage: any): any {
  const promptTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cleaned: any = {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: usage.total_tokens ?? (promptTokens + completionTokens),
  };
  if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object") {
    cleaned.prompt_tokens_details = { ...usage.prompt_tokens_details };
  } else if (typeof usage.cached_tokens === "number") {
    cleaned.prompt_tokens_details = { cached_tokens: usage.cached_tokens };
  }
  if (usage.completion_tokens_details && typeof usage.completion_tokens_details === "object") {
    cleaned.completion_tokens_details = { ...usage.completion_tokens_details };
  }
  for (const key of ["cache_read_input_tokens", "cache_creation_input_tokens", "cache_creation"]) {
    if (usage[key] !== undefined) cleaned[key] = usage[key];
  }
  return cleaned;
}

function mergeOpenAIUsage(base: any, next: any): any {
  const normalizedNext = normalizeOpenAIUsage(next);
  if (!base) return normalizedNext;
  const merged: any = { ...base, ...normalizedNext };
  if (base.prompt_tokens_details || next.prompt_tokens_details || next.cached_tokens !== undefined) {
    merged.prompt_tokens_details = {
      ...(base.prompt_tokens_details || {}),
      ...(normalizedNext.prompt_tokens_details || {}),
    };
  }
  if (base.completion_tokens_details || next.completion_tokens_details) {
    merged.completion_tokens_details = {
      ...(base.completion_tokens_details || {}),
      ...(normalizedNext.completion_tokens_details || {}),
    };
  }
  return merged;
}

/**
 * Convert Anthropic Messages response back to OpenAI chat completion format.
 * - Concatenates all text blocks from Anthropic's content array
 * - Maps stop_reason to OpenAI finish_reason
 * - Converts input_tokens/output_tokens to prompt_tokens/completion_tokens
 */
function anthropicToOpenaiResponse(data: any, publicModel?: string): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;
  let text = "";
  let reasoning = "";
  const toolCalls: any[] = [];
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") text += block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") reasoning += block.thinking;
      if (block.type === "tool_use" && block.name) {
        toolCalls.push({
          id: block.id || "",
          type: "function",
          function: {
            name: block.name,
            arguments: stringifyToolArguments(block.input),
          },
        });
      }
    }
  }
  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  const cacheReadTokens = data.usage?.cache_read_input_tokens || 0;
  const message: any = { role: "assistant", content: toolCalls.length > 0 && !text ? null : text };
  if (reasoning) message.reasoning_content = reasoning;
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: data.id || "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: publicModel || data.model || "",
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopReason(data.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: cacheReadTokens },
      cache_read_input_tokens: cacheReadTokens,
      cache_creation_input_tokens: data.usage?.cache_creation_input_tokens || 0,
      ...(data.usage?.cache_creation ? { cache_creation: data.usage.cache_creation } : {}),
    },
  };
}


// ========== Google Gemini (Vertex) conversion ==========

function openaiToGoogleRequest(body: any, defaultMaxTokens: number): any {
  const googleCfg = getGoogleThinkingConfig(body.model || "");
  const out: any = { contents: [], generationConfig: {} };
  const systemParts: any[] = [];
  const toolCallNames = collectToolCallNames(body.messages || []);
  if (googleCfg.includeThoughts) {
    out.generationConfig.thinkingConfig = { includeThoughts: true };
  }
  if (body.temperature !== undefined) out.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) out.generationConfig.topP = body.top_p;
  out.generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens ?? defaultMaxTokens;
  if (body.stop) {
    out.generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  const tools = getOpenAIFunctionTools(body);
  if (tools.length > 0) {
    out.tools = [{
      functionDeclarations: tools.map((tool: any) => ({
        name: tool.name,
        description: tool.description || "",
        parameters: tool.parameters || fallbackJsonSchema(),
      })),
    }];
  }
  const toolConfig = mapOpenAIToGoogleToolConfig(body.tool_choice);
  if (toolConfig) out.toolConfig = toolConfig;
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      let parts: any[] = [];
      if (m.role === "tool") {
        const name = m.name || toolCallNames[m.tool_call_id] || "tool_result";
        parts.push({
          functionResponse: {
            name,
            response: { content: normalizeToolResultContent(m.content) },
          },
        });
      } else if (typeof m.content === "string") {
        parts.push({ text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (!p) continue;
          if (typeof p === "string") parts.push({ text: p });
          else if (p.type === "text") parts.push({ text: p.text || "" });
          else if (p.type === "image_url" && p.image_url?.url) {
            const parsed = parseDataUrl(p.image_url.url);
            if (parsed) {
              parts.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.data } });
            } else {
              parts.push({ text: `[Image URL: ${p.image_url.url}]` });
            }
          }
        }
      }
      if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (call?.type !== "function" || !call.function?.name) continue;
          parts.push({
            functionCall: {
              name: call.function.name,
              args: parseToolArguments(call.function.arguments),
            },
          });
        }
      }
      if (m.role === "system") {
        systemParts.push(...parts);
        continue;
      }
      out.contents.push({ role: m.role === "assistant" ? "model" : "user", parts });
    }
  }
  if (systemParts.length > 0) {
    out.systemInstruction = { role: "user", parts: systemParts };
  }
  return out;
}

function mapGoogleFinishReason(reason: string | null | undefined): string | null {
  if (!reason) return null;
  switch (reason.toUpperCase()) {
    case "STOP": return "stop";
    case "MAX_TOKENS": return "length";
    case "SAFETY": return "content_filter";
    default: return reason.toLowerCase();
  }
}

function googleToOpenaiResponse(data: any, publicModel?: string): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;
  const candidate = data.candidates?.[0];
  let text = "";
  let reasoning = "";
  const toolCalls: any[] = [];
  if (candidate?.content?.parts) {
    for (const p of candidate.content.parts) {
      if (!p || typeof p !== "object") continue;
      const t = p.text || "";
      if (p.thought === true) reasoning += t;
      else text += t;
      if (p.functionCall?.name) {
        toolCalls.push({
          id: `call_${toolCalls.length}`,
          type: "function",
          function: {
            name: p.functionCall.name,
            arguments: stringifyToolArguments(p.functionCall.args),
          },
        });
      }
    }
  }
  const pTok = data.usageMetadata?.promptTokenCount || 0;
  const cTok = data.usageMetadata?.candidatesTokenCount || 0;
  const msg: any = { role: "assistant", content: toolCalls.length > 0 && !text ? null : text };
  if (reasoning) msg.reasoning_content = reasoning;
  if (toolCalls.length > 0) msg.tool_calls = toolCalls;
  return {
    id: data.responseId || "",
    object: "chat.completion",
    created: data.createTime ? Math.floor(new Date(data.createTime).getTime()/1000) : Math.floor(Date.now()/1000),
    model: publicModel || data.modelVersion || "",
    choices: [{ index: 0, message: msg, finish_reason: toolCalls.length > 0 ? "tool_calls" : mapGoogleFinishReason(candidate?.finishReason) }],
    usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok }
  };
}

// ========== Cleaning (OpenAI native upstream: Kimi / GPT) ==========

/**
 * Clean upstream OpenAI-format response.
 * - Preserves `reasoning_content` in its own field (never maps to `content`)
 * - Preserves prompt cache usage fields like `prompt_tokens_details.cached_tokens`
 */
function cleanChatCompletion(data: any, publicModel?: string): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;

  const cleaned: any = {
    id: data.id || "",
    object: data.object || "chat.completion",
    created: typeof data.created === "number" ? data.created : Math.floor(Date.now() / 1000),
    model: publicModel || data.model || "",
  };

  if (Array.isArray(data.choices)) {
    cleaned.choices = data.choices.map((choice: any) => {
      const msg: any = { role: "assistant", content: "" };
      if (choice.message) {
        msg.role = choice.message.role || "assistant";
        msg.content = choice.message.content ?? (Array.isArray(choice.message.tool_calls) ? null : "");
        if (choice.message.reasoning_content !== undefined) {
          msg.reasoning_content = choice.message.reasoning_content;
        }
        if (Array.isArray(choice.message.tool_calls)) {
          msg.tool_calls = choice.message.tool_calls;
        }
      }
      return {
        index: typeof choice.index === "number" ? choice.index : 0,
        message: msg,
        finish_reason: choice.finish_reason || null,
      };
    });
  } else {
    cleaned.choices = [];
  }

  if (data.usage && typeof data.usage === "object") {
    cleaned.usage = normalizeOpenAIUsage(data.usage);
  }

  return cleaned;
}

/**
 * Clean one SSE data line from upstream.
 * - Drops trailing `choices: []` chunks (Bloome sends these after finish — clients crash)
 * - Hoists nested `usage` from `choice` to top-level
 * - Adds `logprobs: null` for OpenAI compatibility
 * - Preserves `reasoning_content` in delta
 * Returns null to drop the line entirely.
 */
function cleanSSEDataLine(line: string, publicModel?: string): {
  line: string | null;
  usage?: any;
} {
  if (!line.startsWith("data: ")) return { line };
  const jsonStr = line.slice(6).trim();
  if (jsonStr === "[DONE]") return { line };

  let data: any;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return { line };
  }
  if (!data || typeof data !== "object") return { line };
  if (data.error) return { line };

  // Drop trailing empty-choices chunk (Bloome quirk)
  if (Array.isArray(data.choices) && data.choices.length === 0) return { line: null };

  const cleaned: any = {
    id: data.id || "",
    object: "chat.completion.chunk",
    created: typeof data.created === "number" ? data.created : Math.floor(Date.now() / 1000),
    model: publicModel || data.model || "",
  };

  let extractedUsage: any;

  if (Array.isArray(data.choices)) {
    cleaned.choices = data.choices.map((choice: any) => {
      const delta: any = {};
      if (choice.delta) {
        if (choice.delta.role !== undefined) delta.role = choice.delta.role;
        if (choice.delta.content !== undefined) delta.content = choice.delta.content;
        if (choice.delta.reasoning_content !== undefined) delta.reasoning_content = choice.delta.reasoning_content;
      }
      const out: any = {
        index: typeof choice.index === "number" ? choice.index : 0,
        delta,
        finish_reason: choice.finish_reason || null,
        logprobs: null,
      };
      // Hoist nested usage from choice to top-level (Bloome quirk)
      if (choice.usage && typeof choice.usage === "object") {
        cleaned.usage = mergeOpenAIUsage(cleaned.usage, choice.usage);
        extractedUsage = cleaned.usage;
      }
      return out;
    });
  } else {
    cleaned.choices = [];
  }

  if (data.usage && typeof data.usage === "object") {
    cleaned.usage = mergeOpenAIUsage(cleaned.usage, data.usage);
    extractedUsage = cleaned.usage;
  }

  return { line: "data: " + JSON.stringify(cleaned), usage: extractedUsage };
}

// ========== Routes ==========

/**
 * GET {API_PREFIX}/models
 * Returns hardcoded model list. Only includes models tested & confirmed working
 * against the Bloome LLM proxy.
 */
app.get(`${API_PREFIX}/models`, (c) => {
  // If requested by an Anthropic client
  if (c.req.header("anthropic-version")) {
    const anthropicModels = MODELS.filter(m => isAnthropicModel(m.id)).map(m => ({
      type: "model",
      id: m.id,
      display_name: m.id,
      created_at: new Date(m.created * 1000).toISOString()
    }));
    return c.json({ type: "list", data: anthropicModels });
  }
  // Default OpenAI format
  return c.json({ object: "list", data: MODELS });
});

/**
 * POST {API_PREFIX}/chat/completions
 * OpenAI-compatible chat completions endpoint.
 *
 * Behavior per model:
 * - Anthropic-compatible models → translates to Anthropic Messages, calls /v1/messages, translates back
 * - Gemini models → translates to Vertex GenerateContent format
 * - `gpt-5.x` / `o1` / `o3` / `o4` → rewrites `max_tokens` → `max_completion_tokens`
 * - others (Kimi etc.) → direct passthrough
 *
 * Streaming and non-streaming both supported.
 * All responses cleaned to strict OpenAI format.
 */
app.post(`${API_PREFIX}/chat/completions`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return c.json({ error: { message: "Server not configured: missing BLOOME_API_KEY", type: "server_error" } }, 500);
  }
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  // Reasoning models require max_completion_tokens, not max_tokens
  if (isReasoningModel(body.model)) {
    if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  }

  const isStream = body.stream === true;

  const needsProtocolTranslation = isAnthropicModel(body.model) || isGoogleModel(body.model);
  if (needsProtocolTranslation && hasLegacyFunctionUse(body)) {
    return c.json({
      error: {
        message: "Legacy function_call/functions are not supported for translated Anthropic or Gemini requests; use tools/tool_calls instead",
        type: "invalid_request_error",
      },
    }, 400);
  }
  // ===== Branch 1: Anthropic-compatible models → translate to Anthropic =====
  if (isAnthropicModel(body.model)) {
    const thinkingCfg = getClaudeThinkingConfig(body.model);
    const defaultMaxTokens = getAnthropicDefaultMaxTokens(c, body.model);
    const anthropicBody = openaiToAnthropicRequest(body, defaultMaxTokens);

    if (!isStream) {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      });
      const upstream = await resp.json().catch(() => ({ error: { message: "Upstream error" } }));
      return c.json(upstream.error ? upstream : anthropicToOpenaiResponse(upstream, thinkingCfg.publicModel), resp.status as any);
    }

    // Streaming: convert Anthropic SSE → OpenAI SSE chunks
    return streamSSE(c, async (stream) => {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(anthropicBody),
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text();
        await stream.write(`data: ${JSON.stringify({ error: { message: text, type: "upstream_error" } })}\n\n`);
        await stream.close();
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let chunkId = "", chunkModel = thinkingCfg.publicModel;
      let roleSent = false, lastStop: string | null = null, lastUsage: any = null;
      let sawToolCall = false;
      const toolBlockIndexes = new Map<number, number>();

      const writeChunk = async (delta: any, finish_reason: string | null = null, usage: any = null) => {
        const obj: any = {
          id: chunkId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: chunkModel,
          choices: [{ index: 0, delta, finish_reason, logprobs: null }],
        };
        if (usage) obj.usage = usage;
        await stream.write("data: " + JSON.stringify(obj) + "\n\n");
      };

      try {
        let curEvent = "", curData = "";
        const flush = async () => {
          if (!curEvent || !curData) { curEvent = ""; curData = ""; return; }
          let d: any;
          try { d = JSON.parse(curData); } catch { curEvent = ""; curData = ""; return; }
          if (curEvent === "message_start") {
            const m = d.message || {};
            chunkId = m.id || chunkId;
            if (!roleSent) { await writeChunk({ role: "assistant", content: "" }); roleSent = true; }
          } else if (curEvent === "content_block_start") {
            const block = d.content_block || {};
            if (block.type === "tool_use" && block.name) {
              if (!roleSent) { await writeChunk({ role: "assistant", content: "" }); roleSent = true; }
              const blockIndex = typeof d.index === "number" ? d.index : toolBlockIndexes.size;
              const toolIndex = toolBlockIndexes.size;
              toolBlockIndexes.set(blockIndex, toolIndex);
              sawToolCall = true;
              await writeChunk(openAIToolCallDelta(toolIndex, block.id || `call_${toolIndex}`, block.name, ""));
            }
          } else if (curEvent === "content_block_delta") {
            const dl = d.delta || {};
            if (dl.type === "text_delta" && typeof dl.text === "string" && dl.text) {
              await writeChunk({ content: dl.text });
            } else if (dl.type === "thinking_delta" && typeof dl.thinking === "string" && dl.thinking) {
              await writeChunk({ reasoning_content: dl.thinking });
            } else if (dl.type === "input_json_delta" && typeof dl.partial_json === "string") {
              const blockIndex = typeof d.index === "number" ? d.index : -1;
              const toolIndex = toolBlockIndexes.get(blockIndex);
              if (toolIndex !== undefined && dl.partial_json) {
                sawToolCall = true;
                await writeChunk(openAIToolCallDelta(toolIndex, undefined, undefined, dl.partial_json));
              }
            }
          } else if (curEvent === "message_delta") {
            if (d.delta?.stop_reason) lastStop = d.delta.stop_reason;
            if (d.usage) {
              lastUsage = normalizeOpenAIUsage(d.usage);
            }
          } else if (curEvent === "message_stop") {
            await writeChunk({}, sawToolCall ? "tool_calls" : (mapAnthropicStopReason(lastStop) || "stop"), lastUsage);
          }
          curEvent = ""; curData = "";
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line === "") await flush();
            else if (line.startsWith("event:")) curEvent = line.slice(6).trim();
            else if (line.startsWith("data:")) curData += (curData ? "\n" : "") + line.slice(5).trim();
          }
        }
        if (curEvent) await flush();
        await stream.write("data: [DONE]\n\n");
      } finally {
        reader.releaseLock();
        await stream.close();
      }
    });
  }


  // ===== Branch 3: Google (Gemini via Vertex) =====
  if (isGoogleModel(body.model)) {
    const googleCfg = getGoogleThinkingConfig(body.model);
    const defaultMaxTokens = getGeminiDefaultMaxTokens(c, body.model);
    const googleBody = openaiToGoogleRequest(body, defaultMaxTokens);
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    if (!isStream) {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/models/${googleCfg.upstreamModel}:generateContent`, {
        method: "POST", headers: upstreamHeaders, body: JSON.stringify(googleBody)
      });
      const upstream: any = await resp.json().catch(() => ({ error: { message: "Upstream error" } }));
      return c.json(upstream.error ? upstream : googleToOpenaiResponse(upstream, googleCfg.publicModel), resp.status as any);
    }
    return streamSSE(c, async (stream) => {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/models/${googleCfg.upstreamModel}:streamGenerateContent?alt=sse`, {
        method: "POST", headers: upstreamHeaders, body: JSON.stringify(googleBody)
      });
      if (!resp.ok || !resp.body) {
        const text = await resp.text();
        await stream.write(`data: ${JSON.stringify({ error: { message: text, type: "upstream_error" } })}\n\n`);
        await stream.close();
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let chunkId = "", chunkModel = googleCfg.publicModel, roleSent = false;
      let sawToolCall = false;
      let nextToolIndex = 0;
      const googleToolCallIndexes = new Map<string, number>();
      
      const writeChunk = async (delta: any, finish_reason: string | null = null, usage: any = null) => {
        const obj: any = {
          id: chunkId, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000),
          model: chunkModel, choices: [{ index: 0, delta, finish_reason, logprobs: null }]
        };
        if (usage) obj.usage = usage;
        await stream.write("data: " + JSON.stringify(obj) + "\n\n");
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).replace(/\r$/, "");
            buffer = buffer.slice(nl + 1);
            if (line.startsWith("data:")) {
              const jsonStr = line.slice(5).trim();
              if (!jsonStr) continue;
              try {
                const d = JSON.parse(jsonStr);
                const candidate = d.candidates?.[0];
                const parts = candidate?.content?.parts || [];
                const finishReason = candidate?.finishReason;
                chunkId = d.responseId || chunkId;
                if (!roleSent) { await writeChunk({ role: "assistant", content: "" }); roleSent = true; }
                for (const part of parts) {
                  if (part?.functionCall?.name) {
                    const name = part.functionCall.name;
                    let toolIndex = googleToolCallIndexes.get(name);
                    if (toolIndex === undefined) {
                      toolIndex = nextToolIndex++;
                      googleToolCallIndexes.set(name, toolIndex);
                    }
                    sawToolCall = true;
                    await writeChunk(openAIToolCallDelta(
                      toolIndex,
                      `call_${toolIndex}`,
                      name,
                      stringifyToolArguments(part.functionCall.args),
                    ));
                    continue;
                  }
                  const textDelta = part?.text || "";
                  if (!textDelta) continue;
                  if (part?.thought === true) await writeChunk({ reasoning_content: textDelta });
                  else await writeChunk({ content: textDelta });
                }
                if (finishReason) {
                  const usage = d.usageMetadata ? { prompt_tokens: d.usageMetadata.promptTokenCount || 0, completion_tokens: d.usageMetadata.candidatesTokenCount || 0, total_tokens: d.usageMetadata.totalTokenCount || 0 } : null;
                  await writeChunk({}, sawToolCall ? "tool_calls" : (mapGoogleFinishReason(finishReason) || "stop"), usage);
                }
              } catch (e) {}
            }
          }
        }
        await stream.write("data: [DONE]\n\n");
      } finally {
        reader.releaseLock();
        await stream.close();
      }
    });
  }

  // ===== Branch 2: OpenAI native upstream (Kimi / GPT) =====
  const gptThinkingCfg = getGPTThinkingConfig(body.model);
  if (gptThinkingCfg.reasoningEffort && body.reasoning_effort === undefined) {
    body.reasoning_effort = gptThinkingCfg.reasoningEffort;
  }
  if (gptThinkingCfg.upstreamModel !== body.model) {
    body.model = gptThinkingCfg.upstreamModel;
  }
  maybeInjectOpenAIPromptCacheKey(body);
  stripInternalPromptCacheFlags(body);

  if (!isStream) {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({ error: { message: "Upstream error" } }));
    return c.json(cleanChatCompletion(data, gptThinkingCfg.publicModel), resp.status as any);
  }

  return streamSSE(c, async (stream) => {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text();
      await stream.write(`data: ${JSON.stringify({ error: { message: text, type: "upstream_error" } })}\n\n`);
      await stream.close();
      return;
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (line.trim()) {
            const r = cleanSSEDataLine(line.trim(), gptThinkingCfg.publicModel);
            if (r.line === "data: [DONE]") sawDone = true;
            if (r.line !== null) await stream.write(r.line + "\n");
          } else {
            await stream.write("\n");
          }
        }
      }
      if (buffer.trim()) {
        const r = cleanSSEDataLine(buffer.trim(), gptThinkingCfg.publicModel);
        if (r.line === "data: [DONE]") sawDone = true;
        if (r.line !== null) await stream.write(r.line + "\n");
      }
      if (!sawDone) {
        await stream.write("data: [DONE]\n\n");
      }
    } finally {
      reader.releaseLock();
      await stream.close();
    }
  });
});




export default app;
