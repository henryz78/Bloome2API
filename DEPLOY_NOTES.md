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

### `bloome-cli` 不存在

Agent 环境可能只有 `bloome`：

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '...'
bloome edgespark project create --alias <alias>
```

有 `bloome-cli` wrapper 时用 `bloome-cli ...` 等价。

### `edgespark` 报 `Not authenticated`

`secret call` 注入的是 `EDGESPARK_API_KEY__ALIAS__SUFFIX`，但 `edgespark` 读取 `EDGESPARK_API_KEY`。

```bash
bloome secret call EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  cd edgespark/gateway-20260510 && edgespark pull
'
```

不要依赖交互式 `edgespark login`。

---

## 3. 密钥安全红线

- 不要把任何 API key 写进仓库文件、源码、脚本或 `edgespark.toml`
- 不要截断读取 `BLOOME_API_KEY`
- 不要裸跑 `npx edgespark var set`，用 `bloome secret call`

key 来源：

```bash
echo $RESON_LLM_API_KEY
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
export CLIENT_API_KEY="<用户给的客户端密码>"
```

---

## 4. 常见报错

### `Model alias not found`

用户先在 Bloome 里切到对应模型一次。模型名必须精确：

- `claude-opus-4-7` 不是 `claude-opus-4.7`
- `gpt-5.4` 不是 `gpt-5-4`

### `verify 404` / `invalid bearer token` / `unhealthy`

不要在旧 alias 上反复 deploy，直接换 fresh alias。

### `health` 里 key 为 `false`

检查 EdgeSpark vars：

- `BLOOME_API_KEY`
- `CLIENT_API_KEY`

然后重新跑部署脚本。

### `content` 为空但有 `reasoning_content`

可能是 reasoning 模型的正常行为。只要状态码正常、结构有 `choices`，不是鉴权或上游错误，就可以通过 smoke test。

---

## 5. Scaffold 位置

`scripts/deploy-edgespark.sh` 自动识别：

- 仓库内：`Bloome2API/edgespark/<alias>`
- 仓库同级：`edgespark/<alias>`

其它位置手动设置：

```bash
export EDGESPARK_PROJECT_DIR="/absolute/path/to/edgespark/<alias>"
```

---

## 6. 热更新

只改源码、模型、请求转换、SSE、reasoning、工具调用或运行时变量时，不需要重新 create。

```bash
bloome edgespark project verify <alias>
```

如果出现 `verify 404` / `invalid bearer token` / `unhealthy`，换 fresh alias。

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

```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  ./scripts/deploy-edgespark.sh <alias>
'
```

最后重新执行 `DEPLOY.md` 的公网验收。
