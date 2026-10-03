---
name: web-to-api-image
description: 当用户或 Agent 需要通过本机 Web to API Image 服务调用已登录 ChatGPT Web 的图片生成能力，执行文生图、参考图编辑、多图参考、基于 session 上下文继续改图、创建新会话、查询或删除图片会话时使用。调用方只需要遵循本 Skill 的 HTTP 规范，不需要直接操作 openCLI、Chrome 或 ChatGPT Web。
version: 1.0.0
---

# Web to API Image

通过本机 HTTP API 调用 ChatGPT Web 图片生成与编辑能力。

## 适用场景

当任务包含以下任一需求时使用本 Skill：

- 根据文字生成图片；
- 上传一张或多张参考图并编辑；
- 在上一张图基础上继续修改；
- 保持同一个 ChatGPT 会话上下文进行多轮图片编辑；
- 强制开启一个全新的图片会话；
- 查询当前图片 session；
- 手动删除图片 session 与对应 ChatGPT 会话。

调用本 Skill 时，**不要让上层 Agent 再直接操作 openCLI、Browser Bridge 或 ChatGPT 网页**。这些已经由服务内部处理。

---

## 项目配置

默认服务地址与项目目录示例（目录须替换为实际克隆位置）：

```text
Base URL: http://127.0.0.1:3811
Project:  /path/to/image2api
```

服务默认只监听本机 `127.0.0.1`。

上面的 Base URL 使用默认端口 3811；已有本机部署可能使用 3812，不能视为固定端口。调用前读取项目 `.env` 中的 `HOST` / `PORT`，按实际配置构造 Base URL，并替换下方示例地址。`manage.sh start` 可能因端口占用而更新 `.env` 中的 `PORT`；启动后须重新读取。未配置端口时程序默认值为 3811。

API Key 存在：

```text
/path/to/image2api/.env
```

读取方式：

```bash
cd '/path/to/image2api'
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)
```

**不得在最终回复、日志摘要、聊天内容里输出完整 API Key。**

---

## 调用前检查

### 1. 检查服务

```bash
curl -fsS http://127.0.0.1:3811/healthz
curl -fsS http://127.0.0.1:3811/readyz
```

正常时应包含：

```json
{"ok":true}
```

`readyz` 还会验证 Browser Bridge 与 ChatGPT Web 是否可用。

### 2. 服务未启动时

如果 Agent 有本机 Shell 权限，可执行：

```bash
cd '/path/to/image2api'
./manage.sh start
```

然后重新检查：

```bash
./manage.sh health
```

如果 `healthz=true` 但 `readyz=false`，不要立即生图。优先检查：

```bash
opencli doctor
```

需要满足：

- openCLI daemon 正常；
- Browser Bridge extension connected；
- Chrome 正在运行；
- ChatGPT Web 登录状态有效。

---

# 一、文生图

接口：

```text
POST /v1/images/generations
```

推荐调用：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只毛茸茸的银渐层小猫坐在窗边，柔和阳光，写实摄影，无文字",
    "size": "1024x1024",
    "quality": "medium",
    "n": 1,
    "response_format": "b64_json"
  }'
```

## 必需参数

### `prompt`

必须是非空字符串。

Agent 应直接写清最终图片需求，包括：

- 主体；
- 场景；
- 构图；
- 风格；
- 比例倾向；
- 是否允许文字；
- 必须保持或禁止改变的内容。

不要在 prompt 中加入无关的工作过程说明。

---

## 推荐参数

### `model`

当前统一使用：

```text
gpt-image-2
```

这是本服务的调用别名。调用方不需要判断 ChatGPT Web 当前具体底层图片模型。

### `size`

示例：

```text
1024x1024
1024x768
768x1024
1536x1024
1024x1536
```

**重要：当前服务会把 `size` 作为 ChatGPT Web 的图片尺寸 / 比例偏好传入。不要假定最终原始图片一定严格等于请求像素值。**

如果任务只强调比例，Agent 应优先把正确比例同时写入 prompt，例如：

```text
4:3 横向构图
3:4 竖向构图
9:16 竖屏构图
16:9 横屏构图
```

### `quality`

推荐：

```text
medium
high
```

当前同样作为 ChatGPT Web 生成偏好使用。

### `background`

可选。当前作为生成偏好使用，例如：

```text
auto
transparent
opaque
```

### `n`

当前必须：

```json
"n": 1
```

不要传 `n > 1`。

### `response_format`

当前必须：

```json
"response_format": "b64_json"
```

---

# 二、参考图编辑 / 图生图

接口：

```text
POST /v1/images/edits
```

必须使用 `multipart/form-data`。

示例：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/edits \
  -H "Authorization: Bearer $API_KEY" \
  -F 'model=gpt-image-2' \
  -F 'prompt=保持主体和整体构图不变，把背景改成深蓝色夜景，写实风格，无文字' \
  -F 'size=1024x1024' \
  -F 'quality=medium' \
  -F 'response_format=b64_json' \
  -F 'image=@/absolute/path/reference.jpg'
```

## 输入图片规则

- 使用真实本地绝对路径；
- 支持 PNG / JPG / JPEG / WEBP / GIF；
- 单文件默认上限 20 MB；
- 不要把图片 base64 塞进 JSON；
- 不要调用 openCLI 自己上传，交给本 API；
- 当前不支持 mask 编辑。

## 多参考图

可重复传 `image`：

```bash
-F 'image=@/path/a.png' \
-F 'image=@/path/b.png' \
-F 'image=@/path/c.png'
```

prompt 必须说明每张参考图的用途和优先级。

---

# 三、保存生成图片

API 返回：

```json
{
  "created": 0,
  "data": [
    {
      "b64_json": "...",
      "revised_prompt": null
    }
  ],
  "session": {
    "session_id": "imgsess_xxx",
    "conversation_id": "...",
    "conversation_url": "https://chatgpt.com/.../c/...",
    "expires_at": 0,
    "ttl_seconds": 1800
  }
}
```

**不要把完整 `b64_json` 打印到 Agent 对话或终端摘要中。**

推荐保存响应到临时 JSON：

```bash
curl ... > /tmp/web2api-image-response.json
```

再用 Python 落盘：

```bash
python3 - <<'PY'
import base64, json
src = '/tmp/web2api-image-response.json'
out = '/tmp/generated.png'
data = json.load(open(src, 'r', encoding='utf-8'))
if 'error' in data:
    raise SystemExit(data['error'])
raw = base64.b64decode(data['data'][0]['b64_json'])
open(out, 'wb').write(raw)
print(out)
print('session_id=', data.get('session', {}).get('session_id', ''))
PY
```

如果用户指定输出目录，保存到用户指定目录。

---

# 四、Session：继续上一张图

这是本服务的重要能力。

第一次生成后保存：

```text
session_id
```

下一轮不要创建新会话，直接带回同一个 `session_id`。

例如：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "保持人物、脸和整体构图不变，只把衣服换成黑色夹克",
    "session_id": "imgsess_xxx",
    "n": 1,
    "response_format": "b64_json"
  }'
```

服务会重新打开原 ChatGPT conversation，在同一上下文继续。

## 什么时候必须复用 session

用户表达以下意图时，必须复用：

- “基于刚才那张图”；
- “继续修改”；
- “人物不要变”；
- “上一版基础上”；
- “保持这个脸 / 姿势 / 构图”；
- “再改一下背景 / 衣服 / 光线”。

除非用户明确要求“重新生成 / 新会话 / 不要参考上一张”。

---

# 五、强制新会话

如果用户明确要求新上下文：

```json
{
  "prompt": "重新设计一个完全不同的机器人",
  "session_id": "imgsess_old",
  "new_chat": true,
  "n": 1,
  "response_format": "b64_json"
}
```

旧 session 不会立即删除；它会按自己的 TTL 自动清理。

---

# 六、Session TTL

默认：

```text
7200 秒 = 2 小时
```

请求可以指定：

```json
"session_ttl_seconds": 600
```

约束：

```text
最短 60 秒
默认 7200 秒（2 小时）
当前服务端最大 7200 秒（2 小时）
```

如果调用方传入更长 TTL，服务端会按 `SESSION_MAX_TTL_SECONDS` 自动限制。

每次成功继续同一个 session 都会更新最后活动时间。

超时后服务会自动：

1. 删除对应 ChatGPT conversation；
2. 从 `Web to API 的 image` Project / 历史中移除；
3. 删除本地 session 记录；
4. 保留本地输入、输出文件及 job / asset 记录，直到独立的 7 天本地清理到期；
5. 如果删除失败，将 session 标记为可重试状态，并在后续 cleanup 周期继续尝试；
6. 如果 Project 中存在没有 SQLite session 记录的孤儿会话，服务会先记录其首次发现时间；持续超过默认 TTL 后仍无对应 session，则自动删除。孤儿删除失败时，下次扫描继续重试。

---

## 本地文件保留期

服务会在 `tmp/outputs` 保存生成图，在 `tmp/uploads` 保存成功请求的参考图。默认保留最近 7 天，启动时补清理、之后每 24 小时清理超过 7 天的服务文件和 job / asset 记录。远程 session TTL 到期不再立即删除这些本地结果；手动 DELETE session 仍会立即清除其本地内容。失败上传即时清理，历史遗留文件由每日清理兜底。

调用方自行解码保存的副本不在服务清理范围内，需要长期保存时应另行存到自己的目录。生成、扫描与删除共用后台页面队列，readyz 或请求可能等待前一个操作完成，不能因为排队或超时盲目重试 POST。

# 七、查询 Session

```bash
curl -sS \
  -H "Authorization: Bearer $API_KEY" \
  http://127.0.0.1:3811/v1/images/sessions/imgsess_xxx
```

返回包含：

- session status；
- conversation_id；
- conversation_url；
- project；
- created_at；
- last_activity_at；
- expires_at；
- ttl_seconds。

---

# 八、手动删除 Session

当用户明确说：

- “结束这个生图会话”；
- “删除这个 session”；
- “不要保留这次聊天”；
- “清掉刚才的生成会话”；

调用：

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  http://127.0.0.1:3811/v1/images/sessions/imgsess_xxx
```

成功：

```json
{
  "id": "imgsess_xxx",
  "object": "image.session.deleted",
  "deleted": true
}
```

---

# 九、错误处理

常见错误：

## 401

```text
Invalid API key
```

重新从项目 `.env` 读取 API_KEY。不要猜 key。

## 400

常见原因：

- prompt 缺失；
- `n != 1`；
- `response_format` 不是 `b64_json`；
- mask 暂不支持；
- JSON 中用了中文弯引号。

特别注意：JSON 只能使用标准 ASCII 双引号：

```text
正确: "1024x768"
错误: "1024x768”
```

## 404

```text
Unknown or expired session_id
```

不要继续复用该 session。根据用户意图新建会话。

## 410

session 已过期。

如果用户仍希望继续，只能开启新会话，并明确告诉用户原上下文已不能继续复用。

## 413

输入图片过大。

## 415

`/v1/images/edits` 没有使用 multipart/form-data。

## 502 / 5xx

上游 ChatGPT Web / Browser Bridge / Chrome 出现异常。

先检查：

```bash
cd '/path/to/image2api'
./manage.sh status
./manage.sh health
opencli doctor
```

---

# 十、重试规则

**禁止对生成请求进行无脑自动重试。**

原因：HTTP 调用超时并不一定代表 ChatGPT 没有收到 prompt。直接重试可能产生两张图和两个 conversation。

遇到请求超时时：

1. 不要立即重复 `POST`；
2. 查看服务日志：

```bash
cd '/path/to/image2api'
tail -n 100 logs/service.log
```

3. 判断原请求是否已经返回 200 / 创建会话；
4. 只有确认原生成失败后再重试。

---

# 十一、Agent 执行规范

1. 调用本服务时只使用 HTTP API，不绕回 openCLI 网页操作。
2. 文生图使用 `/v1/images/generations`。
3. 有本地参考图使用 `/v1/images/edits`。
4. 多轮修改必须优先保存并复用 `session_id`。
5. 用户明确要求新上下文时才使用 `new_chat=true`。
6. `n` 固定为 1。
7. `response_format` 固定为 `b64_json`。
8. 不把 API Key 或完整 b64 输出到聊天。
9. 保存生成图后，只向用户报告文件路径、session_id 和必要的生成结果信息。
10. 不要假设 `size` 一定代表最终严格像素；当前它主要用于比例 / 尺寸偏好。
11. 不要因为 HTTP timeout 就自动重复生图。
12. 用户要求删除时，必须调用 session DELETE，而不是只删本地图片文件。

---

# 十二、最简决策树

```text
用户要生成图片
      │
      ├─ 没有参考图
      │      ↓
      │ /v1/images/generations
      │
      └─ 有参考图
             ↓
        /v1/images/edits

是否是在上一张图基础上继续？
      │
      ├─ 是 → 带原 session_id
      │
      └─ 否 → 不带 session_id

用户明确说“开新对话 / 重新来”？
      │
      └─ 是 → new_chat=true

生成成功
      ↓
保存 b64_json 为图片文件
      ↓
保存 session_id 供后续继续编辑
```
