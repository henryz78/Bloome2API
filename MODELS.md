# MODELS

这份文档记录当前 Bloome2API 代理中已支持的模型，以及它们在上游 Bloome API 中的真实映射情况。

## 字段说明

- **展示名**：客户端里看到的名字
- **代理 model id**：请求 `/v1/chat/completions` 时应填写的 `model`
- **协议入口**：代理内部实际走的上游协议
  - `Anthropic` → `/v1/messages`
  - `OpenAI` → `/v1/chat/completions`
  - `Gemini` → `/v1/models/{model}:generateContent`
- **上游实际返回模型名**：真实探测时上游返回的 model / modelVersion
- **重定向/套壳**：
  - `否`：基本就是这个模型本身
  - `是`：说明这个 alias 最终落到了别的真实模型上

## 当前支持模型

| 展示名 | 代理 model id | 协议入口 | 上游实际返回模型名 | 重定向/套壳 | 备注 |
|---|---|---|---|---|---|
| Claude Opus 4.7 | `claude-opus-4-7` | Anthropic | `claude-opus-4-7` | 否 | 返回名未变 |
| Claude Opus 4.6 | `claude-opus-4-6` | Anthropic | `claude-opus-4-6` | 否 | 返回名未变 |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | Anthropic | `claude-sonnet-4-6` | 否 | 返回名未变 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | Anthropic | `claude-haiku-4-5-20251001` | 否 | 返回为带日期后缀的具体版本 |
| MiniMax M2.7 | `MiniMax-M2.7` | Anthropic | `MiniMax-M2.7` | 否 | 注意大小写敏感 |
| GPT 5.4 | `gpt-5.4` | OpenAI | `gpt-5.4-2026-03-05` | 否 | 返回为带日期后缀的具体版本 |
| GPT 5.4 Mini | `gpt-5.4-mini` | OpenAI | `gpt-5.4-mini-2026-03-17` | 否 | 返回为带日期后缀的具体版本 |
| GLM 5.1 | `glm-5.1` | OpenAI | `glm-5.1` | 否 | 返回名未变 |
| Kimi K2.6 | `kimi-k2.6` | OpenAI | `kimi-k2.6` | 否 | 返回名未变 |
| Kimi K2.5 | `kimi-k2.5` | OpenAI | `kimi-k2.6` | 是 | 实际落到 K2.6 |
| Xiaomi MiMo V2 Pro | `mimo-v2-pro` | OpenAI | `xiaomi/mimo-v2.5-pro-20260422` | 是 | alias 对应到更具体的新版本 |
| Xiaomi MiMo V2 Omni | `mimo-v2-omni` | OpenAI | `xiaomi/mimo-v2.5-20260422` | 是 | alias 对应到更具体的新版本 |
| DeepSeek V4 Pro | `deepseek-v4-pro` | OpenAI | `deepseek-v4-pro` | 否 | 返回名未变 |
| DeepSeek V4 Flash | `deepseek-v4-flash` | OpenAI | `deepseek-v4-flash` | 否 | 返回名未变 |
| DeepSeek V3.2 | `deepseek-v3-2` | OpenAI | `deepseek-v4-pro` | 是 | 实际落到 V4 Pro；注意代理 id 里是连字符，不是点 |
| Gemini 3.1 Pro | `gemini-3.1-pro` | Gemini | `gemini-3.1-pro-preview` | 是 | 实际是 preview 版本 |
| Gemini 3 Flash | `gemini-3-flash` | Gemini | `gemini-3-flash-preview` | 是 | 实际是 preview 版本 |

## 额外说明

### 1. 关于 MiniMax M2.7

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

### 2. 关于 DeepSeek V3.2

客户端展示常写作 **DeepSeek V3.2**，但代理里应写：

- `deepseek-v3-2`

注意是连字符 `-`，不是小数点 `.`。

而且它目前上游实际会落到：

- `deepseek-v4-pro`

### 3. 关于“是否真的是那个模型”

这里的“真”分三种情况：

1. **返回名完全一致**  
   例如：`MiniMax-M2.7`、`glm-5.1`、`deepseek-v4-pro`

2. **返回的是同系列具体版本号**  
   例如：`gpt-5.4` → `gpt-5.4-2026-03-05`

3. **明显 alias 映射到别的模型**  
   例如：
   - `kimi-k2.5` → `kimi-k2.6`
   - `deepseek-v3-2` → `deepseek-v4-pro`

## 维护建议

如果之后客户端新增模型，建议按下面顺序验证：

1. 先尝试 OpenAI 入口
2. 再尝试 Anthropic 入口
3. 最后尝试 Gemini 入口
4. 记录：
   - 是否能调用成功
   - 上游返回的真实 model / modelVersion
   - 是否发生重定向

