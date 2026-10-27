# CloudClip

一个用于个人设备之间传递文本、图片和文件的轻量云剪贴板。使用 Node.js、Express 和 WebSocket，数据保存在本地文件中，无需数据库，也无需构建前端。

## 功能

- 输入后约 2 秒自动保存文本，也可手动同步和复制。
- 多设备通过 WebSocket 实时接收更新，断线后自动重连。
- 保留一张最新图片和一个最新文件；上传会覆盖对应的旧内容。
- 使用项目自带密码框登录，不需要用户名。
- 密码由后端验证；文本接口、图片、文件下载和 WebSocket 均需要有效会话。
- 支持退出登录，会话最长有效 12 小时。重启服务或更改密码并重启后，所有设备需要重新登录。

## 环境要求

- Node.js 22 或更高版本，推荐 Node.js 24 LTS。
- npm。
- 公网部署时建议使用 Nginx 反向代理和 HTTPS。

## 本地运行

在项目目录安装依赖：

```bash
npm ci
```

复制 `.env.example` 为 `.env`：

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# Linux / macOS
cp .env.example .env
```

编辑 `.env`，填写自己的 `ACCESS_PASSWORD`。有空格或 `#` 的密码请用双引号包住。没有默认密码，留空时服务会拒绝启动。

```dotenv
ACCESS_PASSWORD="在这里填写你自己的密码"
HOST=127.0.0.1
PORT=3000
COOKIE_SECURE=false
```

启动：

```bash
npm start
```

访问 <http://127.0.0.1:3000>，输入刚才设置的密码。旧版本前端内置密码已移除，浏览器中旧的明文密码记录也会自动清理。

## 配置项

程序会自动加载项目根目录的 `.env`；系统环境变量优先，无需额外安装 dotenv。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACCESS_PASSWORD` | 无，必填 | 后端校验的访问密码，不会发送给前端 |
| `HOST` | `127.0.0.1` | 监听地址；通过 Nginx 对外访问时保持默认 |
| `PORT` | `3000` | 应用端口；如被占用可改为 `3001`，同时修改 Nginx 的转发端口 |
| `COOKIE_SECURE` | `false` | 设为 `true` 时 Cookie 只通过 HTTPS 发送；HTTP + IP 访问保持 `false` |
| `DATA_DIR` | 项目根目录 | 可选的数据根目录，相对路径以项目根目录为基准；服务账号需要写权限 |

通过本机 Nginx 转发且正确设置 `X-Forwarded-Proto` 时，HTTPS 登录也会自动使用 Secure Cookie。应用只信任来自本机回环地址的代理。

## Ubuntu / Debian 部署

以下假设项目已经位于 `/opt/cloudclip`，Node.js 和 npm 已安装。先用 `node -v` 确认版本满足要求。

### 1. 安装依赖和设置密码

```bash
sudo apt update
sudo apt install -y nginx

# 如果已经创建过 cloudclip 用户，跳过这一行。
sudo useradd --system --user-group --home-dir /opt/cloudclip --shell /usr/sbin/nologin cloudclip

cd /opt/cloudclip
# 已有 .env 时不要覆盖，直接编辑原文件。
sudo cp -n .env.example .env
sudo nano .env
sudo chown -R cloudclip:cloudclip /opt/cloudclip
sudo chmod 600 /opt/cloudclip/.env
sudo -u cloudclip npm ci --omit=dev
```

在 `.env` 中设置密码，并保留当前实际使用的端口。如果之前已将项目端口改成 `3001`，此处也使用 `3001`。

### 2. 配置 systemd

创建 `/etc/systemd/system/cloudclip.service`：

```ini
[Unit]
Description=CloudClip
After=network.target

[Service]
Type=simple
User=cloudclip
Group=cloudclip
WorkingDirectory=/opt/cloudclip
ExecStart=/usr/bin/node /opt/cloudclip/server.js
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3
UMask=0077

[Install]
WantedBy=multi-user.target
```

启动并设置开机启动：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudclip
sudo systemctl status cloudclip --no-pager
```

如果已有服务，只需在更新代码和 `.env` 后执行 `sudo systemctl restart cloudclip`。

### 3. 配置 Nginx，支持 IP 访问

创建 `/etc/nginx/sites-available/cloudclip`。把 `203.0.113.10` 替换为服务器实际公网 IP；有域名时可填域名。`proxy_pass` 的端口必须与 `.env` 中的 `PORT` 一致。

```nginx
server {
    listen 80;
    server_name 203.0.113.10;

    # 应用单文件上限为 100 MiB，预留 multipart 请求开销。
    client_max_body_size 101m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

项目已经负责密码验证，无需添加 Nginx `auth_basic`。所有访问都应转发给 Node.js，**不要使用 Nginx 的 `root` 或 `alias` 直接提供 `public/uploads`、`public/files`，否则会绕过后端验证**。

```bash
# 仅在第一次配置时创建链接。
sudo ln -s /etc/nginx/sites-available/cloudclip /etc/nginx/sites-enabled/cloudclip
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
```

放行安全组及系统防火墙的 80 端口（HTTPS 使用 443），保留 SSH 端口。无需开放应用的 3000 / 3001 端口。浏览器访问 `http://服务器公网IP`。

HTTP 不加密密码、文本和文件。公网传输隐私内容时使用 HTTPS，或通过 VPN / SSH 隧道访问。有域名且解析到本机后，可安装证书：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的实际域名 --redirect
sudo certbot renew --dry-run
```

此时将 Nginx `server_name` 改为实际域名，`.env` 的 `COOKIE_SECURE` 改为 `true`，再重启应用。

### 4. 更新和排查

```bash
cd /opt/cloudclip
npm ci --omit=dev
sudo systemctl restart cloudclip
sudo journalctl -u cloudclip -n 60 --no-pager
```

- 提示缺少 `ACCESS_PASSWORD`：检查 `/opt/cloudclip/.env` 是否存在、密码是否为空、服务账号是否有读取权限。
- 提示端口占用：用 `sudo ss -ltnp 'sport = :3000'` 检查；更改 `.env` 的端口时同步修改 Nginx。
- 登录后立刻返回密码框：HTTP 部署检查 `COOKIE_SECURE=false`，浏览器需允许 Cookie，并保持同一 IP / 域名和端口访问。
- 返回 403：检查 Nginx 是否保留完整 Host（包括非默认端口），不要跨域调用写入接口。
- 页面可打开但实时同步失败：检查 Nginx 的 WebSocket Upgrade 配置。
- 修改密码：编辑 `.env` 后重启服务，所有旧会话立即失效。

## 数据与备份

默认数据位置如下，设置 `DATA_DIR` 时改为该目录下的同样布局：

```text
clipboard.txt              当前文本
public/uploads/            最新图片
public/files/              最新文件和 file_info.json
```

迁移前先停止旧服务，然后完整复制上述数据，避免复制过程中出现不一致。保留 `.env` 的私有备份，并确保新服务器的服务账号可读写数据目录。图片和文件上传会删除对应目录的旧内容，测试上传前请先备份。

运行时数据和 `.env` 已加入 `.gitignore`。**如果这些文件以前已经提交到 Git，新增忽略规则不会自动移除 Git 跟踪或历史记录。**上传仓库前应单独处理旧提交；仓库是否为 Private 不影响这一点。

## 验证与接口

```bash
npm test
```

测试使用独立临时目录与人工构造的数据，不读取或修改项目现有的剪贴板及上传内容。

| 接口 | 用途 | 是否需要登录 |
| --- | --- | --- |
| `POST /api/auth/login` | JSON：`{"password":"你的密码"}` | 否 |
| `GET /api/auth/session` | 检查当前会话 | 是 |
| `POST /api/auth/logout` | 退出并撤销当前会话 | 否，幂等操作 |
| `GET /api/clip`、`POST /api/clip` | 读取、保存文本；写入 JSON：`{"content":"文本"}` | 是 |
| `GET /api/image`、`POST /api/upload` | 图片信息、上传（表单字段 `image`） | 是 |
| `GET /api/file_info`、`POST /api/file_upload` | 文件信息、上传（表单字段 `file`） | 是 |
| `DELETE /api/file` | 清空当前文件 | 是 |
| `/uploads/*`、`/files/*` | 图片、文件下载 | 是 |
| WebSocket `/` | 实时更新 | 是 |

浏览器通过 HttpOnly、SameSite=Strict Cookie 保存随机会话凭证，前端不存储密码。命令行调用需保存并携带登录返回的 Cookie。带 Origin 的跨站写入和 WebSocket 请求会被拒绝。

同一 IP 在 15 分钟内累计 10 次密码错误后，需等待该窗口结束再登录（返回 429）；有多台设备共用出口 IP 时会共用这一限制。会话和限流状态保存在内存中，适用于单个 Node.js 进程，不适合直接启用多进程集群。

单次文本请求最大 1 MiB，单文件最大 100 MiB。图片支持 PNG、JPEG、GIF、WebP、AVIF、BMP；SVG 等其他格式可作为普通文件传输，普通文件强制以附件下载。
