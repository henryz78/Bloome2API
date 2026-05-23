import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

test("public v1 exposes Anthropic Messages and OpenAI Responses compatibility routes", () => {
  assert.match(source, /API_PREFIX}\/messages`/);
  assert.match(source, /API_PREFIX}\/messages\/count_tokens`/);
  assert.match(source, /API_PREFIX}\/responses`/);
  assert.match(source, /API_PREFIX}\/responses\/compact`/);
  assert.match(source, /API_PREFIX}\/responses\/input_tokens`/);
});

test("static Responses routes are registered before dynamic response id routes", () => {
  const compact = source.indexOf("app.post(`${API_PREFIX}/responses/compact`");
  const inputTokens = source.indexOf("app.post(`${API_PREFIX}/responses/input_tokens`");
  const dynamicCompact = source.indexOf("app.post(`${API_PREFIX}/responses/:response_id/compact`");
  const retrieve = source.indexOf("app.get(`${API_PREFIX}/responses/:response_id`");

  assert.ok(compact > 0);
  assert.ok(inputTokens > 0);
  assert.ok(dynamicCompact > 0);
  assert.ok(retrieve > 0);
  assert.ok(compact < dynamicCompact);
  assert.ok(inputTokens < retrieve);
});

test("CORS allows Anthropic SDK headers", () => {
  assert.match(source, /anthropic-version/);
  assert.match(source, /anthropic-beta/);
});

test("translated Chat Completions handle developer messages and stream usage", () => {
  assert.match(source, /m\.role === "developer"/);
  assert.match(source, /wantsStreamUsage/);
  assert.match(source, /writeOpenAIStreamUsageChunk/);
  assert.match(source, /presence_penalty/);
  assert.match(source, /frequency_penalty/);
  assert.match(source, /parallel_tool_calls/);
  assert.match(source, /mergeOpenAIUsage\(lastUsage, m\.usage\)/);
  assert.match(source, /mergeOpenAIUsage\(lastUsage, d\.usage\)/);
});

test("Responses streaming emits item and content lifecycle events", () => {
  assert.match(source, /response\.output_item\.added/);
  assert.match(source, /response\.content_part\.added/);
  assert.match(source, /response\.output_text\.done/);
  assert.match(source, /response\.content_part\.done/);
  assert.match(source, /response\.output_item\.done/);
  assert.match(source, /writeResponseNonTextOutputEvents/);
});

test("Responses internal errors keep the public safe-error policy", () => {
  assert.match(source, /classifyInternalGatewayStatus/);
  assert.match(source, /openAIEventError/);
  assert.doesNotMatch(source, /return c\.json\(upstream \|\|/);
});
