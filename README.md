# NightWhisper

NightWhisper 是一个移动端深夜语音治愈树洞应用，采用前后端分离结构：

- `frontend/`: React + TypeScript + Vite 移动端界面
- `backend/`: Express 语音服务，负责 `ASR -> LLM -> TTS`
- `deploy/`: Nginx、systemd、自签名 HTTPS 部署文件

## 本地开发

1. 安装依赖

```bash
npm run install:all
```

2. 配置后端环境变量

```bash
cp backend/.env.example backend/.env
```

必须至少填写：

- `LLM_API_KEY` 或 `OPENAI_API_KEY`

可按需覆盖：

- `LLM_BASE_URL`
- `LLM_MODEL`
- `LLM_THINKING_TYPE`
- `OPENAI_BASE_URL`
- `OPENAI_ASR_API_KEY`
- `OPENAI_ASR_BASE_URL`
- `OPENAI_ASR_MODEL`
- `OPENAI_LLM_MODEL`
- `OPENAI_TTS_API_KEY`
- `OPENAI_TTS_BASE_URL`
- `OPENAI_TTS_MODEL`
- `OPENAI_TTS_VOICE`
- `OPENAI_TTS_FORMAT`

3. 启动后端

```bash
npm run dev:backend
```

4. 启动前端

```bash
npm run dev:frontend
```

## AI 链路

后端 `/api/whispers` 已支持拆分配置：

1. `ASR`: 使用独立语音转写接口识别用户音频
2. `LLM`: 使用 NightWhisper 固定人设 prompt 生成深夜回信
3. `TTS`: 使用独立语音合成接口生成回信音频

如果只配置了 `LLM`，则：

- 回信文本走真实大模型
- `ASR` 优先使用浏览器上传的 transcript
- `TTS` 回退到前端浏览器播报

历史记录现在同时保存：

- 用户原始录音
- AI 回信文本
- AI 回信音频

## 麦克风权限

浏览器麦克风权限只能在以下场景正常申请：

- `https://`
- `http://localhost`

因此正式部署必须启用 HTTPS。前端已重构为首次进入先展示权限说明卡片，再显式触发授权请求，并对以下状态给出反馈：

- 待授权
- 已授权
- 被拒绝
- 不支持
- 非安全上下文

## 自签名 HTTPS 部署

1. 在服务器上生成自签名证书

```bash
sudo bash /usr/local/nightwhisper/deploy/setup-self-signed-ssl.sh
```

2. 安装 Nginx 配置

```bash
sudo cp /usr/local/nightwhisper/deploy/nightwhisper.nginx.conf /etc/nginx/conf.d/nightwhisper.conf
sudo nginx -t
sudo systemctl reload nginx
```

3. 配置后端环境变量

```bash
sudo cp /usr/local/nightwhisper/backend/.env.example /usr/local/nightwhisper/backend/.env
sudo editor /usr/local/nightwhisper/backend/.env
```

4. 安装 systemd 服务

```bash
sudo cp /usr/local/nightwhisper/deploy/nightwhisper-backend.service /etc/systemd/system/nightwhisper-backend.service
sudo systemctl daemon-reload
sudo systemctl enable --now nightwhisper-backend
```

当前 Nginx 配置会将 `80` 自动跳转到 `443`，避免用户仍然从 HTTP 进入后拿不到麦克风权限。
