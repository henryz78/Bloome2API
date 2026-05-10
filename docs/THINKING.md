# THINKING

这份文档定义 Bloome2API 中“思考模式（thinking / reasoning）”的设计原则、模型命名约定，以及不同上游协议的兼容方案。

## 目标

希望做到：

> 凡是上游官方支持显式开启思考/推理模式，并且上游接口实际返回可见思考内容的模型，都能在代理层用统一方式暴露出来。

这里的“可见思考内容”包括但不限于：

- Anthropic 的 `thinking` / `thinking_delta`
- Gemini 的 `parts[].thought`
- OpenAI / DeepSeek / Kimi / GLM 风格的 `reasoning_content`
- OpenAI Responses API 的 reasoning summary

## 设计原则

## 1. 原模型默认行为不变

不修改现有模型 alias 的默认行为。

例如：

- `claude-opus-4-6` 仍然表示普通模式
- `gemini-3.1-pro` 仍然表示普通模式
- `gpt-5.4` 仍然表示普通模式

这可以避免：

- 无意增加延迟
- 无意增加 token 成本
- 改变已有客户端的体验预期

## 2. 用 `-thinking` 后缀表示显式开启思考模式

对于“默认不返回思考，但可以通过官方参数开启思考模式”的模型，新增一个显式 alias：

- `claude-opus-4-6-thinking`
- `claude-sonnet-4-6-thinking`
- `claude-haiku-4-5-thinking`
- `claude-opus-4-7-thinking`
- `gemini-3.1-pro-thinking`
- `gemini-3-flash-thinking`

未来如果引入 Responses API reasoning summary，再考虑新增：

- `gpt-5.4-thinking`
- `gpt-5.4-mini-thinking`

语义固定为：

> 代理会为该模型启用官方支持的 thinking / reasoning 模式，并在上游返回可见思考内容时，将其映射到统一输出结构中。

注意：

- `-thinking` 表示“显式尝试开启思考模式”
- **不保证**上游一定返回可见思考文本
- 是否最终可见，取决于官方能力 + 实际上游网关是否透传

## 3. 不给天然就是 reasoning 输出的模型重复加 `-thinking`

对于已经默认直接返回 `reasoning_content` 的模型，不建议额外添加 `-thinking` alias。

当前已实测属于这类的模型包括：

- `glm-5.1`
- `kimi-k2.6`
- `kimi-k2.5`
- `deepseek-v4-pro`
- `deepseek-v4-flash`
- `deepseek-v3-2`

原因：

- 它们本身已经是“思考可见”模型
- 再加 `-thinking` 会让语义变得模糊
- 用户会难以理解普通版和 `-thinking` 版到底差在哪

只有在未来确认“普通 alias 不返回 reasoning，而 `-thinking` alias 会返回更多 reasoning 信息”时，才考虑为这类模型增加额外 thinking alias。

## 当前建议的 `-thinking` 适用范围

## 第一批：优先实现 Claude 家族

建议优先支持：

- `claude-opus-4-7-thinking`
- `claude-opus-4-6-thinking`
- `claude-sonnet-4-6-thinking`
- `claude-haiku-4-5-thinking`

原因：

- 官方 thinking 机制最清晰
- Anthropic 流式事件格式清楚
- 目前实测已经确认多个 Claude 模型能返回 `thinking` / `thinking_delta`

## 第二批：Gemini 家族

建议后续支持：

- `gemini-3.1-pro-thinking`
- `gemini-3-flash-thinking`

前提是确认上游在启用：

```json
thinkingConfig: {
  includeThoughts: true
}
```

后，确实会返回 `parts[].thought`。

## 未来候选：GPT-5 家族

当前尚未实现；如果后续引入 Responses API reasoning summary，再考虑支持：

- `gpt-5.4-thinking`
- `gpt-5.4-mini-thinking`

原因：

- GPT-5 官方 reasoning 更适合走 Responses API
- Chat Completions 往往只能看到 `reasoning_tokens` 计数，拿不到可见 reasoning 文本
- 是否能真正暴露“可见思考”，取决于是否引入 Responses API summary 兼容层

## Claude 家族的已确认行为

当前已实测结论如下。

| 模型 | 普通模式 | `thinking.enabled` | `thinking.adaptive` | 流式 `thinking_delta` | 结论 |
|---|---|---|---|---|---|
| `claude-opus-4-7` | 可用 | 不支持 | 支持 | 待继续补测 | 4.7 必须走 adaptive |
| `claude-opus-4-6` | 可用 | 支持 | 支持 | 已确认存在 | 最适合第一批实现 |
| `claude-sonnet-4-6` | 可用 | 支持 | 支持 | 已确认存在 | 最适合第一批实现 |
| `claude-haiku-4-5` | 可用 | 支持 | 不支持 | 已确认存在（enabled） | 只能走 enabled |

### Claude Opus 4.7

实测已确认：

- 不支持：
  ```json
  thinking: { "type": "enabled", "budget_tokens": 1024 }
  ```
- 支持：
  ```json
  thinking: { "type": "adaptive" }
  ```

并且上游报错信息明确提示：

> Use `thinking.type.adaptive` and `output_config.effort` to control thinking behavior.

因此 `claude-opus-4-7-thinking` 的最终实现应优先考虑：

> 当前实测表明：即使显式传入 `display: "summarized"`，现阶段 Bloome 上游 / 当前 Bedrock 路由仍可能只返回正文、不返回可见 thinking summary。也就是说，代理侧已按官方推荐参数开启，但当前上游未必透传可见 summary。

```json
{
  "thinking": { "type": "adaptive", "display": "summarized" },
  "output_config": { "effort": "medium" }
}
```

### Claude Opus 4.6 / Sonnet 4.6

这两个模型当前都支持两种 thinking 开启方式：

#### 方式 A：enabled
```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```

#### 方式 B：adaptive
```json
{
  "thinking": {
    "type": "adaptive"
  }
}
```

并且已经确认：

- 非流式会返回 `content[].type === "thinking"`
- 流式会返回 `thinking_delta`
- 最后还有 `signature` / `signature_delta`

### Claude Haiku 4.5

当前实测：

- `adaptive` 不支持
- `enabled + budget_tokens >= 1024` 可用
- 流式 `thinking_delta` 已确认存在

因此 `claude-haiku-4-5-thinking` 的实现应固定为：

```json
{
  "thinking": {
    "type": "enabled",
    "budget_tokens": 1024
  }
}
```

## 统一输出策略

代理层的目标不是保留各家原始格式，而是统一暴露给 OpenAI 风格客户端。

建议统一为：

- 正常正文 → `choices[0].message.content`
- 思考内容 → `choices[0].message.reasoning_content`

## 非流式兼容

### Anthropic

从 `content[]` 中拆分：

- `type === "thinking"` → 拼到 `reasoning_content`
- `type === "text"` → 拼到 `content`
- `type === "redacted_thinking"` → 预留兼容，不作为明文 reasoning 输出

### Gemini

从 `candidates[0].content.parts[]` 中拆分：

- `part.thought === true` → 拼到 `reasoning_content`
- 其余 `text` → 拼到 `content`

### OpenAI / DeepSeek / Kimi / GLM

直接读取：

- `message.reasoning_content`
- `message.content`

### OpenAI Responses API

如果未来引入 GPT-5 reasoning summary：

- reasoning summary → `reasoning_content`
- message text → `content`

## 流式兼容

### Anthropic SSE

按事件序列解析：

- `content_block_start` with `type: "thinking"`
- `content_block_delta.delta.type === "thinking_delta"`
- `content_block_delta.delta.type === "signature_delta"`
- `content_block_start` with `type: "text"`
- `content_block_delta.delta.type === "text_delta"`

建议在代理层转换为统一的 OpenAI 风格流式增量：

- thinking 增量 → reasoning 增量
- text 增量 → content 增量

### Gemini 流式

后续待补实测。

### OpenAI / DeepSeek / Kimi / GLM 流式

如果上游已经支持 reasoning delta，则尽量透传；
如果只支持完整 reasoning_content，则在非流式场景优先保证正确性。

## 与 `MODELS.md` 的关系

`MODELS.md` 负责回答：

- 当前支持哪些模型
- 它们真实对应哪个上游模型
- 是否存在 alias 重定向

而本文件负责回答：

- 哪些模型适合增加 `-thinking` alias
- 不同厂商 thinking 的开启方式是什么
- 代理层应该如何统一映射 thinking 输出

## 实施顺序建议

### 第一步：文档先行

先把设计意图、命名约定、协议差异写清楚。

### 第二步：只实现 Claude `-thinking`

建议第一批只做：

- `claude-opus-4-7-thinking`
- `claude-opus-4-6-thinking`
- `claude-sonnet-4-6-thinking`
- `claude-haiku-4-5-thinking`

### 第三步：补 Gemini 探测并决定是否实现

当前已确认 `includeThoughts` 在当前上游真实可用；下一步重点是代理映射与文档同步。

### 第四步：最后再处理 GPT-5

如果需要可见 reasoning summary，则评估是否引入 Responses API 路径。

## 一句话定义

可以把整个方案概括成一句话：

> `-thinking` 后缀表示：代理会为该模型启用官方支持的 thinking / reasoning 模式，并在上游返回可见思考内容时将其统一映射到 `reasoning_content`。

