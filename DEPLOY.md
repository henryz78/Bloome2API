# DEPLOY.md — Agent 操作手册

> 你是 AI Agent。按顺序执行。**不要跳步、不要猜测、不要自己发明流程。**
>
> 命令说明：如果你的环境里有 `bloome-cli` 包装，就按文中的 shell 命令执行；如果没有 `bloome-cli`，但有 `bloome` 工具，则执行对应的等价 `bloome` 操作，不要因为缺少 wrapper 就改流程。

---

## 一句话原则

这个仓库当前已经内置了完整模型列表。

部署时你**不需要把所有模型重新测一遍**，只需要完成：

1. 安装 / 确认 Bun，并完成本地最小 smoke test
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

- `GET /api/public/v1/models`：返回模型列表
- `POST /api/public/v1/chat/completions`：OpenAI 兼容聊天接口
- Claude / MiniMax 自动转 Anthropic `/v1/messages`
- Gemini 自动转 Google `generateContent` / `streamGenerateContent`
- GPT-5.x / `o*` 自动把 `max_tokens` 改写为 `max_completion_tokens`
- 清洗上游响应中的非标准字段与脏 SSE chunk

先看懂，不要急着改代码。

---

## 第二步：准备本地环境

这个项目本地运行依赖 Bun。即使最终是部署到 EdgeSpark 公网，部署前也必须先跑本地最小 smoke test，确认网关逻辑和上游 key 可用；否则公网部署成功后才发现接口不能用，会浪费一次部署排障。

检查 Bun：

```bash
bun --version
```

如果没有 Bun，先安装：

```bash
curl -fsSL https://bun.sh/install | bash
```

如果环境受限，遇到这些问题：

- 没有 `unzip`
- 没有 root 权限，不能 `apt-get install unzip`
- 标准安装脚本不可用

可以手动下载 Bun 的预编译 zip，然后用 Python 解压。示例：

```bash
curl -L -o /tmp/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.3.13/bun-linux-x64.zip
python3 - <<'PY'
import zipfile
from pathlib import Path
zip_path = Path("/tmp/bun.zip")
out_dir = Path("/tmp/bun-unzip")
out_dir.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(zip_path) as z:
    z.extractall(out_dir)
print(out_dir)
PY
```

然后把解压出来的 `bun` 放到当前环境 PATH 中。如果有权限，可以放到 `/usr/local/bin/`；如果没有权限，就放到可写目录并临时导出 PATH：

```bash
mkdir -p "$HOME/.local/bin"
cp /tmp/bun-unzip/bun-linux-x64/bun "$HOME/.local/bin/bun"
chmod +x "$HOME/.local/bin/bun"
export PATH="$HOME/.local/bin:$PATH"
bun --version
```

安装依赖：

```bash
cd 项目根目录
bun install
```

如果安装 `@edgespark/cli` 时看到 Node 版本警告，例如：

```text
EBADENGINE: required { node: ">=22.0.0" }, current { node: "v20.20.2" }
```

先判断 CLI 是否能继续执行。只要 `edgespark pull` / `edgespark deploy` 能正常运行，这个警告本身不阻塞部署；不要把它当成业务代码错误。

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

不要跳过本节。公网部署前必须先确认本地代理能启动、能列模型、能完成一个最小 chat 请求。

设置好变量后，本地启动：

```bash
export CLIENT_API_KEY="用户给的密码"
bun start
```

默认监听：

- `http://localhost:3000`

### 4.1 模型列表

```bash
curl -H "Authorization: Bearer 用户给的密码" http://localhost:3000/api/public/v1/models
```

应该返回 JSON，且有 `data` 数组。

### 4.2 单模型聊天 smoke test

默认只测一个稳定模型即可，优先：

- `kimi-k2.6`

```bash
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Authorization: Bearer 用户给的密码" \
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
  -H "Authorization: Bearer 用户给的密码" \
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

脚手架位置说明：

- 有些环境会生成到仓库内：`Bloome2API/edgespark/gateway-20260509`
- 有些环境会生成到工作区根目录：`edgespark/gateway-20260509`
- `scripts/deploy-edgespark.sh` 会自动识别这两种位置
- 如果生成到了其它位置，执行脚本前设置：

```bash
export EDGESPARK_PROJECT_DIR="/absolute/path/to/edgespark/gateway-20260509"
```

重要规则：

- 真正从零部署时，优先 fresh alias，不要默认复用旧 alias
- 旧 alias 只要出现 `verify 404` / `invalid bearer token` / `unhealthy`，直接废弃

---

## 第八步：先做 pull smoke test

create 成功后，先用对应的 EdgeSpark secret 跑一次 `edgespark pull`。

不要直接运行裸 `npx edgespark ...` 或裸 `edgespark ...`。如果没有登录态，CLI 会返回 `Not authenticated`。在 Agent 环境里固定用 `bloome-cli secret call ... -- bash -c '...'` 注入 `EDGESPARK_API_KEY`。

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

然后在 secret call 里执行脚本：

```bash
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY_20260509__XXXX -- bash -c 'export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY_20260509__XXXX"; export BLOOME_API_KEY="你的真实 BLOOME_API_KEY"; export CLIENT_API_KEY="用户给的密码"; export EDGESPARK_PROJECT_ENVIRONMENT=production; ./scripts/deploy-edgespark.sh gateway-20260509'
```

这个脚本会自动完成：

- 自动识别 `edgespark/<alias>` 在仓库内还是仓库同级目录
- 同步 `src/index.ts`
- 注入 `vars`
- 注入 `installBloomeBridge(app)`
- patch `server/src/defs/runtime.ts`
- `edgespark var set`
- `edgespark pull`
- `npm install`
- `edgespark deploy`

**不要把手工复制 / patch 流程当主路径。**
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

返回正常 JSON 且有 `choices` 即可。某些 reasoning 模型可能出现 `content` 为空、正文或解释主要在 `reasoning_content` 中；这不代表网关失败。只要状态码正常、结构有 `choices`，并且不是鉴权或上游错误即可通过 smoke test。

---

## 第十一步：向用户汇报最终可用配置

### 成功时

```
🎉 Bloome2API 部署成功

Base URL
https://xxx.edgespark.app/api/public/v1

API Key
你的CLIENT_API_KEY
```

### 失败时

说明具体失败环节，例如：

- `verify` 未通过
- `health` 缺少 `BLOOME_API_KEY` 或 `CLIENT_API_KEY`
- `models` 返回异常
- `chat/completions` 调用失败

并给出下一步建议（重试、换 alias、检查上游 Key 等）。

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
bloome-cli secret call EDGESPARK_API_KEY__GATEWAY__XXXX -- bash -c 'export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY__XXXX"; export BLOOME_API_KEY="你的真实 BLOOME_API_KEY"; export CLIENT_API_KEY="用户给的密码"; export EDGESPARK_PROJECT_ENVIRONMENT=production; ./scripts/deploy-edgespark.sh gateway'
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
5. **Claude / MiniMax 只能走 `/v1/messages`**，不要拿 `/v1/chat/completions` 直接调这些 Anthropic 兼容模型。
6. **每次 deploy 后都要把最新地址重新发给用户**。
7. **EdgeSpark 部署必须先 smoke test，再 deploy**。
8. **不要把密钥写进仓库文件或 `edgespark.toml`**。
9. **EdgeSpark CLI 认证优先走 `bloome-cli secret call`**，不要依赖交互式 `edgespark login`。

---

## 不要做的事

- ❌ 把 API key 写死在代码里
- ❌ 猜模型名然后直接加到列表里
- ❌ 跳过 pull smoke test
- ❌ 跳过 deploy 后的 `health` / `models` / chat 验收
- ❌ 旧 alias 已经脏了还继续反复 deploy
- ❌ 在 `secret call` 里假设 `$RESON_LLM_API_KEY` 会自动有值
- ❌ 直接裸跑 `npx edgespark var set`，遇到 `Not authenticated` 后再临时补流程
- ❌ 用截断方式去取 `BLOOME_API_KEY`
- ❌ 为了域名后缀差异手动乱改 `EDGESPARK_BASE_URL`
