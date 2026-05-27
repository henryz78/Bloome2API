import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
const deployScript = readFileSync(new URL("../scripts/deploy-edgespark.sh", import.meta.url), "utf8");
const deployDoc = readFileSync(new URL("../DEPLOY.md", import.meta.url), "utf8");
const deployNotes = readFileSync(new URL("../DEPLOY_NOTES.md", import.meta.url), "utf8");
const deployLocalScript = readFileSync(new URL("../scripts/deploy-local.sh", import.meta.url), "utf8");

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
  assert.match(source, /Access-Control-Allow-Origin", "\*"/);
  assert.match(source, /anthropic-version/);
  assert.match(source, /anthropic-beta/);
  assert.match(source, /x-client-request-id/);
  assert.match(source, /Access-Control-Expose-Headers/);
});

test("health probes rotate across available OpenAI-compatible models", () => {
  assert.match(source, /HEALTH_CHECK_MODELS/);
  assert.match(source, /Math\.random/);
  assert.doesNotMatch(source, /model: "kimi-k2\.6"/);
  assert.match(source, /healthModel/);
});

test("public runtime surface is white-label", () => {
  assert.match(source, /PROVIDER_API_KEY/);
  assert.match(source, /APP_DEV_MODE/);
  assert.match(source, /providerApiKey/);
  assert.doesNotMatch(source, /BLOOME_API_KEY/);
  assert.doesNotMatch(source, /BLOOME2API_DEV_MODE/);
  assert.doesNotMatch(source, /bloomeApiKey/);
  assert.doesNotMatch(source, /owned_by: "reson"/);
  assert.doesNotMatch(source, /bloome2api\.compaction/);
  assert.doesNotMatch(source, /`bloome-\$\{hashString/);
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

test("token count unsupported cases map to not_supported_error", () => {
  assert.match(source, /function isUpstreamNotSupportedStatus/);
  assert.match(source, /status === 400/);
  assert.match(source, /token counting is only available for Anthropic-compatible models/);
  assert.match(source, /return anthropicJsonError\(c, 501, "not_supported_error"/);
});

test("public errors have explicit type and code taxonomy", () => {
  for (const type of [
    "configuration_error",
    "unsupported_error",
    "model_not_found_error",
    "rate_limit_error",
    "upstream_bad_request",
    "upstream_auth_error",
    "upstream_unavailable",
  ]) {
    assert.match(source, new RegExp(`${type}: \\{`));
  }
  assert.match(source, /code: "model_not_found"/);
  assert.match(source, /code: "unsupported_parameter"/);
  assert.match(source, /publicErrorBody/);
});

test("upstream errors are classified by status and body text", () => {
  assert.match(source, /function classifyUpstreamError/);
  assert.match(source, /unknown gemini action/);
  assert.match(source, /rate limit/);
  assert.match(source, /invalid api key/);
  assert.match(source, /status === 400\) return \{ status: 502, type: "upstream_bad_request" \}/);
});

test("upstream error text does not scan full upstream payloads", () => {
  const upstreamTextStart = source.indexOf("function upstreamErrorText");
  const classifierStart = source.indexOf("function classifyUpstreamError");
  assert.ok(upstreamTextStart > 0);
  assert.ok(classifierStart > upstreamTextStart);

  const upstreamTextSource = source.slice(upstreamTextStart, classifierStart);
  assert.match(upstreamTextSource, /body\.error\?\.message/);
  assert.doesNotMatch(upstreamTextSource, /JSON\.stringify\(body\)/);
});

test("model-not-found classification avoids broad unrelated text matches", () => {
  const classifierStart = source.indexOf("function classifyUpstreamError");
  const unsupportedStatusStart = source.indexOf("function classifyInternalGatewayStatus");
  assert.ok(classifierStart > 0);
  assert.ok(unsupportedStatusStart > classifierStart);

  const classifierSource = source.slice(classifierStart, unsupportedStatusStart);
  assert.match(classifierSource, /model alias/);
  assert.doesNotMatch(classifierSource, /text\.includes\("model"\) && text\.includes\("not found"\)/);
});

test("translated unsupported parameters return unsupported_error", () => {
  assert.match(source, /"unsupported_error", \{ unsupported: \["functions", "function_call"\] \}/);
  assert.match(source, /"unsupported_error", \{ unsupported: unsupportedReasons \}/);
});

test("deploy script supports hot deploy without var sync or pull", () => {
  assert.match(deployScript, /HOT_DEPLOY_ONLY/);
  assert.match(deployScript, /SKIP_VAR_SYNC/);
  assert.match(deployScript, /SKIP_PULL/);
  assert.match(deployScript, /if \[\[ "\$\{SKIP_NPM_INSTALL:-0\}" != "1" \]\]; then\s+require_cmd npm/s);
  assert.match(deployScript, /if \[\[ "\$\{SKIP_VAR_SYNC:-0\}" != "1" \]\]/);
  assert.match(deployScript, /: "\$\{PROVIDER_API_KEY:\?Missing PROVIDER_API_KEY\}"/);
  assert.doesNotMatch(deployScript, /BLOOME_API_KEY/);
  assert.doesNotMatch(deployScript, /BLOOME2API_DEV_MODE/);
  assert.match(deployScript, /if \[\[ "\$\{SKIP_PULL:-0\}" != "1" \]\]/);
});

test("deploy docs require user-provided client key and copyable success report", () => {
  assert.match(deployDoc, /CLIENT_API_KEY 必须由用户提供/);
  assert.match(deployDoc, /默认部署目标是公网 EdgeSpark 地址/);
  assert.match(deployDoc, /Base URL\s+```text\s+https:\/\/<域名>\.edgespark\.app\/api\/public\/v1\s+```/s);
  assert.match(deployDoc, /API Key\s+```text\s+<CLIENT_API_KEY>\s+```/s);
  assert.doesNotMatch(deployDoc, /Bloome2API 部署成功/);
  assert.match(deployDoc, /不要替用户随机生成/);
  assert.doesNotMatch(deployDoc, /openssl rand|uuidgen|pwgen|randomBytes/i);
});

test("public docs use neutral product naming", () => {
  assert.match(deployDoc, /PROVIDER_API_KEY/);
  assert.match(deployDoc, /APP_DEV_MODE/);
  assert.doesNotMatch(deployDoc, /BLOOME2API_DEV_MODE/);
  assert.doesNotMatch(deployDoc, /Bloome2API 部署成功/);
});

test("local deploy wrapper keeps secrets explicit and supports optional verification", () => {
  assert.match(deployLocalScript, /EDGESPARK_SECRET_NAME/);
  assert.match(deployLocalScript, /RESON_LLM_API_KEY/);
  assert.match(deployLocalScript, /CLIENT_API_KEY/);
  assert.match(deployLocalScript, /CLOUD_CMD/);
  assert.match(deployLocalScript, /command -v bloome/);
  assert.match(deployLocalScript, /command -v bloome-cli/);
  assert.match(deployLocalScript, /cloud CLI not found/);
  assert.match(deployLocalScript, /export EDGESPARK_SECRET_NAME/);
  assert.match(deployLocalScript, /HOT_DEPLOY_ONLY/);
  assert.match(deployLocalScript, /BASE_URL/);
  assert.match(deployLocalScript, /require_cmd curl/);
  assert.match(deployLocalScript, /chat\/completions/);
  assert.match(deployLocalScript, /scripts\/deploy-edgespark\.sh/);
  assert.match(deployLocalScript, /export PROVIDER_API_KEY="\$RESON_LLM_API_KEY"/);
  assert.doesNotMatch(deployLocalScript, /require_cmd bloome/);
  assert.doesNotMatch(deployLocalScript, /1346792580a/);
  assert.doesNotMatch(deployLocalScript, /CLIENT_API_KEY=["'][^"$]/);
  assert.match(deployNotes, /scripts\/deploy-local\.sh/);
});
