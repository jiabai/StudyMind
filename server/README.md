# StudyMind Server

StudyMind 独立服务器骨架。

## 开发

```bash
npm install
npm run dev    # 开发模式
npm run build  # 构建
npm start      # 生产模式
```

## API

- `GET /health/live` - 存活检查
- `GET /health/ready` - 就绪检查

## 配置

- `PORT` - 监听端口 (默认 8788)
- `HOST` - 监听地址 (默认 0.0.0.0)
