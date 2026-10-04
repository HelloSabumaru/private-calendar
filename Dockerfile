FROM node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM gcr.io/distroless/nodejs22-debian13:nonroot@sha256:ec2313763dd43931543bd03830466e0c409ce73a487e8d46f10db72d3b816c1c
ENV NODE_ENV=production HOST=0.0.0.0 PORT=6742
WORKDIR /app
LABEL org.opencontainers.image.title="Private Calendar" \
      org.opencontainers.image.description="A private, single-instance CalDAV web calendar" \
      org.opencontainers.image.licenses="MIT"
COPY --from=build --chown=65532:65532 /app/package.json /app/LICENSE ./
COPY --from=build --chown=65532:65532 /app/node_modules ./node_modules
COPY --from=build --chown=65532:65532 /app/dist ./dist
COPY --from=build --chown=65532:65532 /app/data ./data
USER 65532:65532
EXPOSE 6742
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '6742') + '/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/server/index.js"]
