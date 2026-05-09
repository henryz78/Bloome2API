# Prompt: Deploy This Bloome LLM Gateway

> 把这整份文件直接发给 AI Agent。Agent 应该能独立完成部署、扩展和维护。

---

## 项目背景

这是一个 **OpenAI 兼容 API 网关**，将 Bloome 的内置 LLM 代理（`stream.bloome.im/api/llm/proxy/reson`）以标准 OpenAI 格式暴露给外部客户端使用。

核心文件：`src/index.ts`（Hono 框架，~380 行）。

## 它做了什么

| 功能 | 说明 |
|------|------|
| 模型列表 | `GET /v1/models` 返回可用模型 |
| OpenAI 格式代理 | `POST /v1/chat/completions` 支持流式和非流式 |
| Claude 自动翻译 | 请求 Claude 时自动 OpenAI ↔ Anthropic 双向转换 |
| GPT-5.x 参数修正 | `max_tokens` 自动改写为 `max_completion_tokens` |
| 响应清洗 | 去除非标字段、修复 SSE 格式 |

## 关键发现（Bloome 后端行为）

这些是通过反复测试总结的，后续 Agent 必须牢记：

### 模型可用性

- **Bloome LLM 代理的模型 alias 和 Bloome 聊天界面的模型选择是两套独立系统**
- 代理端点只识别被 "激活过" 的模型名
- **激活方法**：去 Bloome 设置里把当前会话模型切到目标模型一次，代理就会认得那个 alias
- 激活后不会自动失效——切到其他模型，之前激活过的还都能用
- **因此上线前必须在 Bloome 里把每个要支持的模型都切一遍**

### 后端响应特征（kimi-k2.6 实测）

| 行为 | 非流式 | 流式 |
|------|--------|------|
| `content` 字段 | 有正文 | **永远为空** |
| `reasoning_content` | 有思考链 | 有实际 token（正文在这里） |
| 额外字段 | `cached_tokens`（顶层）| `system_fingerprint` |
| SSE 尾部 | — | 多发一个 `choices: []` 空 chunk |

### GPT-5.4 实测

- `max_tokens` 不支持，必须用 `max_completion_tokens`
- 连字符写 `gpt-5.4`，不是 `gpt-5-4`

### Claude 实测

- **代理同时支持 `/v1/chat/completions`（OpenAI）和 `/v1/messages`（Anthropic）两个端点**
- Claude 只能用 `/v1/messages`，走 `/v1/chat/completions` 会报 "Provider type Bedrock does not belong to OpenAI family"
- Model alias 用**连字符**：`claude-opus-4-7`，不是 `claude-opus-4.7`
- 需要在请求头带 `anthropic-version: 2023-06-01`

## 绝对不要做的事

- ❌ 猜测模型名加入列表——必须逐个 curl 测试确认
- ❌ 把 `reasoning_content` 映射到 `content`——G禁止内容偷换字段，思考链和正文必须保持分离
- ❌ 流式清洗时保留 `choices: []` 的空 chunk——部分客户端会报 `JsonArray is not JsonObject`
- ❌ 让 `usage` 嵌套在 `choice` 里——提取到顶层才是 OpenAI 标准
- ❌ Claude 调用时省略 `anthropic-version` 头——必填
- ❌ 想当然以为 "切了模型就能测"——必须切完再测，因为 DNS/TTL 和分布式 Worker 坑很多

## 响应清洗 checklist（Agent 必须在代码里实现）

### 非流式

1. 只保留标准字段：`id`, `object`, `created`, `model`, `choices`, `usage`
2. `choices[*].message` 里只保留 `role`, `content`, `reasoning_content`
3. 移除 `cached_tokens`（顶层）、`system_fingerprint`

### 流式（SSE）

1. 每个 `data:` 行解析 JSON，清洗后重新序列化
2. `choices[*].delta` 只保留 `role`, `content`, `reasoning_content`
3. 丢弃 `choices: []` 的空 chunk（return null）
4. 把 `choice.usage` 提取到顶层 `usage`
5. 添加 `logprobs: null`
6. 以 `data: [DONE]\n\n` 结束

### Claude 流式（Anthropic SSE → OpenAI SSE）

1. 解析 `event:` / `data:` 对
2. `message_start` → 发 role chunk
3. `content_block_delta` → 发 content chunk
4. `message_delta` → 记录 stop_reason 和 usage
5. `message_stop` → 发 final chunk（含 finish_reason 和 usage）后 `[DONE]`
6. stop_reason 映射：`end_turn`→`stop`, `max_tokens`→`length`

## 修改后验证 checklist

每次改动后必须跑：

1. `curl /v1/models` → 返回 JSON array
2. `curl -X POST .../v1/chat/completions -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"hi"}]}'` → 正常非流式响应
3. 加 `"stream":true` 同上 → SSE 每行 data: 开头，无 choices: [] 空 chunk
4. `model":"claude-opus-4-7"` 同上 → 正常返回（非流式 + 流式都测）
5. `model":"gpt-5.4"` 同上 → `max_tokens` 参数不报错

## 客户端配置

| 设置项 | 值 |
|--------|-----|
| Base URL | `http(s)://<host>/` |
| API Key | 任意值或留空 |
| 模型 | `kimi-k2.6` / `kimi-k2.5` / `gpt-5.4` / `claude-opus-4-7` |

## 故障排查速查

| 症状 | 原因 | 修复 |
|------|------|------|
| `JsonArray is not JsonObject` | Bloome 发了 `choices: []` 空 chunk | 清洗代码里过滤掉 |
| 流式输出为空 | `delta.content` 为空，实际在 `reasoning_content` | 保持 reasoning_content 独立字段 |
| `Model alias not found` | 模型名未激活或不匹配 | 去 Bloome 切一次该模型，确认 alias 精确写法 |
| GPT-5.4 报 `unsupported_parameter` | `max_tokens` 不被支持 | 自动改写为 `max_completion_tokens` |
| Claude 报 "not belong to OpenAI family" | 走了 chat/completions 端点 | 必须转发到 `/v1/messages` |
| `max_tokens: field required` (Claude) | Anthropic 要求必填 max_tokens | 转换时给默认值 4096 |

---

## 扩展新模型的标准流程

```
1. 去 Bloome 设置 → 切到目标模型 → 确认切换成功
2. curl 测试: {"model":"<alias>","messages":[{"role":"user","content":"hi"}],"max_tokens":5}
3. 如果成功 → 记录 alias 精确写法（连字符/小数点）
4. 如果失败 → 尝试变体（- vs .、版本号有无）
5. 同时测试流式: 加 "stream":true
6. 观察响应特征: 是否需要参数修正（如 max_completion_tokens）
7. 如果是 Claude 类 → 测试 /v1/messages 端点
8. 确认后加入 MODELS 列表
9. 重新部署
10. 跑完整验证 checklist
```
