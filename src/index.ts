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
  | "GEMINI_DEFAULT_MAX_TOKENS"
  | "BLOOME2API_DEV_MODE";

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

function getRequestId(c: Context): string {
  return c.res.headers.get("x-request-id") || "";
}

function logInternal(event: string, payload: Record<string, any>) {
  console.error(JSON.stringify({ type: event, ...payload }));
}

function isDeveloperMode(c: Context): boolean {
  const value = getEnv(c, "BLOOME2API_DEV_MODE").toLowerCase();
  return ["1", "true", "yes", "on", "dev", "development"].includes(value);
}

type PublicErrorType =
  | "authentication_error"
  | "configuration_error"
  | "invalid_request_error"
  | "unsupported_error"
  | "not_supported_error"
  | "model_not_found_error"
  | "rate_limit_error"
  | "upstream_timeout"
  | "upstream_bad_request"
  | "upstream_auth_error"
  | "upstream_unavailable"
  | "upstream_error"
  | "server_error";

type PublicErrorMeta = {
  status: number;
  type: PublicErrorType;
  code: string;
  message: string;
};

const PUBLIC_ERROR_META: Record<PublicErrorType, PublicErrorMeta> = {
  authentication_error: { status: 401, type: "authentication_error", code: "authentication_failed", message: "Authentication error. Please check logs." },
  configuration_error: { status: 500, type: "configuration_error", code: "server_misconfigured", message: "Server configuration error. Please check logs." },
  invalid_request_error: { status: 400, type: "invalid_request_error", code: "invalid_request", message: "Invalid request. Please check logs." },
  unsupported_error: { status: 400, type: "unsupported_error", code: "unsupported_parameter", message: "Parameter is not supported. Please check logs." },
  not_supported_error: { status: 501, type: "not_supported_error", code: "not_supported", message: "Endpoint or capability is not supported. Please check logs." },
  model_not_found_error: { status: 404, type: "model_not_found_error", code: "model_not_found", message: "Model not found. Please check logs." },
  rate_limit_error: { status: 503, type: "rate_limit_error", code: "rate_limited", message: "Upstream rate limit reached. Please check logs." },
  upstream_timeout: { status: 504, type: "upstream_timeout", code: "upstream_timeout", message: "Upstream timeout. Please check logs." },
  upstream_bad_request: { status: 502, type: "upstream_bad_request", code: "upstream_bad_request", message: "Upstream rejected the request. Please check logs." },
  upstream_auth_error: { status: 502, type: "upstream_auth_error", code: "upstream_auth_error", message: "Upstream authentication or permission error. Please check logs." },
  upstream_unavailable: { status: 503, type: "upstream_unavailable", code: "upstream_unavailable", message: "Upstream service temporarily unavailable. Please check logs." },
  upstream_error: { status: 502, type: "upstream_error", code: "upstream_error", message: "Upstream service error. Please check logs." },
  server_error: { status: 500, type: "server_error", code: "server_error", message: "Server error. Please check logs." },
};

function normalizeErrorType(type?: string): PublicErrorType {
  if (type === "service_unavailable") return "upstream_unavailable";
  if (type && type in PUBLIC_ERROR_META) return type as PublicErrorType;
  return "upstream_error";
}

function publicErrorMeta(status: number, type?: string): PublicErrorMeta {
  const normalizedType = normalizeErrorType(type);
  const base = PUBLIC_ERROR_META[normalizedType];
  return { ...base, status: status || base.status };
}

function publicErrorBody(meta: PublicErrorMeta, detail: any, exposeDetail: boolean): any {
  const error: any = { message: meta.message, type: meta.type, code: meta.code };
  if (detail !== undefined && exposeDetail) error.detail = detail;
  return error;
}

function jsonError(c: Context, status: number, type?: string, detail?: any) {
  const meta = publicErrorMeta(status, type);
  const error = publicErrorBody(meta, detail, isDeveloperMode(c));
  return c.json({
    error,
    request_id: getRequestId(c),
  }, meta.status as any);
}

function sseErrorPayload(c: Context, status: number, type?: string, detail?: any) {
  const meta = publicErrorMeta(status, type);
  const error = publicErrorBody(meta, detail, isDeveloperMode(c));
  return JSON.stringify({
    error,
    request_id: getRequestId(c),
  });
}

function anthropicJsonError(c: Context, status: number, type?: string, detail?: any) {
  const meta = publicErrorMeta(status, type);
  const error = publicErrorBody(meta, detail, isDeveloperMode(c));
  return c.json({
    type: "error",
    error,
    request_id: getRequestId(c),
  }, meta.status as any);
}

function anthropicSseErrorPayload(c: Context, status: number, type?: string, detail?: any) {
  const meta = publicErrorMeta(status, type);
  const error = publicErrorBody(meta, detail, isDeveloperMode(c));
  return JSON.stringify({
    type: "error",
    error,
    request_id: getRequestId(c),
  });
}

function upstreamErrorText(body: any): string {
  if (body == null) return "";
  if (typeof body === "string") return body;
  const parts: string[] = [];
  for (const value of [
    body.error?.message,
    body.error?.type,
    body.message,
    body.type,
    body.detail,
  ]) {
    if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ").toLowerCase();
}

function classifyUpstreamError(status: number, body?: any): { status: number; type: PublicErrorType } {
  const text = upstreamErrorText(body);
  if (text.includes("model alias") && text.includes("not found")) return { status: 404, type: "model_not_found_error" };
  if (/\bmodel\b[^.]{0,80}\bnot found\b/.test(text) || /\bmodel not found\b/.test(text)) {
    return { status: 404, type: "model_not_found_error" };
  }
  if (text.includes("unknown gemini action")) return { status: 501, type: "not_supported_error" };
  if (text.includes("rate limit") || text.includes("too many requests") || text.includes("quota")) return { status: 503, type: "rate_limit_error" };
  if (text.includes("timeout") || text.includes("timed out")) return { status: 504, type: "upstream_timeout" };
  if (text.includes("unauthorized") || text.includes("forbidden") || text.includes("permission") || text.includes("invalid api key")) {
    return { status: 502, type: "upstream_auth_error" };
  }

  if (status === 400) return { status: 502, type: "upstream_bad_request" };
  if (status === 401 || status === 403) return { status: 502, type: "upstream_auth_error" };
  if (status === 404) return { status: 404, type: "model_not_found_error" };
  if (status === 408 || status === 504) return { status: 504, type: "upstream_timeout" };
  if (status === 409) return { status: 503, type: "upstream_unavailable" };
  if (status === 429) return { status: 503, type: "rate_limit_error" };
  if (status === 501) return { status: 501, type: "not_supported_error" };
  if (status === 502 || status === 503 || status >= 500) return { status: 503, type: "upstream_unavailable" };
  return { status: 502, type: "upstream_error" };
}

function classifyUpstreamStatus(status: number, body?: any): { status: number; type: PublicErrorType } {
  return classifyUpstreamError(status, body);
}

function classifyInternalGatewayStatus(status: number, body: any): { status: number; type: PublicErrorType } {
  const type = typeof body?.error?.type === "string" ? body.error.type : undefined;
  if (type && status >= 400 && status < 600) return { status, type: normalizeErrorType(type) };
  return classifyUpstreamError(status, body);
}

function isUpstreamNotSupportedStatus(status: number): boolean {
  return status === 400 || status === 404 || status === 405 || status === 501;
}

function openAIEventError(c: Context, status: number, type?: string, detail?: any): any {
  const meta = publicErrorMeta(status, type);
  return publicErrorBody(meta, detail, isDeveloperMode(c));
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
const CORS_ALLOW_HEADERS = "Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, x-client-request-id";
const CORS_EXPOSE_HEADERS = "x-request-id, request-id";

app.use(`${API_PREFIX}/*`, async (c, next) => {
  const requestId = generateRequestId();
  const start = Date.now();

  c.header("x-request-id", requestId);
  c.header("request-id", requestId);
  c.header("Access-Control-Allow-Origin", "*");
  c.header("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
  c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  c.header("Access-Control-Expose-Headers", CORS_EXPOSE_HEADERS);

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
  "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
  "x-request-id": c.res.headers.get("x-request-id") || generateRequestId(),
  "request-id": c.res.headers.get("request-id") || c.res.headers.get("x-request-id") || generateRequestId(),
}));

app.onError((err, c) => {
  logInternal("unhandled_error", {
    requestId: getRequestId(c),
    path: c.req.path,
    method: c.req.method,
    error: err instanceof Error ? err.message : String(err),
  });
  return jsonError(c, 500, "server_error");
});

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
    return jsonError(c, 500, "configuration_error");
  }

  const token = getClientToken(c);
  if (!secureCompare(token, expectedKey)) {
    return jsonError(c, 401, "authentication_error");
  }
  await next();
});


const BLOOME_LLM_BASE = "https://stream.bloome.im/api/llm/proxy/reson";

async function checkUpstreamHealth(c: Context): Promise<any> {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return { ok: false, status: 500, latencyMs: 0, model: "kimi-k2.6", hasChoices: false, reason: "server_error" };
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
    const ok = resp.ok && hasChoices;
    const reason = ok ? null : classifyUpstreamStatus(resp.status, data).type;
    if (!ok) {
      logInternal("health_upstream_error", {
        requestId: getRequestId(c),
        upstreamStatus: resp.status,
        body: data,
      });
    }

    return {
      ok,
      status: ok ? 200 : 503,
      latencyMs,
      model: "kimi-k2.6",
      hasChoices,
      reason,
    };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? "upstream_timeout" : "upstream_error";
    logInternal("health_upstream_exception", {
      requestId: getRequestId(c),
      error: err?.message || String(err),
    });
    return {
      ok: false,
      status: 503,
      latencyMs: Date.now() - startedAt,
      model: "kimi-k2.6",
      hasChoices: false,
      reason,
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
  { id: "gpt-5.5", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.5", parent: null },
  { id: "gpt-5.5-thinking", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.5-thinking", parent: "gpt-5.5" },
  { id: "glm-5.0", object: "model", created: 1687882411, owned_by: "reson", root: "glm-5.0", parent: null },
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

function isNoopResponseFormat(value: any): boolean {
  return value === undefined || value === null || value?.type === "text";
}

function getTranslatedChatUnsupportedReasons(body: any): string[] {
  const reasons: string[] = [];
  if (body.n !== undefined && body.n !== 1) reasons.push("n>1");
  if (body.logprobs !== undefined) reasons.push("logprobs");
  if (body.top_logprobs !== undefined) reasons.push("top_logprobs");
  if (!isNoopResponseFormat(body.response_format)) reasons.push("response_format");
  for (const field of [
    "presence_penalty",
    "frequency_penalty",
    "logit_bias",
    "seed",
    "modalities",
    "audio",
    "prediction",
    "parallel_tool_calls",
  ]) {
    if (body[field] !== undefined) reasons.push(field);
  }
  if (Array.isArray(body.tools) && body.tools.some((tool: any) => tool?.type !== "function" || !tool.function?.name)) {
    reasons.push("non_function_tools");
  }
  const toolChoice = body.tool_choice;
  const validToolChoice =
    toolChoice === undefined ||
    ["none", "auto", "required"].includes(toolChoice) ||
    (toolChoice?.type === "function" && toolChoice.function?.name);
  if (!validToolChoice) reasons.push("unsupported_tool_choice");
  return reasons;
}

function wantsStreamUsage(body: any): boolean {
  return body?.stream_options?.include_usage === true;
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
    .filter((m: any) => m?.role === "system" || m?.role === "developer")
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
      if (m.role === "system" || m.role === "developer") {
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

function normalizeAnthropicNativeRequest(c: Context, body: any): { request: any; publicModel: string; upstreamModel: string } | null {
  const model = String(body?.model || "");
  if (!isAnthropicModel(model)) return null;

  const thinkingCfg = getClaudeThinkingConfig(model);
  const request = { ...body, model: thinkingCfg.upstreamModel };
  if (request.max_tokens === undefined) {
    request.max_tokens = getAnthropicDefaultMaxTokens(c, model);
  }
  if (thinkingCfg.thinking && request.thinking === undefined) {
    request.thinking = thinkingCfg.thinking;
  }
  if (thinkingCfg.output_config && request.output_config === undefined) {
    request.output_config = thinkingCfg.output_config;
  }
  return { request, publicModel: thinkingCfg.publicModel, upstreamModel: thinkingCfg.upstreamModel };
}

function cleanAnthropicNativeResponse(data: any, publicModel: string): any {
  if (!data || typeof data !== "object" || data.error) return data;
  if (data.type === "message" && data.model) {
    return { ...data, model: publicModel };
  }
  return data;
}

function cleanAnthropicSSELine(line: string, publicModel: string, requestId: string, exposeErrorDetails = false): string | null {
  if (!line.startsWith("data:")) return line;
  const jsonStr = line.slice(5).trim();
  if (!jsonStr) return line;

  let data: any;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    return line;
  }
  if (!data || typeof data !== "object") return line;

  if (data.type === "error" || data.error) {
    const mapped = classifyUpstreamError(502, data.error || data);
    const meta = publicErrorMeta(mapped.status, mapped.type);
    const error = publicErrorBody(meta, data.error || data, exposeErrorDetails);
    return "data: " + JSON.stringify({ type: "error", error, request_id: requestId });
  }

  if (data.type === "message_start" && data.message?.model) {
    data.message = { ...data.message, model: publicModel };
  } else if (data.type === "message" && data.model) {
    data.model = publicModel;
  }
  return "data: " + JSON.stringify(data);
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
          const part: any = {
            functionCall: {
              name: call.function.name,
              args: parseToolArguments(call.function.arguments),
            },
          };
          // Restore Gemini thoughtSignature round-tripped via tool_call.id
          // (Vertex thinking models require it on prior function calls in multi-turn)
          const tsMatch = typeof call.id === "string" ? call.id.match(/__ts_(.+)$/) : null;
          if (tsMatch && tsMatch[1]) part.thoughtSignature = tsMatch[1];
          parts.push(part);
        }
      }
      if (m.role === "system" || m.role === "developer") {
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
        const sig = typeof p.thoughtSignature === "string" && p.thoughtSignature ? p.thoughtSignature : undefined;
        const baseId = `call_${toolCalls.length}`;
        toolCalls.push({
          id: sig ? `${baseId}__ts_${sig}` : baseId,
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

const GEMINI_PSEUDO_STREAM_CHUNK_CHARS = 24;
const GEMINI_PSEUDO_STREAM_DELAY_MS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function splitTextChunks(text: string, chunkSize: number): string[] {
  if (!text) return [];
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += chunkSize) {
    chunks.push(chars.slice(i, i + chunkSize).join(""));
  }
  return chunks;
}

async function writeOpenAIStreamChunk(
  stream: any,
  id: string,
  model: string,
  delta: any,
  finishReason: string | null = null,
  usage: any = null,
) {
  const obj: any = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
  if (usage) obj.usage = usage;
  await stream.write("data: " + JSON.stringify(obj) + "\n\n");
}

async function writeOpenAIStreamUsageChunk(stream: any, id: string, model: string, usage: any) {
  const obj: any = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [],
    usage: usage || null,
  };
  await stream.write("data: " + JSON.stringify(obj) + "\n\n");
}

async function writePseudoTextChunks(
  stream: any,
  id: string,
  model: string,
  field: "content" | "reasoning_content",
  text: any,
) {
  if (typeof text !== "string" || !text) return;
  const chunks = splitTextChunks(text, GEMINI_PSEUDO_STREAM_CHUNK_CHARS);
  for (const chunk of chunks) {
    await writeOpenAIStreamChunk(stream, id, model, { [field]: chunk });
    await sleep(GEMINI_PSEUDO_STREAM_DELAY_MS);
  }
}

async function writeGeminiPseudoStream(
  stream: any,
  completion: any,
  publicModel: string,
  chunkId: string,
  includeUsage = false,
) {
  const choice = completion?.choices?.[0] || {};
  const message = choice.message || {};
  const model = publicModel || completion?.model || "";
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  await writePseudoTextChunks(stream, chunkId, model, "reasoning_content", message.reasoning_content);
  await writePseudoTextChunks(stream, chunkId, model, "content", message.content);

  for (let i = 0; i < toolCalls.length; i++) {
    const call = toolCalls[i] || {};
    await writeOpenAIStreamChunk(stream, chunkId, model, openAIToolCallDelta(
      i,
      call.id || `call_${i}`,
      call.function?.name || "",
      stringifyToolArguments(call.function?.arguments),
    ));
    await sleep(GEMINI_PSEUDO_STREAM_DELAY_MS);
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : (choice.finish_reason || "stop");
  await writeOpenAIStreamChunk(stream, chunkId, model, {}, finishReason, includeUsage ? null : (completion?.usage || null));
  if (includeUsage) {
    await writeOpenAIStreamUsageChunk(stream, chunkId, model, completion?.usage || null);
  }
  await stream.write("data: [DONE]\n\n");
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
function cleanSSEDataLine(line: string, publicModel?: string, requestId?: string, exposeErrorDetails = false): {
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
  if (data.error) {
    const mapped = classifyUpstreamError(502, data.error);
    const meta = publicErrorMeta(mapped.status, mapped.type);
    const error = publicErrorBody(meta, data.error, exposeErrorDetails);
    return {
      line: "data: " + JSON.stringify({
        error,
        request_id: requestId || "",
      }),
    };
  }

  // Drop trailing empty-choices chunks, except official stream usage chunks.
  if (Array.isArray(data.choices) && data.choices.length === 0 && !data.usage) return { line: null };

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
        if (Array.isArray(choice.delta.tool_calls)) delta.tool_calls = choice.delta.tool_calls;
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

function anthropicUpstreamHeaders(c: Context, apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": c.req.header("anthropic-version") || "2023-06-01",
  };
  const beta = c.req.header("anthropic-beta");
  if (beta) headers["anthropic-beta"] = beta;
  return headers;
}

function responseUsageFromOpenAI(usage: any): any {
  const normalized = normalizeOpenAIUsage(usage || {});
  const inputTokens = normalized.prompt_tokens || 0;
  const outputTokens = normalized.completion_tokens || 0;
  return {
    input_tokens: inputTokens,
    input_tokens_details: {
      cached_tokens: normalized.prompt_tokens_details?.cached_tokens || 0,
    },
    output_tokens: outputTokens,
    output_tokens_details: {
      reasoning_tokens: normalized.completion_tokens_details?.reasoning_tokens || 0,
    },
    total_tokens: normalized.total_tokens || inputTokens + outputTokens,
  };
}

function textFromResponseContent(content: any): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return normalizeToolResultContent(content);
  const parts: string[] = [];
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") parts.push(item);
    else if (typeof item.text === "string") parts.push(item.text);
    else if (typeof item.output_text === "string") parts.push(item.output_text);
    else if (item.type === "input_image" && item.image_url) parts.push(`[Image: ${item.image_url}]`);
    else if (item.type === "input_file" && (item.filename || item.file_url || item.file_id)) {
      parts.push(`[File: ${item.filename || item.file_url || item.file_id}]`);
    }
  }
  return parts.join("");
}

function responseContentToChatContent(content: any): any {
  if (content == null || typeof content === "string") return content ?? "";
  if (!Array.isArray(content)) return normalizeToolResultContent(content);

  const parts: any[] = [];
  let hasNonText = false;
  for (const item of content) {
    if (!item) continue;
    if (typeof item === "string") {
      parts.push({ type: "text", text: item });
    } else if (typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    } else if (item.type === "input_text" || item.type === "output_text") {
      parts.push({ type: "text", text: item.text || "" });
    } else if (item.type === "input_image" && item.image_url) {
      hasNonText = true;
      parts.push({ type: "image_url", image_url: { url: item.image_url, detail: item.detail || "auto" } });
    } else if (item.type === "input_file") {
      parts.push({ type: "text", text: `[File: ${item.filename || item.file_url || item.file_id || "input_file"}]` });
    }
  }
  if (!hasNonText) return parts.map((p) => p.text || "").join("");
  return parts;
}

function base64UrlEncode(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): string | null {
  try {
    const padded = input.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(input.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeCompactionSummary(summary: string): string {
  return base64UrlEncode(JSON.stringify({
    type: "bloome2api.compaction",
    version: 1,
    summary,
  }));
}

function decodeCompactionSummary(encryptedContent: any): string | null {
  if (typeof encryptedContent !== "string") return null;
  const decoded = base64UrlDecode(encryptedContent);
  if (!decoded) return null;
  try {
    const payload = JSON.parse(decoded);
    if (payload?.type === "bloome2api.compaction" && typeof payload.summary === "string") {
      return payload.summary;
    }
  } catch {
    return null;
  }
  return null;
}

function responsesInputToChatMessages(input: any): any[] {
  if (input == null) return [];
  if (typeof input === "string") return [{ role: "user", content: input }];
  const items = Array.isArray(input) ? input : [input];
  const messages: any[] = [];

  for (const item of items) {
    if (!item) continue;
    if (typeof item === "string") {
      messages.push({ role: "user", content: item });
      continue;
    }

    if (item.type === "compaction") {
      const summary = decodeCompactionSummary(item.encrypted_content);
      messages.push({
        role: "system",
        content: summary
          ? `Context compaction summary:\n${summary}`
          : "Context compaction item is opaque and cannot be expanded by this gateway.",
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({
        role: "tool",
        tool_call_id: item.call_id || item.id || "",
        content: normalizeToolResultContent(item.output),
      });
      continue;
    }

    if (item.type === "function_call" && item.name) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: [{
          id: item.call_id || item.id || `call_${messages.length}`,
          type: "function",
          function: { name: item.name, arguments: stringifyToolArguments(item.arguments) },
        }],
      });
      continue;
    }

    if (item.type === "input_text" || item.type === "input_image" || item.type === "input_file") {
      messages.push({ role: "user", content: responseContentToChatContent([item]) });
      continue;
    }

    if (item.type === "message" || item.role) {
      const role = item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? item.role : "user";
      messages.push({ role, content: responseContentToChatContent(item.content) });
    }
  }

  return messages;
}

function responsesInputToTranscript(input: any): string {
  return responsesInputToChatMessages(input)
    .map((m) => `${m.role}: ${textFromResponseContent(m.content)}`)
    .join("\n\n");
}

function mapResponsesToolsToChatTools(tools: any): { tools?: any[]; unsupported: string[] } {
  if (tools === undefined) return { unsupported: [] };
  if (!Array.isArray(tools)) return { unsupported: ["tools"] };
  const mapped: any[] = [];
  const unsupported: string[] = [];
  for (const tool of tools) {
    if (tool?.type === "function" && tool.function?.name) {
      mapped.push(tool);
    } else if (tool?.type === "function" && tool.name) {
      mapped.push({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description || "",
          parameters: tool.parameters || fallbackJsonSchema(),
          ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
        },
      });
    } else {
      unsupported.push(tool?.type || "unknown_tool");
    }
  }
  return { tools: mapped, unsupported };
}

function responseTextFormatToChatResponseFormat(text: any): any | undefined {
  const format = text?.format;
  if (!format || format.type === "text") return undefined;
  if (format.type === "json_object") return { type: "json_object" };
  if (format.type === "json_schema") {
    return {
      type: "json_schema",
      json_schema: {
        name: format.name || "response",
        schema: format.schema || fallbackJsonSchema(),
        ...(format.strict !== undefined ? { strict: format.strict } : {}),
      },
    };
  }
  return undefined;
}

function responsesRequestToChatBody(body: any): { chatBody?: any; unsupported: string[] } {
  const unsupported: string[] = [];
  if (!body?.model) unsupported.push("model");
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) unsupported.push("previous_response_id");
  if (body.conversation !== undefined && body.conversation !== null) unsupported.push("conversation");

  const toolMapping = mapResponsesToolsToChatTools(body.tools);
  unsupported.push(...toolMapping.unsupported.map((tool) => `tool:${tool}`));

  const messages = responsesInputToChatMessages(body.input ?? body.messages);
  if (body.instructions) {
    messages.unshift({ role: "system", content: String(body.instructions) });
  }
  if (messages.length === 0) unsupported.push("input");

  const responseFormat = responseTextFormatToChatResponseFormat(body.text);
  const chatBody: any = {
    model: body.model,
    messages,
    stream: false,
  };
  if (body.max_output_tokens !== undefined) chatBody.max_completion_tokens = body.max_output_tokens;
  if (body.max_tokens !== undefined) chatBody.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) chatBody.max_completion_tokens = body.max_completion_tokens;
  if (body.temperature !== undefined) chatBody.temperature = body.temperature;
  if (body.top_p !== undefined) chatBody.top_p = body.top_p;
  if (body.stop !== undefined) chatBody.stop = body.stop;
  if (body.parallel_tool_calls !== undefined) chatBody.parallel_tool_calls = body.parallel_tool_calls;
  if (body.tool_choice !== undefined) chatBody.tool_choice = body.tool_choice;
  if (toolMapping.tools) chatBody.tools = toolMapping.tools;
  if (responseFormat) chatBody.response_format = responseFormat;
  if (body.reasoning?.effort !== undefined) chatBody.reasoning_effort = body.reasoning.effort;
  if (body.prompt_cache !== undefined) chatBody.prompt_cache = body.prompt_cache;
  if (body.cache !== undefined) chatBody.cache = body.cache;
  if (body.prompt_cache_key !== undefined) chatBody.prompt_cache_key = body.prompt_cache_key;

  return unsupported.length > 0 ? { unsupported } : { chatBody, unsupported };
}

async function callChatCompletionInternal(c: Context, chatBody: any): Promise<Response> {
  const token = getClientToken(c) || getEnv(c, "CLIENT_API_KEY");
  return app.request(`${API_PREFIX}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(chatBody),
  }, (c as any).env);
}

function chatCompletionToResponse(chat: any, requestBody: any, responseId?: string): any {
  const choice = chat?.choices?.[0] || {};
  const message = choice.message || {};
  const createdAt = typeof chat?.created === "number" ? chat.created : Math.floor(Date.now() / 1000);
  const id = responseId || `resp_${chat?.id || generateRequestId()}`;
  const output: any[] = [];
  const reasoningText = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
  if (reasoningText) {
    output.push({
      id: `rs_${hashString(id + ":reasoning")}`,
      type: "reasoning",
      status: "completed",
      summary: [{ type: "summary_text", text: reasoningText }],
    });
  }

  const text = typeof message.content === "string" ? message.content : "";
  if (text || !Array.isArray(message.tool_calls)) {
    output.push({
      id: `msg_${hashString(id + ":message")}`,
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!call?.function?.name) continue;
      output.push({
        id: call.id || `fc_${hashString(id + output.length)}`,
        type: "function_call",
        status: "completed",
        call_id: call.id || `call_${output.length}`,
        name: call.function.name,
        arguments: stringifyToolArguments(call.function.arguments),
      });
    }
  }

  return {
    id,
    object: "response",
    created_at: createdAt,
    status: "completed",
    background: false,
    error: null,
    incomplete_details: null,
    instructions: requestBody.instructions ?? null,
    max_output_tokens: requestBody.max_output_tokens ?? requestBody.max_completion_tokens ?? null,
    model: chat?.model || requestBody.model || "",
    output,
    output_text: text,
    parallel_tool_calls: requestBody.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: requestBody.reasoning || { effort: requestBody.reasoning_effort ?? null, summary: null },
    service_tier: requestBody.service_tier || "default",
    store: requestBody.store ?? false,
    temperature: requestBody.temperature ?? null,
    text: requestBody.text || { format: { type: "text" } },
    tool_choice: requestBody.tool_choice || "auto",
    tools: requestBody.tools || [],
    top_p: requestBody.top_p ?? null,
    truncation: requestBody.truncation || "disabled",
    usage: responseUsageFromOpenAI(chat?.usage),
    user: requestBody.user ?? null,
    metadata: requestBody.metadata || {},
  };
}

async function writeResponseEvent(stream: any, event: string, data: any) {
  await stream.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function writeResponseTextDeltas(stream: any, response: any) {
  const messageIndex = response.output.findIndex((item: any) => item?.type === "message");
  const message = messageIndex >= 0 ? response.output[messageIndex] : null;
  const text = response.output_text || "";
  if (!message || !text) return;
  await writeResponseEvent(stream, "response.output_item.added", {
    type: "response.output_item.added",
    response_id: response.id,
    output_index: messageIndex,
    item: { ...message, content: [] },
  });
  await writeResponseEvent(stream, "response.content_part.added", {
    type: "response.content_part.added",
    response_id: response.id,
    item_id: message.id,
    output_index: messageIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  for (const chunk of splitTextChunks(text, GEMINI_PSEUDO_STREAM_CHUNK_CHARS)) {
    await writeResponseEvent(stream, "response.output_text.delta", {
      type: "response.output_text.delta",
      response_id: response.id,
      item_id: message.id,
      output_index: messageIndex,
      content_index: 0,
      delta: chunk,
    });
    await sleep(GEMINI_PSEUDO_STREAM_DELAY_MS);
  }
  await writeResponseEvent(stream, "response.output_text.done", {
    type: "response.output_text.done",
    response_id: response.id,
    item_id: message.id,
    output_index: messageIndex,
    content_index: 0,
    text,
  });
  await writeResponseEvent(stream, "response.content_part.done", {
    type: "response.content_part.done",
    response_id: response.id,
    item_id: message.id,
    output_index: messageIndex,
    content_index: 0,
    part: message.content?.[0] || { type: "output_text", text, annotations: [] },
  });
  await writeResponseEvent(stream, "response.output_item.done", {
    type: "response.output_item.done",
    response_id: response.id,
    output_index: messageIndex,
    item: message,
  });
}

async function writeResponseNonTextOutputEvents(stream: any, response: any) {
  for (let i = 0; i < response.output.length; i++) {
    const item = response.output[i];
    if (!item || item.type === "message") continue;
    await writeResponseEvent(stream, "response.output_item.added", {
      type: "response.output_item.added",
      response_id: response.id,
      output_index: i,
      item,
    });
    await writeResponseEvent(stream, "response.output_item.done", {
      type: "response.output_item.done",
      response_id: response.id,
      output_index: i,
      item,
    });
  }
}

function compactionOutputFromInput(input: any, summary: string): any[] {
  const transcript = responsesInputToTranscript(input);
  const inputText = transcript.length > 8000 ? `${transcript.slice(0, 8000)}...` : transcript;
  return [
    {
      id: `msg_${hashString(inputText || summary || "input")}`,
      type: "message",
      status: "completed",
      role: "user",
      content: [{ type: "input_text", text: inputText }],
    },
    {
      id: `cmp_${hashString(summary || generateRequestId())}`,
      type: "compaction",
      encrypted_content: encodeCompactionSummary(summary),
    },
  ];
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
 * POST {API_PREFIX}/messages
 * Anthropic Messages-compatible endpoint. Unlike /chat/completions, this keeps
 * the public request/response shape Anthropic-native and only normalizes
 * gateway aliases such as `claude-*-thinking`.
 */
app.post(`${API_PREFIX}/messages`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return anthropicJsonError(c, 500, "configuration_error");
  }
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return anthropicJsonError(c, 400, "invalid_request_error");
  }
  const normalized = normalizeAnthropicNativeRequest(c, body);
  if (!normalized) {
    return anthropicJsonError(c, 400, "invalid_request_error", { reason: "model is not Anthropic-compatible", model: body?.model });
  }

  if (normalized.request.stream !== true) {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages`, {
      method: "POST",
      headers: anthropicUpstreamHeaders(c, apiKey),
      body: JSON.stringify(normalized.request),
    });
    const upstream = await resp.json().catch(() => null);
    if (!resp.ok || upstream?.error) {
      logInternal("upstream_error", {
        requestId: getRequestId(c),
        branch: "anthropic_native",
        model: body.model,
        upstreamStatus: resp.status,
        body: upstream,
      });
      const mapped = classifyUpstreamStatus(resp.status, upstream);
      return anthropicJsonError(c, mapped.status, mapped.type, upstream);
    }
    return c.json(cleanAnthropicNativeResponse(upstream, normalized.publicModel), resp.status as any);
  }

  return streamSSE(c, async (stream) => {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages`, {
      method: "POST",
      headers: anthropicUpstreamHeaders(c, apiKey),
      body: JSON.stringify(normalized.request),
    });
    if (!resp.ok || !resp.body) {
      const text = await resp.text();
      logInternal("upstream_error", {
        requestId: getRequestId(c),
        branch: "anthropic_native_stream",
        model: body.model,
        upstreamStatus: resp.status,
        body: text,
      });
      const mapped = classifyUpstreamStatus(resp.status, text);
      await stream.write(`event: error\ndata: ${anthropicSseErrorPayload(c, mapped.status, mapped.type, text)}\n\n`);
      await stream.close();
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          const cleaned = cleanAnthropicSSELine(line, normalized.publicModel, getRequestId(c), isDeveloperMode(c));
          if (cleaned !== null) await stream.write(cleaned + "\n");
        }
      }
      if (buffer) {
        const cleaned = cleanAnthropicSSELine(buffer.replace(/\r$/, ""), normalized.publicModel, getRequestId(c), isDeveloperMode(c));
        if (cleaned !== null) await stream.write(cleaned + "\n");
      }
    } finally {
      reader.releaseLock();
      await stream.close();
    }
  });
});

/**
 * POST {API_PREFIX}/messages/count_tokens
 * Anthropic Token Counting-compatible endpoint. If Bloome upstream does not
 * support the route, return an explicit not_supported error instead of faking
 * token counts.
 */
app.post(`${API_PREFIX}/messages/count_tokens`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return anthropicJsonError(c, 500, "configuration_error");
  }
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return anthropicJsonError(c, 400, "invalid_request_error");
  }
  const normalized = normalizeAnthropicNativeRequest(c, body);
  if (!normalized) {
    return anthropicJsonError(c, 501, "not_supported_error", { reason: "token counting is only available for Anthropic-compatible models", model: body?.model });
  }
  const countBody = { ...normalized.request };
  delete countBody.stream;
  delete countBody.max_tokens;

  const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: anthropicUpstreamHeaders(c, apiKey),
    body: JSON.stringify(countBody),
  });
  const upstream = await resp.json().catch(() => null);
  if (!resp.ok || upstream?.error) {
    logInternal("upstream_error", {
      requestId: getRequestId(c),
      branch: "anthropic_count_tokens",
      model: body.model,
      upstreamStatus: resp.status,
      body: upstream,
    });
    if (isUpstreamNotSupportedStatus(resp.status)) {
      return anthropicJsonError(c, 501, "not_supported_error", upstream);
    }
    const mapped = classifyUpstreamStatus(resp.status, upstream);
    return anthropicJsonError(c, mapped.status, mapped.type, upstream);
  }
  return c.json(upstream, resp.status as any);
});

/**
 * POST {API_PREFIX}/responses
 * Stateless Responses API shim backed by /chat/completions. It does not
 * persist response IDs or conversations; callers must pass full context.
 */
app.post(`${API_PREFIX}/responses`, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonError(c, 400, "invalid_request_error");
  }
  const converted = responsesRequestToChatBody(body);
  if (!converted.chatBody) {
    return jsonError(c, 400, "unsupported_error", { unsupported: converted.unsupported });
  }

  if (body.stream === true) {
    return streamSSE(c, async (stream) => {
      const responseId = `resp_${getRequestId(c) || generateRequestId()}`;
      await writeResponseEvent(stream, "response.created", {
        type: "response.created",
        response: {
          id: responseId,
          object: "response",
          created_at: Math.floor(Date.now() / 1000),
          status: "in_progress",
          model: body.model,
          output: [],
        },
      });

      const resp = await callChatCompletionInternal(c, converted.chatBody);
      const upstream = await resp.json().catch(() => null);
      if (!resp.ok || upstream?.error) {
        const mapped = classifyInternalGatewayStatus(resp.status, upstream);
        await writeResponseEvent(stream, "error", {
          type: "error",
          error: openAIEventError(c, mapped.status, mapped.type, upstream),
          request_id: getRequestId(c),
        });
        await stream.close();
        return;
      }

      const response = chatCompletionToResponse(upstream, body, responseId);
      await writeResponseNonTextOutputEvents(stream, response);
      await writeResponseTextDeltas(stream, response);
      await writeResponseEvent(stream, "response.completed", {
        type: "response.completed",
        response,
      });
      await stream.close();
    });
  }

  const resp = await callChatCompletionInternal(c, converted.chatBody);
  const upstream = await resp.json().catch(() => null);
  if (!resp.ok || upstream?.error) {
    const mapped = classifyInternalGatewayStatus(resp.status, upstream);
    return jsonError(c, mapped.status, mapped.type, upstream);
  }
  return c.json(chatCompletionToResponse(upstream, body), resp.status as any);
});

/**
 * POST {API_PREFIX}/responses/input_tokens
 * Token counting for Responses input. Bloome currently exposes a reliable
 * count endpoint only through the Anthropic Messages path, so other protocol
 * families return explicit not_supported instead of estimated counts.
 */
app.post(`${API_PREFIX}/responses/input_tokens`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  if (!apiKey) {
    return jsonError(c, 500, "configuration_error");
  }
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonError(c, 400, "invalid_request_error");
  }
  if (!isAnthropicModel(body.model)) {
    return jsonError(c, 501, "not_supported_error", { reason: "response input token counting is only available for Anthropic-compatible models" });
  }

  const converted = responsesRequestToChatBody(body);
  if (!converted.chatBody) {
    return jsonError(c, 400, "unsupported_error", { unsupported: converted.unsupported });
  }
  const defaultMaxTokens = getAnthropicDefaultMaxTokens(c, body.model);
  const countBody = openaiToAnthropicRequest(converted.chatBody, defaultMaxTokens);
  delete countBody.max_tokens;
  delete countBody.stream;

  const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages/count_tokens`, {
    method: "POST",
    headers: anthropicUpstreamHeaders(c, apiKey),
    body: JSON.stringify(countBody),
  });
  const upstream = await resp.json().catch(() => null);
  if (!resp.ok || upstream?.error) {
    logInternal("upstream_error", {
      requestId: getRequestId(c),
      branch: "responses_input_tokens",
      model: body.model,
      upstreamStatus: resp.status,
      body: upstream,
    });
    if (isUpstreamNotSupportedStatus(resp.status)) {
      return jsonError(c, 501, "not_supported_error", upstream);
    }
    const mapped = classifyUpstreamStatus(resp.status, upstream);
    return jsonError(c, mapped.status, mapped.type, upstream);
  }
  return c.json({
    object: "response.input_tokens",
    input_tokens: upstream?.input_tokens ?? 0,
  }, resp.status as any);
});

/**
 * POST {API_PREFIX}/responses/compact
 * Compatibility compaction endpoint. The returned compaction item is opaque to
 * clients and can be passed back to this gateway, but it is not OpenAI's
 * encrypted platform format.
 */
app.post(`${API_PREFIX}/responses/compact`, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonError(c, 400, "invalid_request_error");
  }
  if (!body.model || body.input === undefined) {
    return jsonError(c, 400, "invalid_request_error", { unsupported: body.model ? ["input"] : ["model"] });
  }

  const transcript = responsesInputToTranscript(body.input);
  const chatBody: any = {
    model: body.model,
    messages: [
      {
        role: "system",
        content: "Compress the conversation into a concise context summary. Preserve user goals, decisions, constraints, tool results, file paths, unresolved tasks, and facts needed to continue. Return only the summary.",
      },
      { role: "user", content: transcript },
    ],
    stream: false,
    max_completion_tokens: body.max_output_tokens ?? body.max_completion_tokens ?? 2048,
  };
  if (body.reasoning?.effort !== undefined) chatBody.reasoning_effort = body.reasoning.effort;

  const resp = await callChatCompletionInternal(c, chatBody);
  const upstream = await resp.json().catch(() => null);
  if (!resp.ok || upstream?.error) {
    const mapped = classifyInternalGatewayStatus(resp.status, upstream);
    return jsonError(c, mapped.status, mapped.type, upstream);
  }

  const summary = upstream?.choices?.[0]?.message?.content || "";
  return c.json({
    id: `resp_${getRequestId(c) || generateRequestId()}`,
    object: "response.compaction",
    created_at: Math.floor(Date.now() / 1000),
    output: compactionOutputFromInput(body.input, summary),
    usage: responseUsageFromOpenAI(upstream?.usage),
  }, resp.status as any);
});

app.post(`${API_PREFIX}/responses/:response_id/compact`, async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || body.input === undefined) {
    return jsonError(c, 400, "invalid_request_error", { unsupported: ["input"] });
  }
  return app.request(`${API_PREFIX}/responses/compact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getClientToken(c) || getEnv(c, "CLIENT_API_KEY")}`,
    },
    body: JSON.stringify(body),
  }, (c as any).env);
});

app.get(`${API_PREFIX}/responses/:response_id`, (c) => {
  return jsonError(c, 404, "not_supported_error", { reason: "responses are stateless in this gateway and cannot be retrieved by id" });
});

app.delete(`${API_PREFIX}/responses/:response_id`, (c) => {
  return jsonError(c, 404, "not_supported_error", { reason: "responses are stateless in this gateway and cannot be deleted by id" });
});

app.get(`${API_PREFIX}/responses/:response_id/input_items`, (c) => {
  return jsonError(c, 404, "not_supported_error", { reason: "responses are stateless in this gateway and do not store input items" });
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
    return jsonError(c, 500, "configuration_error");
  }
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return jsonError(c, 400, "invalid_request_error");
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
    return jsonError(c, 400, "unsupported_error", { unsupported: ["functions", "function_call"] });
  }
  if (needsProtocolTranslation) {
    const unsupportedReasons = getTranslatedChatUnsupportedReasons(body);
    if (unsupportedReasons.length > 0) {
      return jsonError(c, 400, "unsupported_error", { unsupported: unsupportedReasons });
    }
  }
  // ===== Branch 1: Anthropic-compatible models → translate to Anthropic =====
  if (isAnthropicModel(body.model)) {
    const thinkingCfg = getClaudeThinkingConfig(body.model);
    const defaultMaxTokens = getAnthropicDefaultMaxTokens(c, body.model);
    const anthropicBody = openaiToAnthropicRequest(body, defaultMaxTokens);
    const includeUsage = wantsStreamUsage(body);

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
      const upstream = await resp.json().catch(() => null);
      if (!resp.ok || upstream?.error) {
        logInternal("upstream_error", {
          requestId: getRequestId(c),
          branch: "anthropic",
          model: body.model,
          upstreamStatus: resp.status,
          body: upstream,
        });
        const mapped = classifyUpstreamStatus(resp.status, upstream);
        return jsonError(c, mapped.status, mapped.type, upstream);
      }
      return c.json(anthropicToOpenaiResponse(upstream, thinkingCfg.publicModel), resp.status as any);
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
        logInternal("upstream_error", {
          requestId: getRequestId(c),
          branch: "anthropic_stream",
          model: body.model,
          upstreamStatus: resp.status,
          body: text,
        });
        const mapped = classifyUpstreamStatus(resp.status, text);
        await stream.write(`data: ${sseErrorPayload(c, mapped.status, mapped.type, text)}\n\n`);
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
            if (m.usage) lastUsage = mergeOpenAIUsage(lastUsage, m.usage);
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
              lastUsage = mergeOpenAIUsage(lastUsage, d.usage);
            }
          } else if (curEvent === "message_stop") {
            await writeChunk({}, sawToolCall ? "tool_calls" : (mapAnthropicStopReason(lastStop) || "stop"), includeUsage ? null : lastUsage);
            if (includeUsage) {
              await writeOpenAIStreamUsageChunk(stream, chunkId, chunkModel, lastUsage);
            }
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
      const upstream: any = await resp.json().catch(() => null);
      if (!resp.ok || upstream?.error) {
        logInternal("upstream_error", {
          requestId: getRequestId(c),
          branch: "gemini",
          model: body.model,
          upstreamStatus: resp.status,
          body: upstream,
        });
        const mapped = classifyUpstreamStatus(resp.status, upstream);
        return jsonError(c, mapped.status, mapped.type, upstream);
      }
      return c.json(googleToOpenaiResponse(upstream, googleCfg.publicModel), resp.status as any);
    }
    return streamSSE(c, async (stream) => {
      const requestId = getRequestId(c);
      const chunkId = `chatcmpl-${requestId || generateRequestId()}`;
      try {
        await writeOpenAIStreamChunk(stream, chunkId, googleCfg.publicModel, { role: "assistant", content: "" });

        const resp = await fetch(`${BLOOME_LLM_BASE}/v1/models/${googleCfg.upstreamModel}:generateContent`, {
          method: "POST", headers: upstreamHeaders, body: JSON.stringify(googleBody)
        });
        const upstream: any = await resp.json().catch(() => null);
        if (!resp.ok || upstream?.error) {
          logInternal("upstream_error", {
            requestId,
            branch: "gemini_pseudo_stream",
            model: body.model,
            upstreamStatus: resp.status,
            body: upstream,
          });
          const mapped = classifyUpstreamStatus(resp.status, upstream);
          await stream.write(`data: ${sseErrorPayload(c, mapped.status, mapped.type, upstream)}\n\n`);
          return;
        }

        const completion = googleToOpenaiResponse(upstream, googleCfg.publicModel);
        await writeGeminiPseudoStream(stream, completion, googleCfg.publicModel, chunkId, wantsStreamUsage(body));
      } finally {
        await stream.close();
      }
    });
  }

  // ===== Branch 2: OpenAI native upstream (Kimi / GPT) =====
  const gptThinkingCfg = getGPTThinkingConfig(body.model);
  // gpt-5.5 specifically rejects reasoning_effort + tools combo in /v1/chat/completions
  // (gpt-5.4 / 5.4-mini and other models accept this combo fine, no special-casing needed there).
  // Narrow check: only affect when actual function tools are registered, not just tool_choice sentinel
  // or empty tools array (some SDKs always include these fields).
  const isGpt55Thinking = body.model === "gpt-5.5-thinking";
  const hasRealTools = Array.isArray(body.tools) && body.tools.length > 0;
  const skipReasoningEffortInjection = isGpt55Thinking && hasRealTools;
  if (gptThinkingCfg.reasoningEffort && body.reasoning_effort === undefined && !skipReasoningEffortInjection) {
    body.reasoning_effort = gptThinkingCfg.reasoningEffort;
  }
  if (gptThinkingCfg.upstreamModel !== body.model) {
    body.model = gptThinkingCfg.upstreamModel;
  }
  // Even when reasoning_effort came from the client (not injected), strip it for gpt-5.5 + real tools.
  if (body.reasoning_effort !== undefined && hasRealTools && String(body.model).toLowerCase() === "gpt-5.5") {
    delete body.reasoning_effort;
  }
  maybeInjectOpenAIPromptCacheKey(body);
  stripInternalPromptCacheFlags(body);

  if (!isStream) {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok || data?.error) {
      logInternal("upstream_error", {
        requestId: getRequestId(c),
        branch: "openai",
        model: body.model,
        upstreamStatus: resp.status,
        body: data,
      });
      const mapped = classifyUpstreamStatus(resp.status, data);
      return jsonError(c, mapped.status, mapped.type, data);
    }
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
      logInternal("upstream_error", {
        requestId: getRequestId(c),
        branch: "openai_stream",
        model: body.model,
        upstreamStatus: resp.status,
        body: text,
      });
      const mapped = classifyUpstreamStatus(resp.status, text);
      await stream.write(`data: ${sseErrorPayload(c, mapped.status, mapped.type, text)}\n\n`);
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
            const r = cleanSSEDataLine(line.trim(), gptThinkingCfg.publicModel, getRequestId(c), isDeveloperMode(c));
            if (r.line === "data: [DONE]") sawDone = true;
            if (r.line !== null) await stream.write(r.line + "\n");
          } else {
            await stream.write("\n");
          }
        }
      }
      if (buffer.trim()) {
        const r = cleanSSEDataLine(buffer.trim(), gptThinkingCfg.publicModel, getRequestId(c), isDeveloperMode(c));
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
