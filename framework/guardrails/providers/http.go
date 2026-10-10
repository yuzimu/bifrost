package providers

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	providerutils "github.com/maximhq/bifrost/core/providers/utils"
)

const (
	maxConfigBytes   = 64 << 10
	maxContentBytes  = 1 << 20
	maxResponseBytes = 4 << 20
)

var envName = regexp.MustCompile(`^env\.[A-Za-z_][A-Za-z0-9_]*$`)

type connection struct {
	APIKey  string `json:"api_key"`
	BaseURL string `json:"base_url,omitempty"`
	Timeout int    `json:"timeout,omitempty"`
}

// decodeConfig 拒绝未知字段、重复键和空对象以外的顶层值，不修改传入配置。
func decodeConfig(raw json.RawMessage, dst any) error {
	if len(raw) > maxConfigBytes || !utf8.Valid(raw) || !validObject(raw) || !strictConfigShape(raw, reflect.TypeOf(dst)) {
		return fmt.Errorf("%w: expected a bounded JSON object", ErrInvalidConfig)
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(dst); err != nil {
		return fmt.Errorf("%w: unsupported field or invalid field type", ErrInvalidConfig)
	}
	return nil
}

// strictConfigShape 按 JSON 标签精确匹配配置字段，拒绝 null 和大小写别名。
func strictConfigShape(raw json.RawMessage, typ reflect.Type) bool {
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return false
	}
	for typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	switch typ.Kind() {
	case reflect.Struct:
		fields := make(map[string]reflect.Type)
		var collect func(reflect.Type)
		collect = func(t reflect.Type) {
			for i := 0; i < t.NumField(); i++ {
				field := t.Field(i)
				if field.Anonymous {
					collect(field.Type)
					continue
				}
				tag := strings.Split(field.Tag.Get("json"), ",")[0]
				if tag != "" && tag != "-" {
					fields[tag] = field.Type
				}
			}
		}
		collect(typ)
		var object map[string]json.RawMessage
		if json.Unmarshal(raw, &object) != nil || object == nil {
			return false
		}
		for key, value := range object {
			field, ok := fields[key]
			if !ok || !strictConfigShape(value, field) {
				return false
			}
			if key == "timeout" {
				var timeout int
				if json.Unmarshal(value, &timeout) != nil || timeout < 1 || timeout > 300 {
					return false
				}
			}
		}
	case reflect.Slice, reflect.Array:
		var values []json.RawMessage
		if json.Unmarshal(raw, &values) != nil {
			return false
		}
		for _, value := range values {
			if !strictConfigShape(value, typ.Elem()) {
				return false
			}
		}
	case reflect.Map:
		var values map[string]json.RawMessage
		if json.Unmarshal(raw, &values) != nil {
			return false
		}
		for _, value := range values {
			if !strictConfigShape(value, typ.Elem()) {
				return false
			}
		}
	}
	return true
}

// validObject 遍历 JSON token，拒绝重复字段，防止不同解析器得出不同策略。
func validObject(raw []byte) bool {
	if !json.Valid(raw) || len(bytes.TrimSpace(raw)) == 0 || bytes.TrimSpace(raw)[0] != '{' {
		return false
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var value func(int) bool
	value = func(depth int) bool {
		if depth > 64 {
			return false
		}
		t, err := d.Token()
		if err != nil {
			return false
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return true
		}
		switch delim {
		case '{':
			keys := make(map[string]bool)
			for d.More() {
				key, err := d.Token()
				s, ok := key.(string)
				if err != nil || !ok || keys[s] || !value(depth+1) {
					return false
				}
				keys[s] = true
			}
			end, err := d.Token()
			return err == nil && end == json.Delim('}')
		case '[':
			for d.More() {
				if !value(depth + 1) {
					return false
				}
			}
			end, err := d.Token()
			return err == nil && end == json.Delim(']')
		}
		return false
	}
	return value(0)
}

// secret 仅从环境变量读取凭据，错误中不包含凭据或环境变量的值。
func secret(ref string) (string, error) {
	if !envName.MatchString(ref) {
		return "", fmt.Errorf("%w: credentials require env.NAME", ErrInvalidConfig)
	}
	value := os.Getenv(strings.TrimPrefix(ref, "env."))
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n") {
		return "", fmt.Errorf("%w: missing or invalid credential environment", ErrInvalidConfig)
	}
	return value, nil
}

// endpoint 同时校验保存配置和运行时环境展开后的地址；HTTP 只允许显式 loopback。
func endpoint(base, fallback, suffix string, originOnly bool) (string, error) {
	if strings.HasPrefix(base, "env.") {
		if !envName.MatchString(base) {
			return "", fmt.Errorf("%w: invalid URL environment reference", ErrInvalidConfig)
		}
		base = os.Getenv(strings.TrimPrefix(base, "env."))
		if base == "" {
			return "", fmt.Errorf("%w: missing URL environment", ErrInvalidConfig)
		}
	}
	if base == "" {
		base = fallback
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" ||
		u.Opaque != "" || u.RawPath != "" || u.ForceQuery {
		return "", fmt.Errorf("%w: invalid provider URL", ErrInvalidConfig)
	}
	host := strings.ToLower(strings.TrimSuffix(u.Hostname(), "."))
	if forbiddenHost(host) {
		return "", fmt.Errorf("%w: prohibited provider host", ErrInvalidConfig)
	}
	ip, ipErr := netip.ParseAddr(host)
	loopback := ipErr == nil && ip.IsLoopback()
	if ipErr == nil && forbiddenIP(ip) {
		return "", fmt.Errorf("%w: prohibited provider address", ErrInvalidConfig)
	}
	if u.Scheme != "https" && !(u.Scheme == "http" && (loopback || host == "localhost")) {
		return "", fmt.Errorf("%w: HTTPS or loopback HTTP required", ErrInvalidConfig)
	}
	if originOnly && strings.Trim(u.Path, "/") != "" {
		return "", fmt.Errorf("%w: provider URL must be an origin", ErrInvalidConfig)
	}
	u.Path = strings.TrimRight(u.Path, "/")
	if suffix == "/v2/guard" && strings.HasSuffix(u.Path, "/v2") {
		u.Path += "/guard"
	} else if !strings.HasSuffix(u.Path, suffix) {
		u.Path += suffix
	}
	return u.String(), nil
}

func forbiddenHost(host string) bool {
	return host == "metadata" || host == "metadata.google.internal" || host == "instance-data" ||
		host == "instance-data.ec2.internal" || strings.Contains(host, "%")
}

func forbiddenIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	return !ip.IsValid() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() || ip.IsMulticast() ||
		ip == netip.MustParseAddr("100.100.100.200") ||
		ip == netip.MustParseAddr("168.63.129.16") ||
		netip.MustParsePrefix("0.0.0.0/8").Contains(ip) ||
		netip.MustParsePrefix("240.0.0.0/4").Contains(ip)
}

// guardedDial 检查解析后的每个 IP 并直接连接该 IP，避免 DNS 重绑定绕过地址限制。
func guardedDial(ctx context.Context, network, address string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil || forbiddenHost(strings.ToLower(host)) {
		return nil, ErrProvider
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil || len(ips) == 0 {
		return nil, ErrProvider
	}
	for _, ip := range ips {
		if forbiddenIP(ip) || (strings.EqualFold(host, "localhost") && !ip.IsLoopback()) {
			return nil, ErrProvider
		}
	}
	d := net.Dialer{Timeout: 10 * time.Second, KeepAlive: 30 * time.Second}
	return d.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
}

var providerHTTP = &http.Client{
	Transport: &http.Transport{
		DialContext:            guardedDial,
		TLSHandshakeTimeout:    10 * time.Second,
		ResponseHeaderTimeout:  30 * time.Second,
		MaxResponseHeaderBytes: 64 << 10,
		MaxIdleConns:           32,
		MaxIdleConnsPerHost:    8,
		IdleConnTimeout:        90 * time.Second,
	},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

func timeoutSeconds(n int) (time.Duration, error) {
	if n == 0 {
		n = 30
	}
	if n < 1 || n > 300 {
		return 0, fmt.Errorf("%w: timeout must be 1..300 seconds", ErrInvalidConfig)
	}
	return time.Duration(n) * time.Second, nil
}

// postJSON 限制传输大小和时长；上游错误体与 URL 不进入公开错误消息。
func postJSON(ctx context.Context, target string, timeout int, headers map[string]string, body, dst any) error {
	duration, err := timeoutSeconds(timeout)
	if err != nil {
		return err
	}
	raw, err := providerutils.MarshalSorted(body)
	if err != nil || len(raw) > maxContentBytes {
		return fmt.Errorf("%w: request exceeds content limit or cannot be encoded", ErrInvalidInput)
	}
	ctx, cancel := context.WithTimeout(ctx, duration)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(raw))
	if err != nil {
		return ErrInvalidConfig
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := providerHTTP.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("%w: %w", ErrProvider, ctx.Err())
		}
		return ErrProvider
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("%w: HTTP status %d", ErrProvider, resp.StatusCode)
	}
	ct, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	if err != nil || (ct != "application/json" && !strings.HasSuffix(ct, "+json")) {
		return fmt.Errorf("%w: expected JSON content type", ErrInvalidResponse)
	}
	raw, err = io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil || len(raw) > maxResponseBytes || !utf8.Valid(raw) || !validObject(raw) {
		return fmt.Errorf("%w: malformed or oversized JSON body", ErrInvalidResponse)
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("%w: invalid protocol field type", ErrInvalidResponse)
	}
	return nil
}
