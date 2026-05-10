# DEPLOY.md — Agent 操作手册

> 你是 AI Agent。按顺序执行。**不要跳步、不要猜测、不要自己发明流程。**
>
> 命令说明：如果你的环境里有 `bloome-cli` 包装，就按文中的 shell 命令执行；如果没有 `bloome-cli`，但有 `bloome` 工具，则执行对应的等价 `bloome` 操作，不要因为缺少 wrapper 就改流程。

---

## 一句话原则

这个仓库当前已经内置了完整模型列表。

部署时你**不需要把所有模型重新测一遍**，只需要完成：

1. 本地最小 smoke test
2. EdgeSpark create + pull smoke test
3. 用 `scripts/deploy-edgespark.sh` 完成公网部署
4. 验证 `health` / `models` / **一个** `chat/completions`

如果未来要新增模型，不在这里处理，看：

- `docs/MODELS.md`

---

## 第一步：理解项目

先读：

- `src/index.ts`

理解它的职责：

- `GET /v1/models`：返回模型列表
- `POST /v1/chat/completions`：OpenAI 兼容聊天接口
- Claude 自动转 Anthropic `/v1/messages`
- Gemini 自动转 Google `generateContent` / `streamGenerateContent`
- GPT-5.x / `o*` 自动把 `max_tokens` 改写为 `max_completion_tokens`
- 清洗上游响应中的非标准字段与脏 SSE chunk

先看懂，不要急着改代码。

---

## 第二步：准备本地环境

检查 Bun：

```bash
bun --version
```

如果没有，再安装：

```bash
curl -fsSL https://bun.sh/install | bash
```

安装依赖：

```bash
cd 项目根目录
bun install
```

---

## 第三步：准备运行时变量

### `BLOOME_API_KEY`
优先从 Agent 自己环境里读取，不要先问用户。

例如：

```bash
echo $RESON_LLM_API_KEY
```

然后设置：

```bash
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
```

### `CLIENT_API_KEY`
这个是用户想设置给客户端使用的调用密码，**需要向用户确认**。

---

## 第四步：本地最小 smoke test

设置好变量后，本地启动：

```bash
export CLIENT_API_KEY="用户给的密码"
bun start
```

默认监听：

- `http://localhost:3000`

### 4.1 模型列表

```bash
curl http://localhost:3000/api/public/v1/models
```

应该返回 JSON，且有 `data` 数组。

### 4.2 单模型聊天 smoke test

默认只测一个稳定模型即可，优先：

- `kimi-k2.6`

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

判断规则：

- 返回正常 JSON，且有 `choices` → 通过
- 返回 `Model alias not found` → 说明用户还没在 Bloome 里切到这个模型；让用户先切一次 `kimi-k2.6`，再重试

### 4.3 可选：流式 smoke test

如果你要额外确认 SSE 没坏，可以再跑：

```bash
curl -N -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
```

应该看到 `data:` chunk，最后以 `data: [DONE]` 结束。

---

## 第五步：让用户在客户端配置本地代理

本地 smoke test 通过后，告诉用户：

| 设置项 | 值 |
|--------|-----|
| Base URL | `http://localhost:3000` |
| API Key | `CLIENT_API_KEY` 的值 |
| 模型 | 当前仓库里已内置的模型 id |

---

## 第六步：[询问用户] 部署到 EdgeSpark 公网

停下来，问用户：

> “本地 smoke test 已通过。现在把你想设置的客户端 API Key 发给我，我来部署到 EdgeSpark 公网。”

拿到 `CLIENT_API_KEY` 后，按下面流程做。

---

## 第七步：创建 EdgeSpark 项目

优先使用 fresh alias，例如：

- `gateway-20260509`

创建项目：

```bash
bloome-cli edgespark project create --alias gateway-20260509
```

重要规则：

- 真正从零部署时，优先 fresh alias，不要默认复用旧 alias
- 旧 alias 只要出现 `verify 404` / `invalid bearer token` / `unhealthy`，直接废弃

---

## 第八步：先做 pull smoke test

create 成功后，先用对应的 EdgeSpark secret 跑一次 `edgespark pull`。

示例：

```bash
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY_20260509__XXXX -- bash -c 'cd edgespark/gateway-20260509 && EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY_20260509__XXXX" EDGESPARK_PROJECT_ENVIRONMENT=production edgespark pull'
```

如果这一步失败：

- 不要继续 deploy
- 优先判断 binding / token 问题
- 不要先怀疑业务代码

---

## 第九步：默认用脚本部署公网

公网部署默认入口是：

- `scripts/deploy-edgespark.sh`

执行前准备变量：

```bash
export BLOOME_API_KEY="你的真实 BLOOME_API_KEY"
export CLIENT_API_KEY="用户给的密码"
export EDGESPARK_API_KEY="从 secret call 注入的值"
export EDGESPARK_PROJECT_ENVIRONMENT=production
```

然后执行：

```bash
./scripts/deploy-edgespark.sh gateway-20260509
```

这个脚本会自动完成：

- 同步 `src/index.ts`
- 注入 `vars`
- 注入 `installBloomeBridge(app)`
- patch `server/src/defs/runtime.ts`
- `edgespark var set`
- `edgespark pull`
- `npm install`
- `edgespark deploy`

**不要把手工 `cp` / `sed` / patch 流程当主路径。**
那些只用于：

- 理解脚本内部做了什么
- 或脚本失败后的排障

---

## 第十步：部署后验收

部署完成后，固定做 4 个检查。

### 10.1 verify

```bash
bloome-cli edgespark project verify gateway-20260509
```

应返回 ready / healthy。

### 10.2 health

```bash
curl https://xxx.edgespark.app/api/public/v1/health
```

应看到：

```json
{"status":"ok","config":{"bloomeApiKey":true,"clientApiKey":true}}
```

### 10.3 models

带 key：

```bash
curl -H "Authorization: Bearer 你的CLIENT_API_KEY" https://xxx.edgespark.app/api/public/v1/models
```

应返回 200。

不带 key：

```bash
curl -i https://xxx.edgespark.app/api/public/v1/models
```

应返回 401。

### 10.4 单模型 chat smoke test

仍然只测一个模型，优先：

- `kimi-k2.6`

```bash
curl -X POST https://xxx.edgespark.app/api/public/v1/chat/completions \
  -H "Authorization: Bearer 你的CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

返回正常 JSON 且有 `choices` 即可。

---

## 第十一步：向用户汇报最终可用配置

不要只说“部署成功了”。

必须明确返回：

- alias
- base URL
- API 前缀
- CLIENT_API_KEY
- verify 结果
- health 结果
- models（带 key）结果
- models（不带 key）结果
- 单模型 chat smoke test 结果

例如：

- 公网地址：`https://xxx.edgespark.app`
- API 前缀：`https://xxx.edgespark.app/api/public/v1`
- API Key：`CLIENT_API_KEY`

---

## 热更新（已有 EdgeSpark 项目时）

如果项目已经存在，且只是：

- 修改 `src/index.ts`
- 调整模型列表
- 修复请求转换 / SSE / reasoning 逻辑
- 更新 `CLIENT_API_KEY` 或其它运行时变量

那么不需要重新 create 项目，直接热更新即可。

### 热更新步骤

1. 检查 alias 状态：

```bash
bloome-cli edgespark project info gateway
bloome-cli edgespark project verify gateway
```

如果已经出现 `verify 404` / `invalid bearer token` / `unhealthy`，不要热更新，直接换 fresh alias。

2. 先跑 pull smoke test：

```bash
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY__XXXX -- bash -c 'cd edgespark/gateway && EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY__XXXX" EDGESPARK_PROJECT_ENVIRONMENT=production edgespark pull'
```

3. 再运行：

```bash
./scripts/deploy-edgespark.sh gateway
```

4. 部署后重新做：

- `verify`
- `health`
- `models`
- 单模型 `chat/completions` smoke test

5. 把**最新完整公网 API URL**重新发给用户。

---

## 关键提醒

1. **模型 alias 需要先激活**：用户必须先在 Bloome 里切到某个模型一次，代理才认得这个 alias。
2. **alias 写法必须精确**：`claude-opus-4-7` ≠ `claude-opus-4.7`；`gpt-5.4` ≠ `gpt-5-4`。
3. **不要动 SSE 清洗逻辑**：`cleanSSEDataLine` 里对空 `choices` 的过滤不能删。
4. **不要把 `reasoning_content` 映射到 `content`**。
5. **Claude 只能走 `/v1/messages`**，不要拿 `/v1/chat/completions` 直接调上游 Claude。
6. **每次 deploy 后都要把最新地址重新发给用户**。
7. **EdgeSpark 部署必须先 smoke test，再 deploy**。
8. **不要把密钥写进仓库文件或 `edgespark.toml`**。

---

## 不要做的事

- ❌ 把 API key 写死在代码里
- ❌ 猜模型名然后直接加到列表里
- ❌ 跳过 pull smoke test
- ❌ 跳过 deploy 后的 `health` / `models` / chat 验收
- ❌ 旧 alias 已经脏了还继续反复 deploy
- ❌ 在 `secret call` 里假设 `$RESON_LLM_API_KEY` 会自动有值
- ❌ 用截断方式去取 `BLOOME_API_KEY`
- ❌ 为了域名后缀差异手动乱改 `EDGESPARK_BASE_URL`
