# CodeGraph Streamable HTTP MCP — 部署与客户端接入

本仓库在 [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph) 基础上增加了
标准 **Streamable HTTP** 传输（MCP spec revision 2025-06-18）：`codegraph serve --http`。
一个 centrally 部署的 CodeGraph 服务可以带一份共享索引服务任意多的远程 MCP 客户端，
客户端机器无需本地安装、无需本地索引。

- 实现：`src/mcp/http-server.ts`（CLI 入口在 `src/bin/codegraph.ts` 的 `serve` 命令）
- 测试：`__tests__/mcp-http-transport.test.ts`（spawn 真实二进制，15 例覆盖全 wire 契约）
- 镜像：https://gitlab.xpaas.lenovo.com/wangyong27/codegraph （GitHub: interestingyong/codegraph）

---

## 1. 当前部署（mcp153）

| 项 | 值 |
|---|---|
| 服务器 | mcp153 / jump153（10.121.126.153，内网直达） |
| 端点 | `http://10.121.126.153:3916/mcp` |
| 认证 | **默认部署形态：无鉴权**（§2.4，不传 `--auth-token` 即无鉴权，适合可信内网）。mcp153 现网仍启用 Bearer（历史部署，token 存服务器 `/home/lenovo/.codegraph-http-token`，下文以 `<TOKEN>` 代称） |
| 二进制 | `/home/lenovo/codegraph-linux-x64/`（自包含包，57MB，wasm 提取路径，无需原生内核） |
| 命令 | `~/.local/bin/codegraph`（已入 PATH，版本 1.6.2） |
| 索引项目 | `/home/lenovo/xds_dev_codegraph`（xds `origin/dev` 镜像） |
| 索引更新 | `codegraph git-sync` 服务每 60s fetch+fast-forward；merge 后 serve 的 watcher 自动同步索引 |
| 服务日志 | MCP: `/home/lenovo/codegraph-http.log`；git-sync: `/tmp/log/codegraph-git-sync.log`（重启即弃，只保留增量痕迹） |

## 2. 从零部署（任意 Linux x64 目标机）

### 2.1 构建部署包（任意 OS 都能构建，产物自包含官方 Node 运行时）

```bash
git clone https://gitlab.xpaas.lenovo.com/wangyong27/codegraph.git
cd codegraph
npm ci && npm run build
bash scripts/build-bundle.sh linux-x64
# → release/codegraph-linux-x64.tar.gz (~57MB)
# 无原生内核时自动走 wasm 提取路径（日志会注明），功能不受影响
```

### 2.2 上传 + 安装

```bash
scp release/codegraph-linux-x64.tar.gz <user>@<host>:~
ssh <user>@<host>
tar -xzf codegraph-linux-x64.tar.gz        # 解到 ~/codegraph-linux-x64/
mkdir -p ~/.local/bin
ln -sfn ~/codegraph-linux-x64/bin/codegraph ~/.local/bin/codegraph
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc

# ⚠ 在 Windows 上打的 tar 会丢失可执行位，必须补：
chmod 755 ~/codegraph-linux-x64/node ~/codegraph-linux-x64/bin/codegraph

codegraph --version   # 验证
```

### 2.3 准备索引项目

```bash
# gitlab 域名若不可解析，先加 hosts 映射：
echo '10.99.205.6 gitlab.xpaas.lenovo.com' | sudo tee -a /etc/hosts

git clone -b dev --single-branch https://gitlab.xpaas.lenovo.com/xds/xds.git ~/xds_dev_codegraph
codegraph init ~/xds_dev_codegraph
# 全量索引需几分钟；init 是唯一写者，完成前不要启动 serve（写锁互斥会拒绝启动）
```

### 2.4 启动服务（默认：无鉴权）

```bash
export PATH="$HOME/.local/bin:$PATH"
nohup codegraph serve --http --host 0.0.0.0 --port 3916 --path ~/xds_dev_codegraph \
  --session-idle-sec 0 \
  >> ~/codegraph-http.log 2>&1 &
# 启动成功日志: [CodeGraph MCP] Streamable HTTP listening on http://0.0.0.0:3916/mcp
# --session-idle-sec 0 = 会话不过期。DSH 的 mcp-client 收到过期 404 后只会重发旧
# Mcp-Session-Id、不会重新 initialize，闲置 1 小时后该连接就永久卡死到重启 Host；
# 不开 0 就得自己重启 DSH 才能恢复。代价是会话对象常驻内存（每个客户端一份）。
# 也可用环境变量 CODEGRAPH_HTTP_SESSION_IDLE_SEC（不设 = 默认 3600 秒）。
```

**默认不启用鉴权**：不传 `--auth-token`、不设 `CODEGRAPH_HTTP_AUTH_TOKEN` 即无鉴权模式
（`http-server.ts` 只在配置了 token 时才开 401 门禁）。可信内网推荐——客户端零配置负担，
 curl/SDK 直接连。非回环绑定时启动日志会打一条醒目警告（仅提示，不影响运行）。

#### 可选：启用 Bearer 鉴权（跨网段 / 共享环境建议）

```bash
openssl rand -hex 16 > ~/.codegraph-http-token && chmod 600 ~/.codegraph-http-token
export PATH="$HOME/.local/bin:$PATH"
export CODEGRAPH_HTTP_AUTH_TOKEN=$(cat ~/.codegraph-http-token)
nohup codegraph serve --http --host 0.0.0.0 --port 3916 --path ~/xds_dev_codegraph \
  --session-idle-sec 0 \
  >> ~/codegraph-http.log 2>&1 &
```

启用后每个 POST/DELETE 都要求 `Authorization: Bearer <TOKEN>`，缺失/错误 → 401；
客户端配置按 §4.11 的鉴权变体加一行。mcp153 现网即此形态。

### 2.5 启动 git-sync 镜像跟随服务（每分钟自动 pull）

```bash
mkdir -p /tmp/log
nohup codegraph git-sync ~/xds_dev_codegraph --branch dev \
  --interval-sec 60 --mode hard \
  >> /tmp/log/codegraph-git-sync.log 2>&1 &
# 启动日志: [git-sync] <时间> watching <路径>: origin/dev every 60s (mode: hard)
# 每次实际更新打一行: [git-sync] <时间> dev: <旧commit> -> <新commit> (N files changed, ff) "<提交标题>"
```

`--mode hard` 的取舍：xds 的 dev 偶尔被 force-push，ff-only 模式会永远卡在分叉点；
hard 模式直接 reset 到远端 tip（镜像语义）。未跟踪文件（`.codegraph/` 索引）不受影响。

### 2.6 验证（见 §4.10 curl）

默认（无鉴权）：initialize → 200 + `Mcp-Session-Id`；tools/call explore 能查到真实结果。
启用鉴权的部署另验：无 token / 错 token → 401。

## 3. 服务端参数与行为

```
codegraph serve --http [--host H] [--port P] [--path DIR]
                    [--allowed-origins o1,o2] [--auth-token T]
                    [--session-idle-sec S]
# token 也可用环境变量: CODEGRAPH_HTTP_AUTH_TOKEN
# 会话闲置窗口也可用环境变量: CODEGRAPH_HTTP_SESSION_IDLE_SEC（秒，0 = 不过期）
# 默认: host 127.0.0.1, port 3916, 端点路径 /mcp, 会话闲置 3600 秒
```

| 行为 | 说明 |
|---|---|
| 单写者锁 | 同一项目同时只允许一个写者（direct/http 任意模式），第二个会拒绝启动 |
| 会话 | initialize 签发 `Mcp-Session-Id`；闲置超过 `--session-idle-sec` 秒（默认 3600）过期，之后该 id 返回 404 + `re-initialize`。按规范客户端应重新 initialize——DSH 的 mcp-client 不这么做，会一直重发旧 id 直到重启 Host，所以给这类客户端部署时用 `0` 关掉过期 |
| 会话扫描 | 过期由后台 sweeper 回收，扫描间隔最多 60 秒、且不超过闲置窗口的一半（窗口 <2 分钟时按 1 秒扫） |
| GET /mcp | 405（不开服务端推送流；roots/list 自动回退到 `--path` 项目） |
| 批量请求 | JSON-RPC 数组 → 400（2025-06-18 已移除批量） |
| 请求上限 | 单请求 10MB，超出 413 |
| 鉴权 | **可选**。配置 `--auth-token`（或 `CODEGRAPH_HTTP_AUTH_TOKEN`）后所有 POST/DELETE 要求 Bearer；不配置 = 无鉴权（默认部署形态，内网直达场景够用） |
| 安全 | 默认只绑回环；非回环且未配置 token 时启动打醒目警告（仅提示）；Origin 校验仅放行回环 + `--allowed-origins` |

## 4. 客户端接入样例

**以下样例均按默认部署（无鉴权）写**——只有 URL，客户端零负担。若目标服务端启用了
Bearer 鉴权（§2.4 可选模式，如 mcp153 现网），按 §4.11 差异表补 `Authorization` 头；
`<TOKEN>` = 服务器 `/home/lenovo/.codegraph-http-token` 的内容。

### 4.1 Claude Code

```bash
claude mcp add --transport http codegraph-http http://10.121.126.153:3916/mcp
```

或项目级 `.mcp.json` / 用户级 `~/.claude.json`：

```json
{
  "mcpServers": {
    "codegraph-http": {
      "type": "http",
      "url": "http://10.121.126.153:3916/mcp"
    }
  }
}
```

### 4.2 Claude Desktop

`claude_desktop_config.json`（需较新版本，支持远程 MCP）：

```json
{
  "mcpServers": {
    "codegraph-http": {
      "type": "http",
      "url": "http://10.121.126.153:3916/mcp"
    }
  }
}
```

### 4.3 Cursor

项目级 `.cursor/mcp.json` 或全局 `~/.cursor/mcp.json`（`url` 键即 Streamable HTTP）：

```json
{
  "mcpServers": {
    "codegraph-http": {
      "url": "http://10.121.126.153:3916/mcp"
    }
  }
}
```

### 4.4 Codex CLI

`~/.codex/config.toml`。注意：顶级 `experimental_use_rmcp_client = true` 缺了
streamable-http 加载不了：

```toml
experimental_use_rmcp_client = true

[mcp_servers.codegraph-http]
type = "streamable-http"
url = "http://10.121.126.153:3916/mcp"
```

### 4.5 opencode

`~/.config/opencode/opencode.json` 或项目根 `opencode.json`。键是 `mcp`（不是
`mcpServers`）；`oauth: false` 跳过 OAuth 发现流程：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codegraph-http": {
      "type": "remote",
      "url": "http://10.121.126.153:3916/mcp",
      "enabled": true,
      "oauth": false
    }
  }
}
```

### 4.6 DeepSeek Harness (DSH)

profile 的 `cordis.patch.yml`：

```yaml
- insert:
    - id: mcp-codegraph-http
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph-http
        transport: streamable-http
        url: 'http://10.121.126.153:3916/mcp'
```

### 4.7 MCP Inspector（调试/验证）

```bash
npx @modelcontextprotocol/inspector
# UI 里: Transport Type = Streamable HTTP
#        URL = http://10.121.126.153:3916/mcp → Connect
```

### 4.8 TypeScript SDK

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://10.121.126.153:3916/mcp'),
);
const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
```

### 4.9 Python SDK

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client("http://10.121.126.153:3916/mcp") as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
```

### 4.10 curl 快速验证

```bash
# 1) initialize 拿会话 id
curl -sS -D headers.txt -X POST http://10.121.126.153:3916/mcp \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
SID=$(grep -i 'mcp-session-id' headers.txt | awk '{print $2}' | tr -d '\r')

# 2) 真实查询
curl -sS -X POST http://10.121.126.153:3916/mcp \
  -H 'Content-Type: application/json' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codegraph_explore","arguments":{"query":"nfdsd main daemon startup"}}}'
```

### 4.11 启用鉴权时的客户端差异（服务端按 §2.4 可选模式配置时）

各客户端在 §4.1–4.10 的基础上补一行；`<TOKEN>` = 服务器 `/home/lenovo/.codegraph-http-token` 内容：

| 客户端 | 补充 |
|---|---|
| Claude Code CLI | 追加 `--header "Authorization: Bearer <TOKEN>"` |
| Claude Code / Desktop / Cursor JSON | 加 `"headers": { "Authorization": "Bearer <TOKEN>" }` |
| Codex CLI | `bearer_token_env_var = "CODEGRAPH_HTTP_TOKEN"`（启动 shell 先 `export CODEGRAPH_HTTP_TOKEN=<TOKEN>`；老 `[mcp_servers.X.headers]` 写法 0.130+ 被静默忽略，别用）或写死 `http_headers = { "Authorization" = "Bearer <TOKEN>" }` |
| opencode | `oauth: false` 保持，再加 `"headers": { "Authorization": "Bearer <TOKEN>" }` |
| DSH | config 下加 `headers: { Authorization: 'Bearer <TOKEN>' }` |
| Inspector | Headers 栏加 `Authorization: Bearer <TOKEN>` |
| TS SDK | 第二参 `{ requestInit: { headers: { Authorization: 'Bearer <TOKEN>' } } }` |
| Python SDK | `streamablehttp_client(url, headers={"Authorization": "Bearer <TOKEN>"})` |
| curl | 每条请求加 `-H 'Authorization: Bearer <TOKEN>'` |

对客户端透明、排障时有用：initialize 返回协议版本 `2024-11-05`（与传输版本独立，
SDK 自动协商）；SDK 客户端均容忍 GET 405 与会话过期 404（自动重连）。

## 5. 运维

```bash
# 索引随代码自动更新: git-sync 每分钟 fetch+merge, serve 的 watcher 自动重索引, 无需人工。

# 手动立即同步一次（等不了下一分钟时）:
codegraph git-sync ~/xds_dev_codegraph --branch dev --mode hard --once

# git-sync 日志（只记变更, 无变更不打; /tmp/log 重启即弃）:
tail -f /tmp/log/codegraph-git-sync.log

# 服务重启（如机器重启后）——默认无鉴权:
export PATH="$HOME/.local/bin:$PATH"
nohup codegraph serve --http --host 0.0.0.0 --port 3916 --path ~/xds_dev_codegraph \
  >> ~/codegraph-http.log 2>&1 &
# 启用了鉴权的部署（如 mcp153）额外: export CODEGRAPH_HTTP_AUTH_TOKEN=$(cat ~/.codegraph-http-token)
mkdir -p /tmp/log
nohup codegraph git-sync ~/xds_dev_codegraph --branch dev \
  --interval-sec 60 --mode hard \
  >> /tmp/log/codegraph-git-sync.log 2>&1 &

# 状态:
ss -tlnp | grep 3916
ps aux | grep -E 'serve --http|git-sync' | grep -v grep

# 升级二进制: 重新构建上传（§2.1-2.2），停旧进程再启动（§2.4-2.5）。索引数据无需重建，
# 与二进制版本兼容。
```

### git-sync 参数

```
codegraph git-sync [path] [--branch <b>] [--remote <r>] [--interval-sec <n>]
                   [--mode ff-only|hard] [--once]
```

| 参数 | 说明 |
|---|---|
| `--branch` | 跟踪的远端分支（默认当前检出分支；detached HEAD 必须显式指定） |
| `--remote` | fetch 的远端（默认 origin） |
| `--interval-sec` | 探测间隔秒数（默认 60） |
| `--mode` | 分叉处理：`ff-only`（跳过并告警，默认）/ `hard`（reset 到远端 tip，适合被 force-push 的镜像） |
| `--once` | 单次同步即退出（cron 场景） |

行为要点：fetch 失败只记错误日志、下一分钟重试（不退出）；配置错误（非 git 仓库/远端不存在/分支不存在）启动即退出；merge 只动跟踪文件，`.codegraph/` 等未跟踪文件永不受影响；git 永不弹凭证提示（`GIT_TERMINAL_PROMPT=0`），无人值守安全。
