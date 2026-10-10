package guardrails

import (
	"context"
	"crypto/tls"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/maximhq/bifrost/core/network"
)

// presidioURL 校验私网部署地址与路径，不解析 DNS，也不接受 URL 凭据或导航段。
func presidioURL(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "http" && u.Scheme != "https" || u.Hostname() == "" ||
		u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" ||
		strings.ContainsAny(u.Hostname(), "%\\ \t\r\n") || strings.Contains(u.Path, "\\") {
		return nil, errors.New("Presidio analyzer_url 无效")
	}
	if port := u.Port(); port != "" {
		n, err := strconv.Atoi(port)
		if err != nil || n < 1 || n > 65535 {
			return nil, errors.New("Presidio analyzer_url 端口无效")
		}
	} else if strings.HasSuffix(u.Host, ":") {
		return nil, errors.New("Presidio analyzer_url 端口为空")
	}
	ip := net.ParseIP(u.Hostname())
	if strings.ContainsAny(u.Host, "[]") && ip == nil ||
		strings.Contains(u.Hostname(), ":") && (ip == nil || !strings.HasPrefix(u.Host, "[")) {
		return nil, errors.New("Presidio analyzer_url 主机无效")
	}
	if strings.Contains(u.Path, "%") {
		return nil, errors.New("Presidio analyzer_url 不允许重复编码路径")
	}
	for _, segment := range strings.Split(u.Path, "/") {
		if segment == "." || segment == ".." {
			return nil, errors.New("Presidio analyzer_url 不允许导航路径")
		}
	}
	if err := network.CheckPrivateNetworkLiteral(u.Hostname()); err != nil {
		return nil, errors.New("Presidio analyzer_url 地址被禁止")
	}
	if ip != nil && (ip.IsMulticast() || ip.Equal(net.IPv4bcast)) {
		return nil, errors.New("Presidio analyzer_url 地址被禁止")
	}
	return u, nil
}

// presidioHTTPClient 用 core 私网策略解析并锁定 IP，额外拒绝组播；代理与重定向均禁用。
func presidioHTTPClient(timeout time.Duration) *http.Client {
	privateDial := network.PrivateNetworkDialContext(timeout)
	transport := &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, protocol, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			ips, err := network.ResolvePrivateNetworkTarget(ctx, host)
			if err != nil {
				return nil, err
			}
			for _, ip := range ips {
				if ip.IsMulticast() || ip.Equal(net.IPv4bcast) {
					return nil, errors.New("Presidio 目标地址被禁止")
				}
			}
			var lastErr error
			for _, ip := range ips {
				conn, err := privateDial(ctx, protocol, net.JoinHostPort(ip.String(), port))
				if err == nil {
					return conn, nil
				}
				lastErr = err
			}
			return nil, lastErr
		},
		TLSClientConfig:       &tls.Config{MinVersion: tls.VersionTLS12},
		TLSHandshakeTimeout:   10 * time.Second,
		ResponseHeaderTimeout: timeout,
		ForceAttemptHTTP2:     true,
	}
	return &http.Client{Transport: transport, Timeout: timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
