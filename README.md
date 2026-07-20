# dailysync-docker

> 将 [dailysync-rev](https://github.com/gooin/dailysync-rev)（佳明国区/国际区运动数据同步工具）整合 Docker Compose，一键部署带 Web 管理面板的版本。

## 📋 项目说明

本项目基于 [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev)（GPL-3.0 开源协议）进行二次整合，主要改动：

- **Web 管理面板**：基于 Express 的网页界面，支持多用户登录、手动/定时同步
- **连接池优化**：避免长时间空闲断开
- **用户数据隔离**：每个用户只能看到自己的佳明账号配置和同步记录
- **一键部署**：`docker compose up -d` 即可启动

## 🚀 快速开始

### 前置条件

- Docker 23+ & Docker Compose v2+

### 1. 克隆项目

```bash
git clone https://github.com/fanshandy/dailysync-gramin-docker.git
cd dailysync-gramin-docker
```

### 2. 启动服务

```bash
docker compose up -d
```

等待构建完成（首次约 3-5 分钟），然后浏览器打开 **http://服务器IP:9610**，注册登录即可使用。

### 3. 查看日志

```bash
docker compose logs -f dailysync
```

## ⚙️ 配置说明

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `TZ` | `Asia/Shanghai` | 时区 |
| `DB_HOST` | `mariadb` | 数据库主机 |
| `DB_PORT` | `3306` | 数据库端口 |
| `DB_USER` | `dailysync` | 数据库用户 |
| `DB_PASS` | `dailysync_pass` | 数据库密码 |
| `DB_NAME` | `dailysync` | 数据库名 |
| `ENC_KEY` | `dailysync-secret-key-2024` | 佳明密码加密密钥 |

### 修改端口

编辑 `docker-compose.yml`，修改 `ports` 部分：

```yaml
ports:
  - "自定义端口:9610"
```

### 修改默认密码等配置

编辑 `docker-compose.yml` 中的环境变量即可。

## 📂 项目结构

```
dailysync-docker/
├── docker-compose.yml        # 服务编排
├── Dockerfile                # Web 服务镜像构建
├── scheduler.ts              # 主服务代码（Web UI + API + 同步逻辑）
├── package.json              # Node.js 依赖
├── yarn.lock                 # 依赖锁定
├── tsconfig.json             # TypeScript 配置
├── .env.example              # 环境变量示例
├── .gitignore
├── mariadb-init/
│   └── init.sql              # 数据库初始化脚本
├── src/                      # dailysync-rev 同步核心代码
│   ├── sync_garmin_cn_to_global.ts
│   ├── sync_garmin_global_to_cn.ts
│   ├── constant.ts
│   └── utils/
└── assets/                   # 文档用图片资源
```

```yaml
services:
  mariadb:
    image: mariadb:11.0
    container_name: dailysync-db
    restart: unless-stopped
    environment:
      - MYSQL_ROOT_PASSWORD=rootpass
      - MYSQL_DATABASE=dailysync
      - TZ=Asia/Shanghai
    volumes:
      - mariadb-data:/var/lib/mysql
      - ./mariadb-init:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "-u", "root", "-prootpass"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - dailysync-net

  dailysync:
    build: .
    container_name: dailysync-web
    restart: unless-stopped
    depends_on:
      mariadb:
        condition: service_healthy
    environment:
      - TZ=Asia/Shanghai
      - DB_HOST=mariadb
      - DB_PORT=3306
      - DB_USER=dailysync
      - DB_PASS=dailysync_pass
      - DB_NAME=dailysync
      - ENC_KEY=dailysync-secret-key-2024
    ports:
      - "9610:9610"
    volumes:
      - sync-data:/app/db
    networks:
      - dailysync-net

volumes:
  mariadb-data:
  sync-data:

networks:
  dailysync-net:
    driver: bridge
```

## 🔄 定时同步

系统默认在 **每天 08:00 和 16:00（北京时间）** 自动为所有已配置佳明账号的用户执行同步。

修改定时规则：编辑 `scheduler.ts` 中 `cron.schedule('0 8,16 * * *', ...)` 后重建镜像。

## 🧩 技术栈

- **前端**：纯 HTML/CSS/JS（无框架，内嵌在 scheduler.ts 中）
- **后端**：Node.js + Express + TypeScript
- **数据库**：MariaDB 11
- **同步引擎**：dailysync-rev（Garmin Connect API）

## 📜 开源许可

本项目基于 **GPL-3.0** 协议开源。

核心同步引擎 [dailysync-rev](https://github.com/gooin/dailysync-rev) 由 [gooin](https://github.com/gooin) 开发，同样采用 GPL-3.0 协议。

## 🙏 致谢

- [gooin/dailysync-rev](https://github.com/gooin/dailysync-rev) — 原始佳明数据同步工具
