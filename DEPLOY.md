# DEPLOY.md — Agent 操作手册

> 你是 AI Agent。读完本文件后，按顺序逐步执行。**不要跳步、不要猜测、不要自作主张。**
> 遇到 `[询问用户]` 标记时，停下来向用户提问，拿到答案后再继续。

---

## 第一步：了解项目

先读完 `src/index.ts`，理解它做了什么：

- `GET /v1/models` — 返回可用模型列表
- `POST /v1/chat/completions` — OpenAI 兼容的聊天接口，支持流式和非流式
- 对 `claude-*` 模型：自动把 OpenAI 请求转成 Anthropic 格式，调上游的 `/v1/messages`，再把响应转回来
- 对 `gpt-5.x` / `o` 系列模型：自动把 `max_tokens` 改写成 `max_completion_tokens`
- 清洗上游返回的脏数据（去空 chunk、提 usage、去 system_fingerprint）

不要改代码。先看懂。

---

## 第二步：确认运行环境

检查用户的机器上有没有 Bun：

```bash
bun --version
```

如果没有，安装：

```bash
curl -fsSL https://bun.sh/install | bash
```

---

## 第三步：获取 API Key（Agent 自行获取，不要问用户）

**绝对不要向用户索要 API Key。** 你是 Agent，Key 就在你自己的环境变量里。

运行命令读取它：
```bash
echo $RESON_LLM_API_KEY
```
或者 `$RESON_AGENT_TOKEN`。

拿到后，设环境变量：
```bash
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
```

同时在项目根目录创建 `.env` 文件：
```
BLOOME_API_KEY=你的环境变量里的真实值
```

---

## 第四步：安装依赖

```bash
cd 项目根目录
bun install
```

---

## 第五步：启动并验证

```bash
bun start
```

默认跑在 3000 端口。另开一个终端，逐条跑下面的验证：

### 5.1 模型列表

```bash
curl http://localhost:3000/v1/models
```

应该返回 JSON，`data` 数组里有模型。**如果列表是空的或者只有 0 个模型，不要慌，继续下一步。**

### 5.2 测试聊天（先测 Kimi）

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}]}'
```

如果返回 `Model alias not found`，说明用户在 Bloome 那边没有切到过这个模型。**让用户去 Bloome 设置 → 把当前模型切到 `kimi-k2.6` → 切完之后你重试。**

如果返回正常 JSON 带 `choices`，✅ 通过。

### 5.3 测试 GPT-5.4

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

如果返回 `Model alias not found`，**让用户去 Bloome 设置切到 `gpt-5.4`**，然后重试。

如果正常返回，✅ 通过。

### 5.4 测试 Claude

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

如果返回 `Model alias not found`，**让用户去 Bloome 设置切到 `claude-opus-4-7`**（注意是连字符），然后重试。

如果正常返回，✅ 通过。

### 5.5 测试流式

```bash
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
```

应该看到逐行输出的 `data:` chunk，最后以 `data: [DONE]` 结束。**中途不应出现 `choices:[]` 的空行。**

---

## 第六步：[询问用户] 扩展模型列表

**停下来，向用户提问：**

> "目前代码里预置了 4 个模型名：kimi-k2.6、kimi-k2.5、gpt-5.4、claude-opus-4-7。你还想支持哪些模型？把模型名列给我。"

用户给列表后，**逐个测试**：

```bash
# 对每个模型名，跑这个（注意 alias 的精确写法——连字符和点不能搞混）
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"用户给的模型名","messages":[{"role":"user","content":"hi"}],"max_tokens":5}'
```

**测试规则：**

- ✅ 返回正常 JSON（不管 content 有没有内容）→ 表示 alias 有效
- ❌ 返回 `Model alias 'xxx' not found` → 让用户去 Bloome 设置里切到这个模型，切完你再重试
- ❌ 用户切了之后还是 `not found` → alias 名可能写错了，问用户精确的模型名

**对每个测试通过的模型：**

1. 打开 `src/index.ts`，找到 `MODELS` 数组
2. 按同样格式追加一条：

```ts
{ id: "模型名", object: "model", created: 1687882411, owned_by: "reson", root: "模型名", parent: null },
```

3. **同时测试流式**：加 `"stream":true` 再跑一次，确认 SSE 输出正常

---

## 第七步：让用户在客户端配置

全部模型测试通过后，告诉用户客户端配置：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:3000` |
| API Key | 任意值（网关不校验客户端 key） |
| 模型 | 刚才验证通过的那些模型名 |

如果用户要部署到公网（Cloudflare Workers / VPS 等），Base URL 换成对应的公网地址。


---

## 第八步：[询问用户] 获取客户端 API Key 并部署到公网 (EdgeSpark)

**停下来，向用户提问：**

> "本地测试已全部通过。为了让你在外网（如 Rikkahub）能用，我现在把它部署到 EdgeSpark 公网。请告诉我你想要设置的**客户端 API Key**（即当做密码使用）。"

拿到用户想设置的密码后，开始部署：

1. 绑定 EdgeSpark 项目（不要用独立的 edgespark-cli，直接用 bloome-cli）：
```bash
bloome-cli edgespark project create --alias gateway
```
2. 把 `src/index.ts` 复制到生成的 `edgespark/gateway/server/src/index.ts` 里。
3. 部署时注入两个环境变量（一个是你的 Bloome Token，一个是用户刚才设置的客户端密码）：
```bash
bloome-cli edgespark project deploy --alias gateway --env BLOOME_API_KEY="$RESON_LLM_API_KEY" --env CLIENT_API_KEY="用户给的密码"
```
4. 部署成功后，**把带有 `https://xxx.edgespark.app` 的公网链接发给用户**。


---

## 关键提醒（Agent 必须牢记）

1. **模型 alias 的激活机制**：Bloome 的 LLM 代理不是把所有模型都暴露的。用户必须在 Bloome 设置里切到某个模型一次，代理才认得这个 alias。所以每加一个新模型，先让用户切一次，然后你 curl 验证。

2. **alias 的精确写法**：`claude-opus-4-7`（连字符）≠ `claude-opus-4.7`（点）。`gpt-5.4`（点）≠ `gpt-5-4`（连字符）。用不对就报 `Model alias not found`。

3. **不要偷换字段**：Kimi 在流式模式下 `delta.content` 为空、内容在 `delta.reasoning_content` 里。**保持原样**，不要映射。代码里的 clean 逻辑已经正确处理了。

4. **不要去掉 SSE 清洗**：`cleanSSEDataLine` 函数里那个 `choices.length === 0` 返回 null 的逻辑**不能删**。删了客户端会报 `JsonArray is not JsonObject`。

5. **GPT-5.x 的参数问题**：`max_tokens` 不支持，必须用 `max_completion_tokens`。代码里 `isReasoningModel` 函数已经做了自动改写，不删就行。

6. **Claude 只能走 `/v1/messages`**：不要试图用 `/v1/chat/completions` 端点调 Claude。代码里 `isClaudeModel` 判断已经自动转发到正确端点。

---

## 不要做的事

- ❌ 把 API key 写死在代码里
- ❌ 猜测模型名然后加到列表里——必须逐个 curl 验证
- ❌ 删掉 `cleanSSEDataLine` 里的空 choices 过滤
- ❌ 把 `reasoning_content` 映射到 `content`
- ❌ Claude 请求不带 `anthropic-version` 头
- ❌ 跳过第七步的流式验证
