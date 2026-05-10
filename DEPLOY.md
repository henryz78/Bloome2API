# DEPLOY.md — Agent 部署流程

> 按顺序执行。不要跳步，不要猜测，不要把密钥写进仓库。
> 环境坑、认证坑和排障细节统一看 `DEPLOY_NOTES.md`。

---

## 一句话原则

这个仓库当前已经内置完整模型列表。部署时不需要把所有模型重新测一遍，只需要完成：

1. 安装 / 确认 Bun，并完成本地最小 smoke test
2. EdgeSpark create + pull smoke test
3. 用 `scripts/deploy-edgespark.sh` 完成公网部署
4. 验证 `health` / `models` / 一个 `chat/completions`

如果未来要新增模型，看 `docs/MODELS.md`。

---

## 第一步：理解项目

先读：

- `src/index.ts`
- `docs/MODELS.md`
- `DEPLOY_NOTES.md`

核心职责：

- `GET /api/public/v1/models`：返回模型列表
- `POST /api/public/v1/chat/completions`：OpenAI 兼容聊天接口
- Claude / MiniMax 自动转 Anthropic `/v1/messages`
- Gemini 自动转 Google `generateContent` / `streamGenerateContent`
- Claude / MiniMax / Gemini 支持 OpenAI `tools` / `tool_calls`，包括普通响应和流式响应
- GPT-5.x / `o*` 自动把 `max_tokens` 改写为 `max_completion_tokens`
- 清洗上游响应中的非标准字段与脏 SSE chunk

---

## 第二步：准备本地环境

本地运行依赖 Bun。部署公网前必须先跑本地 smoke test。

```bash
bun --version
bun install
```

如果没有 Bun，或安装时遇到 `unzip`、无 root 权限、Node 版本警告等问题，看 `DEPLOY_NOTES.md` 的“环境准备陷阱”。

---

## 第三步：准备运行时变量

### `BLOOME_API_KEY`

优先从 Agent 环境读取：

```bash
echo $RESON_LLM_API_KEY
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
```

### `CLIENT_API_KEY`

这是用户给客户端使用的调用密码，必须向用户确认：

```bash
export CLIENT_API_KEY="用户给的密码"
```

---

## 第四步：本地最小 smoke test

不要跳过。公网部署前必须先确认本地代理能启动、能列模型、能完成一个最小 chat 请求。

启动：

```bash
bun start
```

另开终端验证：

```bash
curl -H "Authorization: Bearer $CLIENT_API_KEY" http://localhost:3000/api/public/v1/models
```

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

通过标准：

- `/models` 返回 JSON，且有 `data` 数组
- `/chat/completions` 返回正常 JSON，且有 `choices`
- 如果返回 `Model alias not found`，让用户先在 Bloome 里切一次 `kimi-k2.6` 再重试

可选流式检查：

```bash
curl -N -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"stream":true}'
```

---

## 第五步：创建 EdgeSpark 项目

优先使用 fresh alias，例如：

```bash
bloome edgespark project create --alias gateway-20260510
```

如果你的环境使用 `bloome-cli` wrapper，等价命令是：

```bash
bloome-cli edgespark project create --alias gateway-20260510
```

脚手架可能生成在：

- 仓库内：`Bloome2API/edgespark/<alias>`
- 仓库同级：`edgespark/<alias>`

`scripts/deploy-edgespark.sh` 会自动识别这两种位置。其它位置请设置：

```bash
export EDGESPARK_PROJECT_DIR="/absolute/path/to/edgespark/<alias>"
```

---

## 第六步：pull smoke test

create 成功后，先用对应的 EdgeSpark secret 跑一次 `edgespark pull`。

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  PROJECT_DIR="${EDGESPARK_PROJECT_DIR:-}";
  if [ -z "$PROJECT_DIR" ]; then
    for candidate in "edgespark/<alias>" "../edgespark/<alias>"; do
      if [ -f "$candidate/edgespark.toml" ]; then PROJECT_DIR="$candidate"; break; fi;
    done;
  fi;
  cd "${PROJECT_DIR:-edgespark/<alias>}" && edgespark pull
'
```

如果 `secret call`、`edgespark` 认证或脚手架路径失败，看 `DEPLOY_NOTES.md`。

---

## 第七步：公网部署

确认变量已设置：

```bash
echo "$BLOOME_API_KEY"
echo "$CLIENT_API_KEY"
```

执行部署脚本：

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  ./scripts/deploy-edgespark.sh <alias>
'
```

脚本会自动完成：

- 同步 `src/index.ts`
- 注入 `vars`
- 注入 `installBloomeBridge(app)`
- patch `server/src/defs/runtime.ts`
- `edgespark var set`
- `edgespark pull`
- `npm install`
- `edgespark deploy`

---

## 第八步：部署后验收

### 8.1 verify

```bash
bloome edgespark project verify <alias>
```

### 8.2 health

```bash
curl https://<域名>.edgespark.app/api/public/v1/health
```

应看到：

```json
{"status":"ok","config":{"bloomeApiKey":true,"clientApiKey":true}}
```

### 8.3 models

带 key：

```bash
curl -H "Authorization: Bearer $CLIENT_API_KEY" https://<域名>.edgespark.app/api/public/v1/models
```

不带 key 应返回 401：

```bash
curl -i https://<域名>.edgespark.app/api/public/v1/models
```

### 8.4 chat smoke test

```bash
curl -X POST https://<域名>.edgespark.app/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

返回正常 JSON 且有 `choices` 即可。某些 reasoning 模型可能出现 `content` 为空、正文或解释主要在 `reasoning_content` 中；这不代表网关失败。

---

## 第九步：向用户汇报

成功时只给用户最需要复制的配置：

**Bloome2API 部署成功**

Base URL
```text
https://<域名>.edgespark.app/api/public/v1
```

API Key
```text
<CLIENT_API_KEY>
```

失败时说明具体失败环节：

- `verify` 未通过
- `health` 缺少 `BLOOME_API_KEY` 或 `CLIENT_API_KEY`
- `models` 返回异常
- `chat/completions` 调用失败

---

## 热更新

如果只是修改 `src/index.ts`、模型列表、请求转换、SSE、reasoning、工具调用或运行时变量，不需要重新 create 项目。

1. 检查 alias 状态：

```bash
bloome edgespark project verify <alias>
```

2. 跑 pull smoke test：

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  PROJECT_DIR="${EDGESPARK_PROJECT_DIR:-}";
  if [ -z "$PROJECT_DIR" ]; then
    for candidate in "edgespark/<alias>" "../edgespark/<alias>"; do
      if [ -f "$candidate/edgespark.toml" ]; then PROJECT_DIR="$candidate"; break; fi;
    done;
  fi;
  cd "${PROJECT_DIR:-edgespark/<alias>}" && edgespark pull
'
```

3. 运行部署脚本：

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  ./scripts/deploy-edgespark.sh <alias>
'
```

4. 重新做部署后验收。

---

## 排障入口

下面内容不要塞回本文件，统一维护在 `DEPLOY_NOTES.md`：

- 无 `unzip` 时安装 Bun
- Node 版本警告
- `bloome-cli` / `bloome` 差异
- `edgespark` 认证失败
- key 来源与安全红线
- alias 管理
- 模型注意事项
- 不要做的事清单
