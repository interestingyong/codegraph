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
| 认证 | Bearer token（必须）。存于服务器 `/home/lenovo/.codegraph-http-token`，下文以 `<TOKEN>` 代称 |
| 二进制 | `/home/lenovo/codegraph-linux-x64/`（自包含包，57MB，wasm 提取路径，无需原生内核） |
| 命令 | `~/.local/bin/codegraph`（已入 PATH，版本 1.6.2） |
| 索引项目 | `/home/lenovo/xds_dev_codegraph`（xds `origin/dev` 镜像；`git pull` 后 watcher 自动同步索引） |
| 日志 | `/home/lenovo/codegraph-http.log` |

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

### 2.4 生成 token + 启动服务

```bash
openssl rand -hex 16 > ~/.codegraph-http-token && chmod 600 ~/.codegraph-http-token
export PATH="$HOME/.local/bin:$PATH"
export CODEGRAPH_HTTP_AUTH_TOKEN=$(cat ~/.codegraph-http-token)
nohup codegraph serve --http --host 0.0.0.0 --port 3916 --path ~/xds_dev_codegraph \
  >> ~/codegraph-http.log 2>&1 &
# 启动成功日志: [CodeGraph MCP] Streamable HTTP listening on http://0.0.0.0:3916/mcp
```

### 2.5 验证（见 §4.10 curl）

无 token → 401；initialize → 200 + `Mcp-Session-Id`；tools/call explore 能查到真实结果。

## 3. 服务端参数与行为

```
codegraph serve --http [--host H] [--port P] [--path DIR]
                    [--allowed-origins o1,o2] [--auth-token T]
# token 也可用环境变量: CODEGRAPH_HTTP_AUTH_TOKEN
# 默认: host 127.0.0.1, port 3916, 端点路径 /mcp
```

| 行为 | 说明 |
|---|---|
| 单写者锁 | 同一项目同时只允许一个写者（direct/http 任意模式），第二个会拒绝启动 |
| 会话 | initialize 签发 `Mcp-Session-Id`；闲置 1 小时过期，过期后 404，客户端自动重新 initialize |
| GET /mcp | 405（不开服务端推送流；roots/list 自动回退到 `--path` 项目） |
| 批量请求 | JSON-RPC 数组 → 400（2025-06-18 已移除批量） |
| 请求上限 | 单请求 10MB，超出 413 |
| 安全 | 默认只绑回环；对外绑定务必带 token；Origin 校验仅放行回环 + `--allowed-origins`；非回环且无 token 启动时打醒目警告 |

## 4. 客户端接入样例

以下 `<TOKEN>` = 服务器 `/home/lenovo/.codegraph-http-token` 的内容。

### 4.1 Claude Code

```bash
claude mcp add --transport http codegraph-http http://10.121.126.153:3916/mcp \
  --header "Authorization: Bearer <TOKEN>"
```

或项目级 `.mcp.json` / 用户级 `~/.claude.json`：

```json
{
  "mcpServers": {
    "codegraph-http": {
      "type": "http",
      "url": "http://10.121.126.153:3916/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
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
      "url": "http://10.121.126.153:3916/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
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
      "url": "http://10.121.126.153:3916/mcp",
      "headers": { "Authorization": "Bearer <TOKEN>" }
    }
  }
}
```

### 4.4 Codex CLI

`~/.codex/config.toml`。注意：顶级 `experimental_use_rmcp_client = true` 缺了
streamable-http 加载不了；老写法 `[mcp_servers.X.headers]` 在 Codex 0.130+ 会被
静默忽略，用 `bearer_token_env_var`（推荐）或 `http_headers`：

```toml
experimental_use_rmcp_client = true

[mcp_servers.codegraph-http]
type = "streamable-http"
url = "http://10.121.126.153:3916/mcp"
bearer_token_env_var = "CODEGRAPH_HTTP_TOKEN"
```

启动 Codex 的 shell 先 `export CODEGRAPH_HTTP_TOKEN=<TOKEN>`。
（也可写死 `http_headers = { "Authorization" = "Bearer <TOKEN>" }`）

### 4.5 opencode

`~/.config/opencode/opencode.json` 或项目根 `opencode.json`。键是 `mcp`（不是
`mcpServers`）；用 token 时把 `oauth` 关掉，否则会先走 OAuth 发现流程：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "codegraph-http": {
      "type": "remote",
      "url": "http://10.121.126.153:3916/mcp",
      "enabled": true,
      "oauth": false,
      "headers": { "Authorization": "Bearer <TOKEN>" }
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
        headers:
          Authorization: 'Bearer <TOKEN>'
```

### 4.7 MCP Inspector（调试/验证）

```bash
npx @modelcontextprotocol/inspector
# UI 里: Transport Type = Streamable HTTP
#        URL = http://10.121.126.153:3916/mcp
#        Headers 添加 Authorization: Bearer <TOKEN> → Connect
```

### 4.8 TypeScript SDK

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const transport = new StreamableHTTPClientTransport(
  new URL('http://10.121.126.153:3916/mcp'),
  { requestInit: { headers: { Authorization: 'Bearer <TOKEN>' } } },
);
const client = new Client({ name: 'my-client', version: '1.0.0' });
await client.connect(transport);
const { tools } = await client.listTools();
```

### 4.9 Python SDK

```python
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

async with streamablehttp_client(
    "http://10.121.126.153:3916/mcp",
    headers={"Authorization": "Bearer <TOKEN>"},
) as (read, write, _):
    async with ClientSession(read, write) as session:
        await session.initialize()
        tools = await session.list_tools()
```

### 4.10 curl 快速验证

```bash
# 1) initialize 拿会话 id
curl -sS -D headers.txt -X POST http://10.121.126.153:3916/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
SID=$(grep -i 'mcp-session-id' headers.txt | awk '{print $2}' | tr -d '\r')

# 2) 真实查询
curl -sS -X POST http://10.121.126.153:3916/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <TOKEN>' \
  -H "Mcp-Session-Id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"codegraph_explore","arguments":{"query":"nfdsd main daemon startup"}}}'
```

对客户端透明、排障时有用：initialize 返回协议版本 `2024-11-05`（与传输版本独立，
SDK 自动协商）；SDK 客户端均容忍 GET 405 与会话过期 404（自动重连）。

## 5. 运维

```bash
# 更新索引（服务不用重启，watcher 自动同步）:
cd ~/xds_dev_codegraph && git pull origin dev

# 服务重启（如机器重启后）:
export PATH="$HOME/.local/bin:$PATH" CODEGRAPH_HTTP_AUTH_TOKEN=$(cat ~/.codegraph-http-token)
nohup codegraph serve --http --host 0.0.0.0 --port 3916 --path ~/xds_dev_codegraph \
  >> ~/codegraph-http.log 2>&1 &

# 状态/日志:
ss -tlnp | grep 3916
tail -f ~/codegraph-http.log

# 升级二进制: 重新构建上传（§2.1-2.2），停旧进程再启动（§2.4）。索引数据无需重建，
# 与二进制版本兼容。
```
