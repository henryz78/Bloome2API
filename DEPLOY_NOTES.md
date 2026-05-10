# DEPLOY_NOTES.md — 部署备忘与排障手册

> 本文件汇总 Bloome2API 从零部署中遇到的所有环境陷阱、认证坑点和安全禁忌。
> 核心部署流程见 `DEPLOY.md`。
> 对应部署: `gateway-20260510` (2026-05-10)

---

## 一、环境准备陷阱

### 1.1 无 `unzip` 时安装 Bun

**现象：**
```bash
curl -fsSL https://bun.sh/install | bash
# error: unzip is required to install bun
```

**解决：** 手动下载预编译 zip，用 Python 解压：

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

> 如果是 arm64 或其它架构，把 zip 包名换成对应平台版本。

### 1.2 Node 版本警告（非阻塞）

**现象：**
```text
npm warn EBADENGINE Unsupported engine {
  package: '@edgespark/cli@0.0.17',
  required: { node: '>=22.0.0' },
  current: { node: 'v20.20.2', npm: '10.8.2' }
}
```

**结论：** 纯警告，不影响 `edgespark pull` / `edgespark deploy` 执行，无需处理。

---

## 二、认证陷阱

### 2.1 `bloome-cli` 命令不存在

**现象：** Shell 中执行 `bloome-cli secret call ...` 报 `not found`。

**原因：** Agent 环境没有 `bloome-cli` wrapper，只有内置 `bloome` 工具。

**解决：** 所有 `secret call`、`edgespark project` 操作都通过内置 `bloome` 工具执行：
```bash
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '...'
bloome edgespark project create --alias <alias>
```

### 2.2 `edgespark` 报 `Not authenticated`

**现象：**
```text
✖ Not authenticated
Run: edgespark login
```

**原因：** `secret call` 注入的环境变量名是 `EDGESPARK_API_KEY__ALIAS__SUFFIX`，但 `edgespark` CLI 默认读取的是 `EDGESPARK_API_KEY`。名字不匹配导致认证失败。

**解决：** 在 `secret call` 的 shell 命令中手动 export 映射：

```bash
bloome secret call EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__GATEWAY_20260510__123CABFF";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  cd edgespark/gateway-20260510 && edgespark pull
'
```

> 不要依赖交互式 `edgespark login`，Agent 环境不支持。

---

## 三、密钥来源

### 3.1 `BLOOME_API_KEY`

优先从 Agent 环境读取，**不要先问用户**：
```bash
echo $RESON_LLM_API_KEY
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
```

### 3.2 `CLIENT_API_KEY`

用户自定义的客户端调用密码，**必须向用户确认**。

### 3.3 安全红线

- **不要把任何 key 写进仓库文件**（包括 `edgespark.toml`、源码、脚本）
- **不要硬编码在代码里**
- **不要在 `secret call` 里假设 `$RESON_LLM_API_KEY` 会自动有值** —— 先 `echo` 确认
- **不要用截断方式去取 `BLOOME_API_KEY`**
- **不要为了域名后缀差异手动乱改 `EDGESPARK_BASE_URL`**

---

## 四、模型相关注意事项

1. **模型 alias 需要先激活**：用户必须先在 Bloome 里切到某个模型一次，代理才认得这个 alias。
2. **alias 写法必须精确**：`claude-opus-4-7` ≠ `claude-opus-4.7`；`gpt-5.4` ≠ `gpt-5-4`。
3. **不要猜模型名然后直接加到列表里** —— 新增模型看 `docs/MODELS.md`。
4. **Claude / MiniMax 只能走 `/v1/messages`**，不要拿 `/v1/chat/completions` 直接调这些 Anthropic 兼容模型。
5. **Claude / MiniMax / Gemini 支持新版 `tools` / `tool_calls`**；不要使用旧版 `functions` / `function_call`。
6. **不要把 `reasoning_content` 映射到 `content`**。
7. **不要动 SSE 清洗逻辑**：`cleanSSEDataLine` 里对空 `choices` 的过滤不能删。

---

## 五、部署纪律

### 5.1 流程顺序（不可跳过）

1. 本地 smoke test ✅ → 2. EdgeSpark create → 3. pull smoke test ✅ → 4. deploy → 5. 验收 ✅

- **必须先本地 smoke test，再 deploy**
- **必须先 pull smoke test，再 deploy**
- **deploy 后必须验收 health / models / chat**

### 5.2 Alias 管理

- **从零部署优先 fresh alias**，不要默认复用旧 alias
- **旧 alias 只要出现 `verify 404` / `invalid bearer token` / `unhealthy`，直接废弃**，不要反复 deploy 硬修
- **每次 deploy 后都要把最新公网 URL 重新发给用户**

### 5.3 脚本位置

`scripts/deploy-edgespark.sh` 会自动识别 `edgespark/<alias>` 的两种位置：
- 仓库内：`Bloome2API/edgespark/<alias>`
- 仓库同级：`edgespark/<alias>`（`bloome edgespark project create` 默认生成到 workspace 根目录）

如果都不匹配，执行前设置：
```bash
export EDGESPARK_PROJECT_DIR="/absolute/path/to/edgespark/<alias>"
```

---

## 六、不要做的事（安全禁忌清单）

| ❌ 禁止 | 正确做法 |
|--------|---------|
| 把 API key 写死在代码里 | 通过 `vars` / 环境变量注入 |
| 猜模型名直接加到列表 | 看 `docs/MODELS.md` 走正规流程 |
| 跳过 pull smoke test | pull 通过后再 deploy |
| 跳过 deploy 后的验收 | 固定检查 health/models/chat |
| 旧 alias 脏了还反复 deploy | 直接换 fresh alias |
| 假设 `$RESON_LLM_API_KEY` 自动有值 | 先 `echo` 确认再使用 |
| 裸跑 `npx edgespark var set` | 用 `bloome secret call` 注入认证 |
| 截断方式取 `BLOOME_API_KEY` | 完整读取，不要截断 |
| 手动乱改 `EDGESPARK_BASE_URL` | 使用默认域名 |

---

## 七、快速命令速查

### 7.1 本地启动与验证

```bash
export PATH="$HOME/.local/bin:$PATH"
export BLOOME_API_KEY="$RESON_LLM_API_KEY"
export CLIENT_API_KEY="<用户密码>"

cd Bloome2API
bun install
bun start

# 验证（另开终端）
curl -H "Authorization: Bearer $CLIENT_API_KEY" http://localhost:3000/api/public/v1/models
curl -X POST http://localhost:3000/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```

### 7.2 EdgeSpark 部署（完整）

```bash
# 创建项目
bloome edgespark project create --alias gateway-$(date +%Y%m%d)

# pull smoke test（注意 export EDGESPARK_API_KEY 映射！）
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  cd edgespark/<alias> && edgespark pull
'

# 一键部署
bloome secret call EDGESPARK_API_KEY__<ALIAS>__<SUFFIX> -- bash -c '
  export EDGESPARK_API_KEY="$EDGESPARK_API_KEY__<ALIAS>__<SUFFIX>";
  export EDGESPARK_PROJECT_ENVIRONMENT=production;
  export BLOOME_API_KEY="'$BLOOME_API_KEY'";
  export CLIENT_API_KEY="'$CLIENT_API_KEY'";
  ./scripts/deploy-edgespark.sh <alias>
'
```

### 7.3 部署后验收

```bash
# verify
bloome edgespark project verify <alias>

# health
curl https://<域名>.edgespark.app/api/public/v1/health

# models（带 key）
curl -H "Authorization: Bearer $CLIENT_API_KEY" https://<域名>.edgespark.app/api/public/v1/models

# models（不带 key → 401）
curl -i https://<域名>.edgespark.app/api/public/v1/models

# chat smoke test
curl -X POST https://<域名>.edgespark.app/api/public/v1/chat/completions \
  -H "Authorization: Bearer $CLIENT_API_KEY" -H "Content-Type: application/json" \
  -d '{"model":"kimi-k2.6","messages":[{"role":"user","content":"Say hi"}],"max_tokens":20}'
```
