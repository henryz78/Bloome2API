# MODELS

这份文档记录当前 Model Gateway 中已支持的模型，并把三层名字分开说明：

- **展示名**：前端 / 平台里看到的自然名称
- **公开调用名（alias）**：Model Gateway 对外要求用户填写的 `model`
- **实际上游模型**：provider 上游最终打到的 alias / modelVersion

## 字段说明

- **展示名**：客户端里看到的名字
- **公开调用名（alias）**：请求 `/v1/chat/completions` 时应填写的 `model`
- **协议入口**：代理内部实际走的上游协议
  - `Anthropic` → `/v1/messages`
  - `OpenAI` → `/v1/chat/completions`
  - `Gemini` → `/v1/models/{model}:generateContent`
- **实际上游模型**：真实探测时上游最终使用 / 返回的 alias 或 modelVersion
- **重定向/套壳**：
  - `否`：基本就是这个模型本身
  - `是`：说明这个 alias 最终落到了别的真实模型上

注意：`/models` 接口里的 `id` / `root` 继续保持公开调用名，不暴露实际上游模型。实际上游模型只用于文档、排障和模型探测记录。

## 当前支持模型

| 展示名 | 公开调用名（alias） | 协议入口 | 实际上游模型 | 重定向/套壳 | 备注 |
|---|---|---|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | Anthropic | `claude-opus-4-7` | 否 | 返回名未变 |
| Claude Opus 4.6 | `claude-opus-4-6` | Anthropic | `claude-opus-4-6` | 否 | 返回名未变 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Anthropic | `claude-sonnet-4-6` | 否 | 返回名未变 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` | 否 | 返回为带日期后缀的具体版本 |
| Claude Opus 4.7 Thinking | `claude-opus-4-7-thinking` | Anthropic | `claude-opus-4-7` | 否 | thinking alias；代理会提取 `thinking` / `thinking_delta` 映射到 `reasoning_content` |
| Claude Opus 4.6 Thinking | `claude-opus-4-6-thinking` | Anthropic | `claude-opus-4-6` | 否 | thinking alias；代理会提取 `thinking` / `thinking_delta` 映射到 `reasoning_content` |
| Claude Sonnet 4.6 Thinking | `claude-sonnet-4-6-thinking` | Anthropic | `claude-sonnet-4-6` | 否 | thinking alias；代理会提取 `thinking` / `thinking_delta` 映射到 `reasoning_content` |
| Claude Haiku 4.5 Thinking | `claude-haiku-4-5-thinking` | Anthropic | `claude-haiku-4-5-20251001` | 否 | thinking alias；固定走 `enabled + budget_tokens` |
| MiniMax M2.7 | `MiniMax-M2.7` | Anthropic | `MiniMax-M2.7` | 否 | 注意大小写敏感 |
| GPT 5.4 | `gpt-5.4` | OpenAI | `gpt-5.4-2026-03-05` | 否 | 返回为带日期后缀的具体版本 |
| GPT 5.4 Thinking | `gpt-5.4-thinking` | OpenAI | `gpt-5.4-2026-03-05` | 否 | thinking alias；代理会映射到 `gpt-5.4` 并注入 `reasoning_effort: medium` |
| GPT 5.4 Mini | `gpt-5.4-mini` | OpenAI | `gpt-5.4-mini-2026-03-17` | 否 | 返回为带日期后缀的具体版本 |
| GPT 5.4 Mini Thinking | `gpt-5.4-mini-thinking` | OpenAI | `gpt-5.4-mini-2026-03-17` | 否 | thinking alias；代理会映射到 `gpt-5.4-mini` 并注入 `reasoning_effort: medium` |
| GPT 5.5 | `gpt-5.5` | OpenAI | `gpt-5.5-2026-04-24` | 否 | 新模型；需要 `max_completion_tokens` |
| GPT 5.5 Thinking | `gpt-5.5-thinking` | OpenAI | `gpt-5.5-2026-04-24` | 否 | thinking alias；代理会映射到 `gpt-5.5` 并注入 `reasoning_effort: medium` |
| GLM 5.0 | `glm-5.0` | OpenAI | `glm-5` | 是 | 展示层未列出；仓库额外公开的基础 alias |
| GLM 5.1 | `glm-5.1` | OpenAI | `glm-5.1` | 否 | 返回名未变 |
| Kimi K2.6 | `kimi-k2.6` | OpenAI | `kimi-k2.6` | 否 | 返回名未变 |
| Kimi K2.5 | `kimi-k2.5` | OpenAI | `kimi-k2.6` | 是 | 公开 alias 保留 K2.5，实际上游落到 K2.6 |
| Xiaomi MiMo V2.5 Pro | `mimo-v2-pro` | OpenAI | `mimo-v2-pro` | 否 | 展示名和公开 alias 不同 |
| Xiaomi MiMo V2.5 | `mimo-v2-omni` | OpenAI | `mimo-v2-omni` | 否 | 展示名和公开 alias 不同 |
| DeepSeek V4 Pro | `deepseek-v4-pro` | OpenAI | `deepseek-v4-pro` | 否 | 返回名未变 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | OpenAI | `deepseek-v4-flash` | 否 | 返回名未变 |
| DeepSeek V3.2 | `deepseek-v3-2` | OpenAI | `deepseek-v4-pro` | 是 | 公开 alias 保留 V3.2，实际上游落到 V4 Pro |
| Gemini 3.1 Pro | `gemini-3.1-pro` | Gemini | `gemini-3.1-pro-preview` | 是 | 实际是 preview 版本 |
| Gemini 3.1 Pro Thinking | `gemini-3.1-pro-thinking` | Gemini | `gemini-3.1-pro-preview` | 是 | thinking alias；代理会将 `parts[].thought` 映射到 `reasoning_content` |
| Gemini 3 Flash | `gemini-3-flash` | Gemini | `gemini-3-flash-preview` | 是 | 实际是 preview 版本 |
| Gemini 3 Flash Thinking | `gemini-3-flash-thinking` | Gemini | `gemini-3-flash-preview` | 是 | thinking alias；代理会将 `parts[].thought` 映射到 `reasoning_content` |

## 额外说明

### 1. 关于工具调用

Claude / MiniMax / Gemini 会在代理层进行 OpenAI `tools` / `tool_calls` 到上游工具协议的双向转换。

当前支持范围：

- Claude / MiniMax：非流式和流式工具调用
- Gemini：非流式工具调用；`stream: true` 时由代理层伪流式输出 SSE，但 provider 上游仍是非流式，不要把 Gemini 当作真正流式模型使用
- OpenAI `tools: [{ type: "function", function: ... }]`
- 多轮工具结果回传，即 OpenAI `role: "tool"` 消息

当前不支持：

- 旧版 `functions` / `function_call`

### 2. 关于 API 兼容层

默认前缀仍是 `/api/public/v1`。

当前公开接口分三类：

- OpenAI Chat Completions：`POST /chat/completions`
- OpenAI Responses 最小兼容层：`POST /responses`、`POST /responses/compact`、`POST /responses/input_tokens`
- Anthropic Messages 兼容层：`POST /messages`、`POST /messages/count_tokens`

注意：

- `/responses` 是无状态 shim，不保存 response / conversation；`previous_response_id` 和 conversation 持久化语义不会被伪装。
- `/responses/compact` 会用当前模型生成摘要，返回 `response.compaction`。其中 `encrypted_content` 是本项目可识别的 opaque payload，不是 OpenAI 官方平台加密格式。
- `/responses/input_tokens` 只在 Anthropic 兼容模型上转真实上游 token count。其他模型族会返回 `not_supported_error`，避免用估算值冒充官方计数。
- `/messages` 保持 Anthropic 原生格式，适合 Anthropic SDK；Claude / MiniMax 的 OpenAI Chat 翻译路径仍然保留。

### 3. 关于错误分类

公开错误响应会保持安全默认值：返回稳定的 `error.type`、`error.code` 和 `request_id`，不暴露原始上游错误。只有 `APP_DEV_MODE=true` 时才会额外返回 `error.detail`。

完整分类说明见 [ERRORS.md](ERRORS.md)。

常见分类：

| type | code | 说明 |
|---|---|---|
| `authentication_error` | `authentication_failed` | 客户端认证失败 |
| `configuration_error` | `server_misconfigured` | 网关缺环境变量或配置错误 |
| `invalid_request_error` | `invalid_request` | 请求格式或必填字段错误 |
| `unsupported_error` | `unsupported_parameter` | endpoint 存在，但传入参数当前不支持 |
| `not_supported_error` | `not_supported` | endpoint 或模型能力不支持 |
| `model_not_found_error` | `model_not_found` | 上游或网关无法识别模型 alias |
| `rate_limit_error` | `rate_limited` | 上游限流 / quota |
| `upstream_timeout` | `upstream_timeout` | 上游超时 |
| `upstream_bad_request` | `upstream_bad_request` | 上游 400，但不能安全归因到客户端参数 |
| `upstream_auth_error` | `upstream_auth_error` | 上游认证或权限异常 |
| `upstream_unavailable` | `upstream_unavailable` | 上游 5xx 或临时不可用 |
| `upstream_error` | `upstream_error` | 未能进一步细分的上游错误 |
| `server_error` | `server_error` | 网关内部异常 |

### 4. 关于 Prompt Cache

本项目只做 prompt cache 兼容层：正确生成/透传缓存相关参数，并保留上游返回的缓存 usage 字段。真实缓存写入、读取和 token 折扣取决于最终上游是否支持。当前 provider 上游实测缓存字段仍为 0，这不是网关代码错误。

Claude / MiniMax 路径支持 Anthropic 风格的 prompt cache 参数：

- 显式 `cache_control` 会从 OpenAI content parts / tools 转发到 Anthropic block
- 客户端传入的 `ttl` 会原样透传
- 没有显式断点时，代理默认在静态前缀末尾补 `{ "type": "ephemeral", "ttl": "5m" }`
- 请求体传 `prompt_cache: false` 可关闭自动断点

GPT 路径兼容上游自动 prompt cache：

- 代理会保留上游返回的 `usage.prompt_tokens_details.cached_tokens`
- 对带 system / tools / response_format 的 `gpt-*` 请求，代理会自动补稳定的 `prompt_cache_key`
- 客户端显式传入的 `prompt_cache_key` 优先，不会被覆盖
- 请求体传 `prompt_cache: false` 可关闭自动 key

这只影响 prompt cache 参数兼容和统计字段保留，不是响应缓存。

### 5. 关于输出 Token 上限

Claude / MiniMax 走 Anthropic 协议，`max_tokens` 必填。网关在用户未传时按具体 alias 补默认上限：

- `claude-opus-4-7` / `claude-opus-4-7-thinking`：`128000`
- `claude-opus-4-6` / `claude-opus-4-6-thinking`：`128000`
- `claude-sonnet-4-6` / `claude-sonnet-4-6-thinking`：`128000`
- `claude-haiku-4-5` / `claude-haiku-4-5-thinking`：`64000`
- MiniMax-M2.7：`131072`

可用 `ANTHROPIC_DEFAULT_MAX_TOKENS` 覆盖 Anthropic 兼容分支的默认值。

Gemini 走 Vertex 协议。网关在用户未传时默认补 `generationConfig.maxOutputTokens = 65536`，可用 `GEMINI_DEFAULT_MAX_TOKENS` 覆盖。Gemini 的 `stream: true` 是代理层伪流式：上游仍调用非流式 `generateContent`，代理拿到完整结果后再拆成 OpenAI SSE chunk 返回。

OpenAI 分支里，GPT-5.5 也和 GPT-5.4 一样要求 `max_completion_tokens`，网关会自动从 `max_tokens` 转换。

Kimi / GPT / GLM / DeepSeek / Mimo 走 OpenAI 原生分支，用户未传时网关不主动补输出上限。

用户显式传入 `max_tokens` 或 `max_completion_tokens` 时，优先使用用户传入值。最终可输出长度仍取决于 provider 上游和具体模型 alias。

### 6. 关于展示名和公开 alias

这些展示名和公开调用名不完全一致，文档和前端需要分清：

| 展示名 | 公开调用名（alias） |
|---|---|
| Xiaomi MiMo V2.5 Pro | `mimo-v2-pro` |
| Xiaomi MiMo V2.5 | `mimo-v2-omni` |
| GPT 5.4 Mini | `gpt-5.4-mini` |
| DeepSeek V3.2 | `deepseek-v3-2` |
| MiniMax M2.7 | `MiniMax-M2.7` |

### 7. 关于 MiniMax M2.7

这个模型比较特殊：

- 客户端展示名是 **MiniMax M2.7**
- 真正可用的代理 id 是 **`MiniMax-M2.7`**
- 必须保持这个大小写形式
- 它走的是 **Anthropic 协议入口**，不是 OpenAI

之前像下面这些写法都不可用：

- `minimax-m2.7`
- `minimax-m2-7`
- `minimax`
- `m2.7`

### 8. 关于 DeepSeek V3.2

客户端展示常写作 **DeepSeek V3.2**，但代理里应写：

- `deepseek-v3-2`

注意是连字符 `-`，不是小数点 `.`。

而且它目前上游实际会落到：

- `deepseek-v4-pro`

### 9. 关于“是否真的是那个模型”

这里的“真”分三种情况：

1. **返回名完全一致**  
   例如：`MiniMax-M2.7`、`glm-5.1`、`deepseek-v4-pro`

2. **返回的是同系列具体版本号**  
   例如：`gpt-5.4` → `gpt-5.4-2026-03-05`

3. **明显 alias 映射到别的模型**  
   例如：
   - `glm-5.0` → `glm-5`
   - `kimi-k2.5` → `kimi-k2.6`
   - `deepseek-v3-2` → `deepseek-v4-pro`

## 维护建议

当前仓库已经内置了完整模型列表。

### 部署时怎么验证

正常部署或热更新时，**不需要把所有模型重新测一遍**。
只需要做一个单模型 smoke test 即可，默认优先：

- `kimi-k2.6`

只要：

- `/models` 正常
- 单模型 `/chat/completions` 正常返回 `choices`

就足够说明当前部署基本可用。

### 什么时候需要重新做多模型探测

只有在你准备：

- 新增一个仓库里还没有的模型
- 修改模型路由判断逻辑
- 调整某个模型的协议入口
- 怀疑某个 alias 的真实上游映射变了

才需要重新做更细的模型探测。

### 新增模型时的建议流程

如果之后客户端新增模型，建议按下面顺序验证：

1. 先尝试 OpenAI 入口
2. 再尝试 Anthropic 入口
3. 最后尝试 Gemini 入口
4. 记录：
   - 是否能调用成功
   - 上游返回的真实 model / modelVersion
   - 是否发生重定向
5. 更新：
   - `docs/MODELS.md`
   - `src/index.ts` 里的 `MODELS` 列表

