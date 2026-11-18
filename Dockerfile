# 多阶段构建：编译在 builder 里做，运行时镜像只装生产依赖。
# 目的有两个 —— 镜像小，且运行时里没有 tsx / typescript（减少攻击面）。

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json tsconfig.web.json ./
COPY src ./src
COPY web ./web
COPY public ./public
RUN npm run build:all

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist ./dist
# 看板：HTML 壳 + build:web 编出来的 dashboard.js，二选一漏了页面就打不开
COPY --from=builder /app/public ./public
# 离线评测产物：/v1/eval 直接读它，容器里不需要重跑实验
COPY reports ./reports

# 不用 root 跑：容器被突破时，攻击者拿到的不是宿主机 root
RUN addgroup -S app && adduser -S app -G app
RUN mkdir -p /app/logs && chown -R app:app /app
USER app

EXPOSE 8787

# 健康检查：容器编排靠它判断要不要重启实例
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
