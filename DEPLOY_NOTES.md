# DEPLOY_NOTES.md — 部署备忘与排障

> 正常部署只看 `DEPLOY.md`。这里用于出问题时排障，以及维护时热更新。

---

## 1. 环境陷阱

### 无 `unzip` 安装 Bun

```bash
curl -fsSL https://bun.sh/install | bash
# error: unzip is required to install bun
```

Linux x64 fallback：

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

mkdir -p "$HOME/.local/bin"
cp /tmp/bun-unzip/bun-linux-x64/bun "$HOME/.local/bin/bun"
chmod +x "$HOME/.local/bin/bun"
export PATH="$HOME/.local/bin:$PATH"
bun --version
```

arm64 或其它架构要换对应 zip 包名。

### Node 版本警告

`@edgespark/cli` 可能提示 `EBADENGINE required node >=22`。如果 `edgespark pull` / `edgespark deploy` 能继续运行，这只是警告。

---

## 2. 认证陷阱

### 云端 CLI 不存在

Agent 环境可能只有一个云端 CLI 命令：

```bash
<cloud-cli> secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '...'
<cloud-cli> edgespark project create --alias <alias>
```

有备用 wrapper 时用等价命令。

### `edgespark` 报 `Not authenticated`

`secret call` 注入的是 `EDGESPARK_API_KEY__ALIAS__SUFFIX`，但 `edgespark` 读取 `EDGESPARK_API_KEY`。

```bash
<cloud-cli> secret call EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  cd edgespark/gateway-20260510 && edgespark pull
'
```

不要依赖交互式 `edgespark login`。

---

## 3. 密钥安全红线

- 不要把任何 API key 写进仓库文件、源码、脚本或 `edgespark.toml`
- 不要截断读取 `PROVIDER_API_KEY`
- 不要裸跑 `npx edgespark var set`，用云端 secret call
- CLIENT_API_KEY 必须问用户要，不要替用户随机生成

key 来源：

```bash
echo $RESON_LLM_API_KEY
export PROVIDER_API_KEY="$RESON_LLM_API_KEY"
export CLIENT_API_KEY="<用户给的客户端密码>"
```

---

## 4. 错误日志模式

默认模式不向客户端暴露详细上游错误，只返回统一错误标志和 `request_id`，详细内容看平台日志。

需要排查时可以临时开启开发模式：

```bash
export APP_DEV_MODE=true
./scripts/deploy-edgespark.sh <alias>
```

开发模式会让 API 响应携带 `error.detail`。排查结束后建议取消该变量并重新部署。

---

## 5. 常见报错

### `Model alias not found`

先确认 provider 侧已启用对应模型。模型名必须精确：

- `claude-opus-4-7` 不是 `claude-opus-4.7`
- `gpt-5.4` 不是 `gpt-5-4`

### `verify 404` / `invalid bearer token` / `unhealthy`

不要在旧 alias 上反复 deploy，直接换 fresh alias。

### `health` 里 key 为 `false`

检查 EdgeSpark vars：

- `PROVIDER_API_KEY`
- `CLIENT_API_KEY`

然后重新跑部署脚本。

### `content` 为空但有 `reasoning_content`

可能是 reasoning 模型的正常行为。只要状态码正常、结构有 `choices`，不是鉴权或上游错误，就可以通过 smoke test。

---

## 6. Scaffold 位置

`scripts/deploy-edgespark.sh` 自动识别：

- 仓库内：`<repo>/edgespark/<alias>`
- 仓库同级：`edgespark/<alias>`

其它位置手动设置：

```bash
export EDGESPARK_PROJECT_DIR="/absolute/path/to/edgespark/<alias>"
```

---

## 7. 热更新

只改源码、模型、请求转换、SSE、reasoning、工具调用或运行时变量时，不需要重新 create。

```bash
<cloud-cli> edgespark project verify <alias>
```

如果出现 `verify 404` / `invalid bearer token` / `unhealthy`，换 fresh alias。

```bash
<cloud-cli> secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  HOT_DEPLOY_ONLY=1 ./scripts/deploy-edgespark.sh <alias>
'
```

`HOT_DEPLOY_ONLY=1` 会跳过 `edgespark var set`、`edgespark pull` 和 `npm install`，只同步 `src/index.ts` 到已有 scaffold 并执行 `edgespark deploy`。

如果改了环境变量、EdgeSpark 生成类型、依赖或 scaffold 结构，使用完整部署模式，不要加 `HOT_DEPLOY_ONLY=1`。

最后重新执行 `DEPLOY.md` 的公网验收。

### 本地 Agent 快捷部署

可以用 `scripts/deploy-local.sh` 封装云端 secret call。这个脚本不会生成或硬编码 `CLIENT_API_KEY`，必须由用户明确提供。
脚本会优先使用主 CLI，找不到时 fallback 到备用 CLI。

```bash
export EDGESPARK_SECRET_NAME="EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>"
export RESON_LLM_API_KEY="$RESON_LLM_API_KEY"
export CLIENT_API_KEY="<用户给的客户端密码>"

./scripts/deploy-local.sh <alias>
```

热更新：

```bash
HOT_DEPLOY_ONLY=1 ./scripts/deploy-local.sh <alias>
```

如果已知公网地址，可以让脚本在部署后自动跑 `/health` 和一个短 `chat/completions`：

```bash
BASE_URL="https://<域名>.edgespark.app/api/public/v1" ./scripts/deploy-local.sh <alias>
```

---

## 8. CORS

公开 API 已显式返回：

- `Access-Control-Allow-Origin: *`
- `Access-Control-Allow-Headers: Authorization, Content-Type, x-api-key, anthropic-version, anthropic-beta, x-client-request-id`
- `Access-Control-Allow-Methods: GET, POST, OPTIONS`
- `Access-Control-Expose-Headers: x-request-id, request-id`

浏览器端直连时不需要额外配置 CORS。若后续要限制来源域名，再改 `src/index.ts` 的 CORS header。
