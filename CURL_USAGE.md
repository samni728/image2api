# Web to API Image — curl 使用说明

这是给人直接调用的命令行说明。

服务地址：

```text
http://127.0.0.1:3811
```

本文示例使用默认端口 3811（已有本机部署可能使用 3812）。实际地址以项目 `.env` 中的 `HOST` / `PORT` 为准；运行 `./manage.sh status` 查看端口。如果启动时自动切换了端口，请同步替换下面示例中的地址。

项目目录示例（请替换为你实际克隆的位置；也可直接在项目根目录运行命令）：

```text
/path/to/image2api
```

---

## 1. 查看服务状态

```bash
cd '/path/to/image2api'
./manage.sh status
```

完整管理菜单：

```bash
./manage.sh
```

可直接使用：

```bash
./manage.sh start
./manage.sh restart
./manage.sh stop
./manage.sh status
./manage.sh logs
./manage.sh health
```

健康检查：

```bash
curl http://127.0.0.1:3811/healthz
curl http://127.0.0.1:3811/readyz
```

---

## 2. 读取 API Key

不要把真实 key 硬编码到共享文档里。

在本机执行：

```bash
cd '/path/to/image2api'
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)
```

确认变量存在但不要打印完整值：

```bash
echo "API key loaded: ${API_KEY:+yes}"
```

---

# 3. 文生图

最简单示例：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只小男孩，写实摄影，无文字",
    "size": "1024x1024",
    "quality": "medium",
    "n": 1,
    "response_format": "b64_json"
  }' \
  -o /tmp/web2api-image.json
```

成功后响应保存在：

```text
/tmp/web2api-image.json
```

---

## 4. 1024×768 / 4:3 示例

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gpt-image-2",
    "prompt": "一只小男孩，写实摄影，4:3 横向构图，无文字",
    "size": "1024x768",
    "quality": "medium",
    "n": 1,
    "response_format": "b64_json"
  }' \
  -o /tmp/web2api-image.json
```

### JSON 引号注意

必须使用英文标准双引号：

```text
正确："size": "1024x768"
错误："size": "1024x768”
```

最后那个中文弯引号 `”` 会导致：

```text
Body is not valid JSON
```

该错误与图片尺寸无关。

---

# 5. 把返回的 base64 保存成图片

```bash
python3 - <<'PY'
import base64, json

src = '/tmp/web2api-image.json'
out = '/tmp/generated.png'

data = json.load(open(src, 'r', encoding='utf-8'))

if 'error' in data:
    print(data['error'])
    raise SystemExit(1)

raw = base64.b64decode(data['data'][0]['b64_json'])
open(out, 'wb').write(raw)

print('图片:', out)
print('session_id:', data.get('session', {}).get('session_id'))
print('conversation_id:', data.get('session', {}).get('conversation_id'))
print('expires_at:', data.get('session', {}).get('expires_at'))
PY
```

---

# 6. 一条命令：生成并保存图片

```bash
cd '/path/to/image2api'
API_KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)

curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-image-2",
    "prompt":"一只银渐层小猫坐在窗边，柔和阳光，写实摄影，无文字",
    "size":"1024x1024",
    "quality":"medium",
    "n":1,
    "response_format":"b64_json"
  }' \
  -o /tmp/web2api-image.json && \
python3 - <<'PY'
import base64,json
x=json.load(open('/tmp/web2api-image.json'))
if 'error' in x:
    raise SystemExit(str(x['error']))
open('/tmp/generated.png','wb').write(base64.b64decode(x['data'][0]['b64_json']))
print('/tmp/generated.png')
print('session_id=',x['session']['session_id'])
PY
```

---

# 7. 上传参考图进行编辑

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/edits \
  -H "Authorization: Bearer $API_KEY" \
  -F 'model=gpt-image-2' \
  -F 'prompt=保持主体和整体构图不变，把背景改成深蓝色夜景，写实风格，无文字' \
  -F 'size=1024x1024' \
  -F 'quality=medium' \
  -F 'response_format=b64_json' \
  -F 'image=@/absolute/path/reference.jpg' \
  -o /tmp/web2api-edit.json
```

然后解码：

```bash
python3 - <<'PY'
import base64,json
x=json.load(open('/tmp/web2api-edit.json'))
if 'error' in x:
    raise SystemExit(str(x['error']))
open('/tmp/edited.png','wb').write(base64.b64decode(x['data'][0]['b64_json']))
print('/tmp/edited.png')
print('session_id=',x['session']['session_id'])
PY
```

---

# 8. 多张参考图

重复添加多个 `image` 字段：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/edits \
  -H "Authorization: Bearer $API_KEY" \
  -F 'model=gpt-image-2' \
  -F 'prompt=参考第一张图的人物脸型和第二张图的服装，把人物放到第三张图类似的夜景环境中，无文字' \
  -F 'response_format=b64_json' \
  -F 'image=@/path/person.jpg' \
  -F 'image=@/path/clothes.jpg' \
  -F 'image=@/path/background.jpg' \
  -o /tmp/web2api-multi-edit.json
```

---

# 9. 在上一张图基础上继续修改

第一次生成成功后会得到：

```text
session_id=imgsess_xxx
```

把它保存：

```bash
SESSION_ID='imgsess_xxx'
```

继续修改：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"gpt-image-2\",
    \"prompt\": \"保持人物、脸和构图不变，只把衣服换成黑色夹克\",
    \"session_id\": \"$SESSION_ID\",
    \"n\": 1,
    \"response_format\": \"b64_json\"
  }" \
  -o /tmp/web2api-continue.json
```

这样会继续原来的 ChatGPT conversation，不会重新建立无上下文的图片会话。

---

# 10. 参考图会话继续编辑但不再重新上传图片

只要原 session 仍有效，可以直接：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"gpt-image-2\",
    \"prompt\": \"继续上一张，把背景灯光再暗一点，其他内容不要变化\",
    \"session_id\": \"$SESSION_ID\",
    \"n\": 1,
    \"response_format\": \"b64_json\"
  }"
```

---

# 11. 强制开启新会话

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d "{
    \"model\": \"gpt-image-2\",
    \"prompt\": \"重新设计一个完全不同的机器人\",
    \"session_id\": \"$SESSION_ID\",
    \"new_chat\": true,
    \"n\": 1,
    \"response_format\": \"b64_json\"
  }"
```

原 session 不会立即被删除，它会按自己的 TTL 自动清理。

---

# 12. 设置 Session 保留时间

例如保留 10 分钟：

```json
"session_ttl_seconds": 600
```

完整例子：

```bash
curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model":"gpt-image-2",
    "prompt":"一只写实小猫，无文字",
    "session_ttl_seconds":600,
    "n":1,
    "response_format":"b64_json"
  }'
```

默认 TTL：

```text
7200 秒 / 2 小时
```

允许范围：

```text
最短 60 秒
当前服务端上限 7200 秒 / 2 小时
```

如果调用方传入更大的 `session_ttl_seconds`（例如 86400），服务端会自动限制为 7200 秒。

---

# 13. 查询 Session

```bash
curl -sS \
  -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:3811/v1/images/sessions/$SESSION_ID"
```

---

# 14. 手动删除 Session

```bash
curl -sS -X DELETE \
  -H "Authorization: Bearer $API_KEY" \
  "http://127.0.0.1:3811/v1/images/sessions/$SESSION_ID"
```

成功：

```json
{
  "id": "imgsess_xxx",
  "object": "image.session.deleted",
  "deleted": true
}
```

该操作会同时删除对应 ChatGPT conversation，并从 API 的 SQLite session 中清除。

---

# 15. 当前参数规则

| 参数 | 当前规则 |
|---|---|
| `model` | 建议固定 `gpt-image-2` |
| `prompt` | 必填 |
| `size` | 可填，当前作为图片尺寸 / 比例偏好 |
| `quality` | 可填，建议 `medium` / `high` |
| `background` | 可填 |
| `n` | 当前只能是 `1` |
| `response_format` | 当前只能是 `b64_json` |
| `session_id` | 可选，用于续图 |
| `new_chat` | 可选，`true` 表示新会话 |
| `session_ttl_seconds` | 最短 60；默认 7200；当前服务端最大 7200 |

### 关于 size

当前后端调用的是 ChatGPT Web 图片能力，所以：

```text
size=1024x768
```

代表希望生成相应尺寸 / 4:3 比例，但**不能把最终原始图片严格像素等于 1024×768 当成硬保证**。

如果最终应用必须严格得到某个像素尺寸，应在生成后增加本地 resize / crop 步骤。

---

# 16. 常见错误

## `Body is not valid JSON`

优先检查：

- 有没有中文弯引号 `“ ”`；
- 有没有漏逗号；
- 有没有在 shell 中把单双引号嵌套写错。

推荐：复杂请求先写 JSON 文件再 curl：

```bash
cat >/tmp/request.json <<'JSON'
{
  "model": "gpt-image-2",
  "prompt": "一只小男孩，写实摄影，无文字",
  "size": "1024x768",
  "quality": "medium",
  "n": 1,
  "response_format": "b64_json"
}
JSON

curl -sS --max-time 360 \
  http://127.0.0.1:3811/v1/images/generations \
  -H "Authorization: Bearer $API_KEY" \
  -H 'Content-Type: application/json' \
  --data-binary @/tmp/request.json
```

这种写法最不容易因为复制粘贴破坏 JSON。

## 401

API Key 错误。

## 404 / 410

Session 不存在或已经超时。

## 413

输入图片太大。

## 415

图片编辑接口不是 multipart/form-data。

## 5xx

检查：

```bash
cd '/path/to/image2api'
./manage.sh health
opencli doctor
```

查看实时日志：

```bash
./manage.sh logs
```

---

# 17. 不要盲目重试生图 POST

如果 curl 自己超时，不代表 ChatGPT 一定没有开始生成。

不要立刻重复同一条 POST，否则可能重复生成两次。

先检查：

```bash
tail -n 100 '/path/to/image2api/logs/service.log'
```

确认上一条请求确实失败后再重新调用。


# 18. 后台复用与本地保留期

服务默认复用固定后台 Chrome 页面，生成、扫描与删除串行执行，维护操作不再每次创建随机 session。页面空闲 30 分钟后允许释放；下次调用或服务重启后仍可能创建页面。macOS 首次创建窗口可能抢焦点，后台模式不等于无头浏览器。

生成图在 `tmp/outputs` 存一份，本地成功上传位于 `tmp/uploads`。默认 `LOCAL_RETENTION_DAYS=7`、`LOCAL_CLEANUP_INTERVAL_SECONDS=86400`：启动时补清理，之后每天清理超过 7 天的文件和 job / asset 记录。正在使用的文件不会被清理。远程会话仍按默认 2 小时 TTL 清理，本地结果可保留到 7 天；手动 DELETE session 会立即删除对应本地文件和记录。

你自行保存的 `/tmp/generated.png` 或其他目录下的图片副本不由本服务清理。需要长期保留的图片请及时另存。
