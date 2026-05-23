# ERRORS

Bloome2API 的公开错误响应默认采用安全模式：返回稳定的错误分类和 `request_id`，不暴露原始上游错误细节。只有设置 `BLOOME2API_DEV_MODE=true` 时，响应里才会额外包含 `error.detail`，用于排查。

## 响应结构

OpenAI 兼容 JSON 错误：

```json
{
  "error": {
    "message": "Upstream service error. Please check logs.",
    "type": "upstream_error",
    "code": "upstream_error"
  },
  "request_id": "..."
}
```

Anthropic Messages 兼容 JSON 错误：

```json
{
  "type": "error",
  "error": {
    "message": "Endpoint or capability is not supported. Please check logs.",
    "type": "not_supported_error",
    "code": "not_supported"
  },
  "request_id": "..."
}
```

SSE 流式错误也会使用同一套 `error.type` / `error.code` / `request_id` 分类。

## 错误分类

| type | code | HTTP | 说明 |
|---|---|---:|---|
| `authentication_error` | `authentication_failed` | 401 | 客户端没有传有效 `Authorization` / `x-api-key`，或与 `CLIENT_API_KEY` 不匹配 |
| `configuration_error` | `server_misconfigured` | 500 | 网关缺少必要环境变量，例如 `BLOOME_API_KEY` 或 `CLIENT_API_KEY` |
| `invalid_request_error` | `invalid_request` | 400 | 请求 JSON、body、消息结构或必填字段不合法 |
| `unsupported_error` | `unsupported_parameter` | 400 | endpoint 存在，但某个传入参数当前不支持 |
| `not_supported_error` | `not_supported` | 501 | endpoint、模型族或能力整体不支持 |
| `model_not_found_error` | `model_not_found` | 404 | 模型 alias 不存在，或上游明确返回模型不存在 |
| `rate_limit_error` | `rate_limited` | 503 | 上游限流、quota 不足或并发限制 |
| `upstream_timeout` | `upstream_timeout` | 504 | 上游请求超时 |
| `upstream_bad_request` | `upstream_bad_request` | 502 | 上游返回 400，但不能安全归因到客户端参数 |
| `upstream_auth_error` | `upstream_auth_error` | 502 | 上游 API key、权限或账号侧认证异常 |
| `upstream_unavailable` | `upstream_unavailable` | 503 | 上游服务 5xx、临时不可用或冲突状态 |
| `upstream_error` | `upstream_error` | 502 | 未能进一步细分的上游错误 |
| `server_error` | `server_error` | 500 | 网关内部异常 |

## `unsupported_error` 与 `not_supported_error`

这两个类型刻意分开：

| 场景 | 返回 |
|---|---|
| `/chat/completions` 请求 Claude / Gemini 时传入 `presence_penalty`、`logit_bias`、`parallel_tool_calls` 等暂未翻译的参数 | `unsupported_error` |
| `/messages/count_tokens` 上游不提供真实 token count 能力 | `not_supported_error` |
| `/responses/input_tokens` 请求非 Anthropic 兼容模型 | `not_supported_error` |
| 旧版 `functions` / `function_call` 参数 | `unsupported_error` |

简单判断：请求目标存在但某个参数不支持，用 `unsupported_error`；整个 endpoint 或能力不能提供，用 `not_supported_error`。

## 上游错误归类

上游错误会先提取明确错误字段，例如 `error.message`、`message`、`detail`，再做保守分类。不会扫描完整上游 JSON payload，避免长响应或附带字段导致误判。

当前会识别这些常见上游文本：

| 上游信号 | 公开分类 |
|---|---|
| `Model alias ... not found` / `model ... not found` | `model_not_found_error` |
| `Unknown Gemini action` | `not_supported_error` |
| `rate limit` / `too many requests` / `quota` | `rate_limit_error` |
| `timeout` / `timed out` | `upstream_timeout` |
| `unauthorized` / `forbidden` / `permission` / `invalid api key` | `upstream_auth_error` |

默认模式下，即使命中了这些上游信号，公开响应也只返回安全后的 `message`、`type`、`code` 和 `request_id`。
