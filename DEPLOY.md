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
curl http://localhost:3000/api/public/v1/models
```

应该返回 JSON，`data` 数组里有模型。**如果列表是空的或者只有 0 个模型，不要慌，继续下一步。**

### 5.2 测试聊天（先测 Kimi）

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}]}'
```

如果返回 `Model alias not found`，说明用户在 Bloome 那边没有切到过这个模型。**让用户去 Bloome 设置 → 把当前模型切到 `kimi-k2.6` → 切完之后你重试。**

如果返回正常 JSON 带 `choices`，✅ 通过。

### 5.3 测试 GPT-5.4

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

如果返回 `Model alias not found`，**让用户去 Bloome 设置切到 `gpt-5.4`**，然后重试。

如果正常返回，✅ 通过。

### 5.4 测试 Claude

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"claude-opus-4-7","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

如果返回 `Model alias not found`，**让用户去 Bloome 设置切到 `claude-opus-4-7`**（注意是连字符），然后重试。

如果正常返回，✅ 通过。

### 5.5 测试流式

```bash
curl -N -X POST http://localhost:3000/api/public/v1/chat/completions \
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
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
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

> "本地测试已全部通过。现在把你想要设置的**客户端 API Key**（即调用密码）发给我，我来部署到 EdgeSpark 公网。"

拿到密码后，执行部署：

1. 创建项目：
```bash
bloome-cli edgespark project create --alias gateway
```

**重要规则：**
- 真正从零部署时，优先用 fresh alias（例如 `gateway-20260509`），不要默认复用历史 alias。
- create 之后先做一次 `pull smoke test`，通过了再继续 deploy。
- 如果 `pull` 失败，优先判断 binding/token 有问题，不要先怀疑业务代码。

2. 先做 pull smoke test：
```bash
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY__XXXX -- bash -c 'cd edgespark/gateway && EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY__XXXX" EDGESPARK_PROJECT_ENVIRONMENT=production edgespark pull'
```
如果这一步失败，不要继续 deploy。先处理 binding/token 问题。

3. 将代码复制到 EdgeSpark 项目，并精准注入 EdgeSpark 运行时变量补丁：
```bash
cp src/index.ts edgespark/gateway/server/src/index.ts
sed -i '1s/^/import { vars } from "edgespark";\n/' edgespark/gateway/server/src/index.ts
sed -i 's|// __EDGESPARK_INJECT_VARS__|try { const v = vars.get(key as RuntimeKey); if (v) return v; } catch(e) {}|' edgespark/gateway/server/src/index.ts
```

4. **不要把密钥写进 `edgespark.toml`，也不要提交到仓库。** 运行时变量必须远程设置：
```bash
cd edgespark/gateway
EDGESPARK_PROJECT_ENVIRONMENT=production edgespark var set \
  BLOOME_API_KEY="这里填你的真实BLOOME_API_KEY" \
  CLIENT_API_KEY="用户给的密码"
```
**注意：**
- `secret call` 只会注入你指定的 secret，不会顺手把 Agent 里的其它环境变量带进去。
- 不要在 `secret call ... bash -c '...'` 里面指望 `$RESON_LLM_API_KEY` 自动可用。
- `BLOOME_API_KEY` 请直接传完整值，不要用 `head` / 截断方式取 key。

5. 进入目录并部署：
```bash
cd edgespark/gateway/server
npm install
EDGESPARK_PROJECT_ENVIRONMENT=production npx edgespark deploy
```
如果你刚刚执行过 `edgespark var set`，这里仍然需要重新 deploy 一次；vars 不会自动热加载到线上运行时。

6. 先验证健康检查和配置状态（`/health` 允许免鉴权访问，便于第一次 bring-up 排障）：
```bash
curl https://xxx.edgespark.app/api/public/v1/health
```
应该看到：
```json
{"status":"ok","config":{"bloomeApiKey":true,"clientApiKey":true}}
```

7. 再验证模型列表 / 聊天接口，确认返回 200。
8. 把存活的公网链接发给用户。

**补充规则：**
- 旧 alias 一旦出现 `verify 404`、`invalid bearer token`、`unhealthy`，直接当作脏 binding 处理。
- 不要继续在旧 alias 上反复 deploy。
- 处理方式是：换 fresh alias 继续，或者删掉旧 alias 后重建。

## 第九步：热更新（已有 EdgeSpark 项目时）

如果项目已经部署过，且只是：

- 修改 `src/index.ts`
- 新增或调整 `MODELS` 列表
- 修复请求转换 / SSE / thinking / reasoning 逻辑
- 更新 `CLIENT_API_KEY` 或其它运行时变量

那么**不需要重新创建 EdgeSpark 项目**，直接做热更新即可。

### 热更新步骤

1. 确认当前项目别名（本项目默认是 `gateway`）
2. 先检查当前 alias 状态：
```bash
bloome-cli edgespark project info gateway
bloome-cli edgespark project verify gateway
```
如果这里已经出现 `verify 404`、`invalid bearer token`、`unhealthy`，不要热更新，直接按“重建项目”处理。

3. 再跑一次 pull smoke test：
```bash
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY__XXXX -- bash -c 'cd edgespark/gateway && EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY__XXXX" EDGESPARK_PROJECT_ENVIRONMENT=production edgespark pull'
```
如果 pull 失败，也不要继续 deploy。

4. 把最新代码同步到 EdgeSpark 项目目录：
```bash
cp src/index.ts edgespark/gateway/server/src/index.ts
sed -i '1s/^/import { vars } from "edgespark";\n/' edgespark/gateway/server/src/index.ts
sed -i 's|// __EDGESPARK_INJECT_VARS__|try { const v = vars.get(key as RuntimeKey); if (v) return v; } catch(e) {}|' edgespark/gateway/server/src/index.ts
```

5. 如有环境变量变更，远程同步更新：
```bash
cd edgespark/gateway
EDGESPARK_PROJECT_ENVIRONMENT=production edgespark var set \
  BLOOME_API_KEY="这里填你的真实BLOOME_API_KEY" \
  CLIENT_API_KEY="用户当前想设置的密码"
```
如果你刚刚执行过 `edgespark var set`，后面仍然需要重新 deploy 一次；vars 不会自动热加载。

6. 进入项目目录并重新部署：
```bash
cd edgespark/gateway/server
npm install
EDGESPARK_PROJECT_ENVIRONMENT=production npx edgespark deploy
```

7. 部署完成后，先验证配置健康，再验证模型接口：
```bash
curl https://你的域名.edgespark.app/api/public/v1/health
curl -H "Authorization: Bearer 你的CLIENT_API_KEY" https://你的域名.edgespark.app/api/public/v1/models
```

8. **无论 URL 是否变化，都把最新完整公网 API URL 再发给用户确认一次**。

### 什么时候必须重建项目，什么时候只需要热更新

**只需要热更新：**
- 逻辑修复
- 模型列表更新
- thinking / reasoning 适配
- 文档以外的服务端代码更新
- API Key 轮换
- 当前 alias 的 `project info` / `verify` / `pull smoke test` 都正常

**需要重新创建项目：**
- 本地没有 `edgespark/gateway/` 项目目录了
- 需要换一个全新的 EdgeSpark alias / 项目
- 旧项目绑定关系失效或必须迁移到新项目
- 旧 alias 出现 `verify 404`、`invalid bearer token`、`unhealthy`

## 关键提醒（Agent 必须牢记）

1. **模型 alias 的激活机制**：Bloome 的 LLM 代理不是把所有模型都暴露的。用户必须在 Bloome 设置里切到某个模型一次，代理才认得这个 alias。所以每加一个新模型，先让用户切一次，然后你 curl 验证。

2. **alias 的精确写法**：`claude-opus-4-7`（连字符）≠ `claude-opus-4.7`（点）。`gpt-5.4`（点）≠ `gpt-5-4`（连字符）。用不对就报 `Model alias not found`。

3. **不要偷换字段**：Kimi 在流式模式下 `delta.content` 为空、内容在 `delta.reasoning_content` 里。**保持原样**，不要映射。代码里的 clean 逻辑已经正确处理了。

4. **不要去掉 SSE 清洗**：`cleanSSEDataLine` 函数里那个 `choices.length === 0` 返回 null 的逻辑**不能删**。删了客户端会报 `JsonArray is not JsonObject`。

5. **GPT-5.x 的参数问题**：`max_tokens` 不支持，必须用 `max_completion_tokens`。代码里 `isReasoningModel` 函数已经做了自动改写，不删就行。

6. **Claude 只能走 `/v1/messages`**：不要试图用 `/v1/chat/completions` 端点调 Claude。代码里 `isClaudeModel` 判断已经自动转发到正确端点。

7. **每次部署或更新必须返回最新网址**：EdgeSpark 如果是全新部署或重新创建项目，生成的公网网址会发生变化。因此，无论是首次部署，还是后续做完修复和更新，只要执行了 `deploy`，都**必须**把最新的完整公网 API URL（例如 `https://xxx.edgespark.app/api/public/v1`）明确提供给用户，防止客户端配错旧地址。

8. **EdgeSpark 部署先 smoke test，再 deploy**：create 之后先用对应 secret 跑一次 `edgespark pull`。如果 pull 失败，优先判断 binding/token 有问题；不要急着怀疑业务代码。

9. **不要手动改 `EDGESPARK_BASE_URL`**：正常情况下只设置 `EDGESPARK_PROJECT_ENVIRONMENT=production` 就够了。CLI 的 API 域名和项目运行域名后缀不同是正常现象，不要被这个带偏。

## 不要做的事

- ❌ 把 API key 写死在代码里
- ❌ 猜测模型名然后加到列表里——必须逐个 curl 验证
- ❌ 删掉 `cleanSSEDataLine` 里的空 choices 过滤
- ❌ 把 `reasoning_content` 映射到 `content`
- ❌ Claude 请求不带 `anthropic-version` 头
- ❌ 跳过第七步的流式验证
- ❌ 把密钥写进 `edgespark.toml` 或提交到仓库
- ❌ 旧 alias 已经 `verify 404` / `invalid bearer token` 了，还继续在上面反复 deploy
- ❌ 在 `secret call` 里直接引用 `$RESON_LLM_API_KEY`，然后以为它会自动有值
- ❌ 用 `head` 或截断方式去取 `BLOOME_API_KEY`
- ❌ 为了 `.dev` / `.app` 域名差异手动乱改 `EDGESPARK_BASE_URL`
