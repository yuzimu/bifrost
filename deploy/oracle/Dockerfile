FROM node:25-alpine3.23@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS ui
WORKDIR /build/ui
COPY ui/package.json ui/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY ui/ ./
RUN mkdir -p /build/transports/bifrost-http && npm run build

FROM golang:1.27.0-alpine3.24@sha256:4c9fe60190a2a3350ddc51de80d0224b8a6698d12bdfc999fee45ea9d6c46dbc AS builder
WORKDIR /build
RUN apk add --no-cache gcc musl-dev sqlite-dev
ENV CGO_ENABLED=1 GOOS=linux
COPY core/ core/
COPY framework/ framework/
COPY plugins/ plugins/
COPY transports/ transports/
RUN go work init ./core ./framework ./transports && \
    for module in plugins/*; do \
      if [ -f "$module/go.mod" ]; then go work use "./$module"; fi; \
    done
COPY --from=ui /build/ui/out transports/bifrost-http/ui
ARG VERSION=unknown
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    cd transports && go build -trimpath -tags sqlite_static \
      -ldflags="-w -s -X main.Version=${VERSION} -extldflags '-static'" \
      -o /app/main ./bifrost-http

FROM alpine:3.23.5@sha256:fd791d74b68913cbb027c6546007b3f0d3bc45125f797758156952bc2d6daf40
RUN apk add --no-cache ca-certificates libgcc zlib && \
    adduser -D -u 1000 appuser && mkdir -p /app/data && chown 1000:1000 /app/data
WORKDIR /app
COPY --from=builder /app/main /app/main
COPY --chmod=755 transports/docker-entrypoint.sh /app/docker-entrypoint.sh
ARG SOURCE_REVISION=unknown
ARG SOURCE_SHA256=unknown
LABEL org.opencontainers.image.source="https://github.com/yuzimu/bifrost" \
      org.opencontainers.image.revision="${SOURCE_REVISION}" \
      io.mooo.bifrost.source-sha256="${SOURCE_SHA256}"
ENV APP_DIR=/app/data APP_HOST=0.0.0.0 APP_PORT=8080 LOG_LEVEL=info LOG_STYLE=json
USER 1000:1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/health || exit 1
ENTRYPOINT ["/app/docker-entrypoint.sh"]
