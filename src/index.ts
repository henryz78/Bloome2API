import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const app = new Hono();

// ========== Configuration ==========

import { env } from "hono/adapter";


function getEnv<T extends string>(c: any, key: T): string {
  // 1. Try Hono's universal env adapter (Cloudflare standard)
  let val = env<Record<T, string>>(c)[key];
  if (val) return val;
  // 2. Try Node's process.env (Local dev)
  if (typeof process !== "undefined" && process.env && process.env[key]) {
    return process.env[key] as string;
  }
  // 3. Try EdgeSpark's proprietary vars.get() via dynamic check
  // Since EdgeSpark exposes a global `vars` object to workers sometimes
  try {
    // @ts-ignore
    if (typeof vars !== "undefined" && typeof vars.get === "function") {
      // @ts-ignore
      val = vars.get(key);
      if (val) return val;
    }
  } catch (e) {}
  return "";
}

const API_PREFIX = process.env.API_PREFIX || "/api/public/v1"; // EdgeSpark requires /api/*

app.use("*", async (c, next) => {
  const expectedKey = getEnv(c, "CLIENT_API_KEY");
  if (expectedKey) {
    const auth = c.req.header("authorization") || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (token !== expectedKey) {
      return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
    }
  }
  await next();
});


const BLOOME_LLM_BASE = "https://stream.bloome.im/api/llm/proxy/reson";
const BLOOME_API_KEY = process.env.BLOOME_API_KEY || "";

const MODELS = [
  { id: "kimi-k2.6", object: "model", created: 1687882411, owned_by: "reson", root: "kimi-k2.6", parent: null },
  { id: "kimi-k2.5", object: "model", created: 1687882411, owned_by: "reson", root: "kimi-k2.5", parent: null },
  { id: "gpt-5.4", object: "model", created: 1687882411, owned_by: "reson", root: "gpt-5.4", parent: null },
  { id: "claude-opus-4-7", object: "model", created: 1687882411, owned_by: "reson", root: "claude-opus-4-7", parent: null },{ id: "gemini-3.1-pro", object: "model", created: 1687882411, owned_by: "reson", root: "gemini-3.1-pro", parent: null },
];

// ========== Helpers ==========

function isClaudeModel(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("claude");
}


function isGoogleModel(model: string): boolean {
  return typeof model === "string" && model.toLowerCase().startsWith("gemini");
}

function isReasoningModel(model: string): boolean {
  if (typeof model !== "string") return false;
  const m = model.toLowerCase();
  return m.startsWith("gpt-5") || m.startsWith("o1") || m.startsWith("o3") || m.startsWith("o4");
}

// ========== OpenAI ↔ Anthropic conversion ==========

/**
 * Convert OpenAI chat completions request to Anthropic Messages format.
 * - Extracts `system` messages to top-level `system` field
 * - Maps `max_tokens` (Anthropic requires it)
 * - Flattens content arrays into strings
 */
function openaiToAnthropicRequest(body: any): any {
  const out: any = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 4096,
    messages: [],
  };
  if (body.stream) out.stream = true;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  const systemParts: string[] = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      if (m.role === "system") {
        if (typeof m.content === "string") systemParts.push(m.content);
        continue;
      }
      let content: any = m.content;
      if (Array.isArray(m.content)) {
        const texts = m.content
          .filter((p: any) => p && (p.type === "text" || typeof p === "string"))
          .map((p: any) => (typeof p === "string" ? p : p.text || ""));
        content = texts.join("");
      } else if (content == null) {
        content = "";
      }
      out.messages.push({ role: m.role === "assistant" ? "assistant" : "user", content });
    }
  }
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
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

/**
 * Convert Anthropic Messages response back to OpenAI chat completion format.
 * - Concatenates all text blocks from Anthropic's content array
 * - Maps stop_reason to OpenAI finish_reason
 * - Converts input_tokens/output_tokens to prompt_tokens/completion_tokens
 */
function anthropicToOpenaiResponse(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;
  let text = "";
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block && block.type === "text" && typeof block.text === "string") text += block.text;
    }
  }
  const promptTokens = data.usage?.input_tokens || 0;
  const completionTokens = data.usage?.output_tokens || 0;
  return {
    id: data.id || "",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: data.model || "",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: mapAnthropicStopReason(data.stop_reason),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}


// ========== Google Gemini (Vertex) conversion ==========

function openaiToGoogleRequest(body: any): any {
  const out: any = { contents: [], generationConfig: {} };
  if (body.temperature !== undefined) out.generationConfig.temperature = body.temperature;
  if (body.top_p !== undefined) out.generationConfig.topP = body.top_p;
  if (body.max_tokens ?? body.max_completion_tokens) {
    out.generationConfig.maxOutputTokens = body.max_tokens ?? body.max_completion_tokens;
  }
  if (body.stop) {
    out.generationConfig.stopSequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  }
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (!m || typeof m !== "object") continue;
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content.filter((p:any) => p && (p.type === "text" || typeof p === "string"))
          .map((p:any) => typeof p === "string" ? p : (p.text || "")).join("");
      }
      if (m.role === "system") {
        out.systemInstruction = { role: "user", parts: [{ text }] };
        continue;
      }
      out.contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text }] });
    }
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

function googleToOpenaiResponse(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;
  const candidate = data.candidates?.[0];
  let text = "";
  if (candidate?.content?.parts) {
    text = candidate.content.parts.map((p:any) => p.text || "").join("");
  }
  const pTok = data.usageMetadata?.promptTokenCount || 0;
  const cTok = data.usageMetadata?.candidatesTokenCount || 0;
  return {
    id: data.responseId || "",
    object: "chat.completion",
    created: data.createTime ? Math.floor(new Date(data.createTime).getTime()/1000) : Math.floor(Date.now()/1000),
    model: data.modelVersion || "",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: mapGoogleFinishReason(candidate?.finishReason) }],
    usage: { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok }
  };
}

// ========== Cleaning (OpenAI native upstream: Kimi / GPT) ==========

/**
 * Clean upstream OpenAI-format response.
 * - Preserves `reasoning_content` in its own field (never maps to `content`)
 * - Removes non-standard fields like `cached_tokens`, `system_fingerprint`
 */
function cleanChatCompletion(data: any): any {
  if (!data || typeof data !== "object") return data;
  if (data.error) return data;

  const cleaned: any = {
    id: data.id || "",
    object: data.object || "chat.completion",
    created: typeof data.created === "number" ? data.created : Math.floor(Date.now() / 1000),
    model: data.model || "",
  };

  if (Array.isArray(data.choices)) {
    cleaned.choices = data.choices.map((choice: any) => {
      const msg: any = { role: "assistant", content: "" };
      if (choice.message) {
        msg.role = choice.message.role || "assistant";
        msg.content = choice.message.content ?? "";
        if (choice.message.reasoning_content !== undefined) {
          msg.reasoning_content = choice.message.reasoning_content;
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
    cleaned.usage = {
      prompt_tokens: data.usage.prompt_tokens || 0,
      completion_tokens: data.usage.completion_tokens || 0,
      total_tokens: data.usage.total_tokens || 0,
    };
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
function cleanSSEDataLine(line: string): {
  line: string | null;
  usage?: { p: number; c: number; t: number };
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
    model: data.model || "",
  };

  let extractedUsage: { p: number; c: number; t: number } | undefined;

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
        const p = choice.usage.prompt_tokens || 0;
        const c = choice.usage.completion_tokens || 0;
        cleaned.usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
        extractedUsage = { p, c, t: p + c };
      }
      return out;
    });
  } else {
    cleaned.choices = [];
  }

  return { line: "data: " + JSON.stringify(cleaned), usage: extractedUsage };
}

// ========== Routes ==========

/**
 * GET /v1/models
 * Returns hardcoded model list. Only includes models tested & confirmed working
 * against the Bloome LLM proxy.
 */
app.get(`${API_PREFIX}/models`, (c) => {
  return c.json({ object: "list", data: MODELS });
});

/**
 * POST /v1/chat/completions
 * OpenAI-compatible chat completions endpoint.
 *
 * Behavior per model:
 * - `claude-*` → translates to Anthropic Messages, calls /v1/messages, translates back
 * - `gpt-5.x` / `o1` / `o3` / `o4` → rewrites `max_tokens` → `max_completion_tokens`
 * - others (Kimi etc.) → direct passthrough
 *
 * Streaming and non-streaming both supported.
 * All responses cleaned to strict OpenAI format.
 */
app.post(`${API_PREFIX}/chat/completions`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
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

  // ===== Branch 1: Claude → translate to Anthropic =====
  if (isClaudeModel(body.model)) {
    const anthropicBody = openaiToAnthropicRequest(body);

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
      return c.json(upstream.error ? upstream : anthropicToOpenaiResponse(upstream), resp.status as any);
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
      let chunkId = "", chunkModel = body.model;
      let roleSent = false, lastStop: string | null = null, lastUsage: any = null;

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
            chunkModel = m.model || chunkModel;
            if (!roleSent) { await writeChunk({ role: "assistant", content: "" }); roleSent = true; }
          } else if (curEvent === "content_block_delta") {
            const dl = d.delta || {};
            if (dl.type === "text_delta" && typeof dl.text === "string" && dl.text) {
              await writeChunk({ content: dl.text });
            }
          } else if (curEvent === "message_delta") {
            if (d.delta?.stop_reason) lastStop = d.delta.stop_reason;
            if (d.usage) {
              const inT = d.usage.input_tokens || 0, outT = d.usage.output_tokens || 0;
              lastUsage = { prompt_tokens: inT, completion_tokens: outT, total_tokens: inT + outT };
            }
          } else if (curEvent === "message_stop") {
            await writeChunk({}, mapAnthropicStopReason(lastStop) || "stop", lastUsage);
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
    const googleBody = openaiToGoogleRequest(body);
    const upstreamHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    };
    if (!isStream) {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/models/${body.model}:generateContent`, {
        method: "POST", headers: upstreamHeaders, body: JSON.stringify(googleBody)
      });
      const upstream: any = await resp.json().catch(() => ({ error: { message: "Upstream error" } }));
      return c.json(upstream.error ? upstream : googleToOpenaiResponse(upstream), resp.status as any);
    }
    return streamSSE(c, async (stream) => {
      const resp = await fetch(`${BLOOME_LLM_BASE}/v1/models/${body.model}:streamGenerateContent?alt=sse`, {
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
      let chunkId = "", chunkModel = body.model, roleSent = false;
      
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
                const textDelta = candidate?.content?.parts?.[0]?.text || "";
                const finishReason = candidate?.finishReason;
                chunkId = d.responseId || chunkId;
                chunkModel = d.modelVersion || chunkModel;
                if (!roleSent) { await writeChunk({ role: "assistant", content: "" }); roleSent = true; }
                if (textDelta) await writeChunk({ content: textDelta });
                if (finishReason || d.usageMetadata) {
                  const usage = d.usageMetadata ? { prompt_tokens: d.usageMetadata.promptTokenCount || 0, completion_tokens: d.usageMetadata.candidatesTokenCount || 0, total_tokens: d.usageMetadata.totalTokenCount || 0 } : null;
                  await writeChunk({}, mapGoogleFinishReason(finishReason) || "stop", usage);
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
  if (!isStream) {
    const resp = await fetch(`${BLOOME_LLM_BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });
    const data = await resp.json().catch(() => ({ error: { message: "Upstream error" } }));
    return c.json(cleanChatCompletion(data), resp.status as any);
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
            const r = cleanSSEDataLine(line.trim());
            if (r.line !== null) await stream.write(r.line + "\n");
          } else {
            await stream.write("\n");
          }
        }
      }
      if (buffer.trim()) {
        const r = cleanSSEDataLine(buffer.trim());
        if (r.line !== null) await stream.write(r.line + "\n");
      }
      await stream.write("data: [DONE]\n\n");
    } finally {
      reader.releaseLock();
      await stream.close();
    }
  });
});


/**
 * POST /v1/models/:action
 * Gemini native passthrough.
 * Supports /v1/models/gemini-3.1-pro:generateContent and streamGenerateContent
 */

/**
 * POST /messages
 * Anthropic native passthrough
 */
app.post(`${API_PREFIX}/messages`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  const body = await c.req.text();
  const resp = await fetch(`${BLOOME_LLM_BASE}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": c.req.header("anthropic-version") || "2023-06-01",
    },
    body
  });
  return new Response(resp.body, { status: resp.status, headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json" } });
});

app.post(`${API_PREFIX}/models/:action`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  const action = c.req.param("action");
  const body = await c.req.text();
  const url = `${BLOOME_LLM_BASE}/v1/models/${action}` + (c.req.query("alt") ? `?alt=${c.req.query("alt")}` : "");

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body
  });

  if (!resp.ok) {
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }

  // Pass through stream or JSON directly
  return new Response(resp.body, {
    status: resp.status,
    headers: {
      "Content-Type": resp.headers.get("Content-Type") || "application/json"
    }
  });
});


app.post(`${API_PREFIX.replace('/v1', '/v1beta')}/models/:action`, async (c) => {
  const apiKey = getEnv(c, "BLOOME_API_KEY");
  const action = c.req.param("action");
  const body = await c.req.text();
  const url = `${BLOOME_LLM_BASE}/v1/models/${action}` + (c.req.query("alt") ? `?alt=${c.req.query("alt")}` : "");
  const resp = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body });
  return new Response(resp.body, { status: resp.status, headers: { "Content-Type": resp.headers.get("Content-Type") || "application/json" } });
});

export default app;
