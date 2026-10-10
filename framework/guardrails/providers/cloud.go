package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/policy"
	"github.com/Azure/azure-sdk-for-go/sdk/azidentity"
	providerutils "github.com/maximhq/bifrost/core/providers/utils"
)

// NewCloudAdapters 返回已实现云端协议的注册表，供宿主与其他适配器组合。
func NewCloudAdapters() map[string]Adapter {
	pii := textCapabilities()
	pii.CanRedact = true
	mutating := textCapabilities()
	mutating.Transforms = true
	return map[string]Adapter{
		"azure-pii":   functionalAdapter{validateAzurePII, evaluateAzurePII, pii},
		"azure":       functionalAdapter{validateAzureContentSafety, evaluateAzureContentSafety, textCapabilities()},
		"bedrock":     functionalAdapter{validateBedrockGuardrail, evaluateBedrockGuardrail, mutating},
		"model-armor": functionalAdapter{validateModelArmor, evaluateModelArmor, mutating},
	}
}

type cloudAzureAuth struct {
	Endpoint     string   `json:"endpoint"`
	AuthType     string   `json:"auth_type,omitempty"`
	APIKey       string   `json:"api_key,omitempty"`
	ClientID     string   `json:"client_id,omitempty"`
	ClientSecret string   `json:"client_secret,omitempty"`
	TenantID     string   `json:"tenant_id,omitempty"`
	Scopes       []string `json:"scopes,omitempty"`
	Timeout      int      `json:"timeout,omitempty"`
}

// cloudValue 展开非秘密配置引用；不在错误中返回环境内容。
func cloudValue(value string) (string, error) {
	if strings.HasPrefix(value, "env.") {
		if !envName.MatchString(value) {
			return "", ErrInvalidConfig
		}
		value = os.Getenv(strings.TrimPrefix(value, "env."))
	}
	if value == "" || strings.TrimSpace(value) != value || strings.ContainsAny(value, "\r\n") {
		return "", ErrInvalidConfig
	}
	return value, nil
}

// validateCloudAzureAuth 先拒绝未知认证模式和混合凭据，再验证地址与环境引用。
func validateCloudAzureAuth(c *cloudAzureAuth) error {
	if c.AuthType == "" {
		c.AuthType = "api_key"
	}
	switch c.AuthType {
	case "api_key":
		if c.ClientID != "" || c.ClientSecret != "" || c.TenantID != "" || len(c.Scopes) != 0 {
			return ErrInvalidConfig
		}
		if _, err := secret(c.APIKey); err != nil {
			return err
		}
	case "entra_id":
		if c.APIKey != "" {
			return ErrInvalidConfig
		}
		if _, err := cloudValue(c.ClientID); err != nil {
			return err
		}
		if _, err := cloudValue(c.TenantID); err != nil {
			return err
		}
		if _, err := secret(c.ClientSecret); err != nil {
			return err
		}
	case "default_credential":
		if c.APIKey != "" || c.ClientID != "" || c.ClientSecret != "" || c.TenantID != "" {
			return ErrInvalidConfig
		}
	default:
		return fmt.Errorf("%w: unsupported Azure auth_type", ErrInvalidConfig)
	}
	for _, scope := range c.Scopes {
		if scope == "" || strings.TrimSpace(scope) != scope || strings.ContainsAny(scope, "\r\n") {
			return ErrInvalidConfig
		}
	}
	if _, err := cloudValue(c.Endpoint); err != nil {
		return err
	}
	if _, err := cloudEndpoint(c.Endpoint, "", "", true); err != nil {
		return err
	}
	_, err := timeoutSeconds(c.Timeout)
	return err
}

// cloudAzureHeaders 使用现有 Azure 身份 SDK 获取令牌，SDK 原始错误不越过适配器边界。
func cloudAzureHeaders(ctx context.Context, c cloudAzureAuth) (map[string]string, error) {
	if c.AuthType == "api_key" {
		key, err := secret(c.APIKey)
		if err != nil {
			return nil, err
		}
		return map[string]string{"Ocp-Apim-Subscription-Key": key}, nil
	}
	var credential azcore.TokenCredential
	var err error
	options := azcore.ClientOptions{Transport: cloudIdentityHTTP}
	switch c.AuthType {
	case "entra_id":
		client, e := cloudValue(c.ClientID)
		if e != nil {
			return nil, e
		}
		tenant, e := cloudValue(c.TenantID)
		if e != nil {
			return nil, e
		}
		key, e := secret(c.ClientSecret)
		if e != nil {
			return nil, e
		}
		credential, err = azidentity.NewClientSecretCredential(tenant, client, key,
			&azidentity.ClientSecretCredentialOptions{ClientOptions: options})
	case "default_credential":
		credential, err = azidentity.NewDefaultAzureCredential(
			&azidentity.DefaultAzureCredentialOptions{ClientOptions: options})
	default:
		return nil, ErrInvalidConfig
	}
	if err != nil {
		return nil, fmt.Errorf("%w: Azure credential initialization failed", ErrProvider)
	}
	scopes := c.Scopes
	if len(scopes) == 0 {
		scopes = []string{"https://cognitiveservices.azure.com/.default"}
	}
	token, err := credential.GetToken(ctx, policy.TokenRequestOptions{Scopes: scopes})
	if err != nil || token.Token == "" || strings.ContainsAny(token.Token, "\r\n") {
		return nil, fmt.Errorf("%w: Azure authentication failed", ErrProvider)
	}
	return map[string]string{"Authorization": "Bearer " + token.Token}, nil
}

type cloudItem struct {
	Text  string
	Index int
}

// cloudItems 保留每份原文的唯一索引，工具参数和只读上下文单独筛查但禁止改写。
func cloudItems(in Input) ([]cloudItem, error) {
	messages, err := prepare(in, textCapabilities())
	if err != nil {
		return nil, err
	}
	items := make([]cloudItem, 0, len(in.Texts))
	total := 0
	add := func(text string, index int) error {
		if text == "" {
			return nil
		}
		if !utf8.ValidString(text) || len(text) > maxContentBytes-total {
			return ErrInvalidInput
		}
		total += len(text)
		items = append(items, cloudItem{Text: text, Index: index})
		return nil
	}
	for _, m := range messages {
		index := -1
		if m.TextIndex != nil {
			index = *m.TextIndex
		}
		if err := add(m.Content, index); err != nil {
			return nil, err
		}
		for _, call := range m.ToolCalls {
			encoded, err := providerutils.MarshalSorted(call.Function)
			if err != nil {
				return nil, ErrInvalidInput
			}
			if err := add(string(encoded), -1); err != nil {
				return nil, err
			}
		}
	}
	for _, tool := range in.Tools {
		raw, err := providerutils.MarshalSorted(tool)
		if err != nil {
			return nil, ErrInvalidInput
		}
		if err := add(string(raw), -1); err != nil {
			return nil, err
		}
	}
	if len(items) == 0 {
		return nil, ErrInvalidInput
	}
	return items, nil
}

// cloudRewrite 仅改写本次请求的完整原始文本，不能用厂商输出覆盖工具参数或历史。
func cloudRewrite(item cloudItem, replacement string) Result {
	if item.Index < 0 || replacement == item.Text || !utf8.ValidString(replacement) ||
		len(replacement) > maxContentBytes {
		return Result{Blocked: true, Reason: "cloud transformation cannot be mapped safely"}
	}
	return Result{Rewrites: []Rewrite{{Index: item.Index, Original: item.Text, Replacement: replacement}},
		Reason: "cloud provider transformed content"}
}

var cloudResourceSegment = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$`)

// cloudContext 给身份解析与多次云调用共同施加总超时，而不是逐次无限累加。
func cloudContext(ctx context.Context, timeout int) (context.Context, context.CancelFunc, error) {
	duration, err := timeoutSeconds(timeout)
	if err != nil {
		return nil, nil, err
	}
	child, cancel := context.WithTimeout(ctx, duration)
	return child, cancel, nil
}

// cloudJSONField 以结构化类型读取必要字段，不对上游实体或错误文本做公开回显。
func cloudJSONField(raw json.RawMessage, dst any) error {
	if len(raw) == 0 || string(raw) == "null" || json.Unmarshal(raw, dst) != nil {
		return ErrInvalidResponse
	}
	return nil
}

// cloudEndpoint 复用共享 URL 校验，仅为显式私网 IP 部署允许 HTTP；域名仍必须使用 HTTPS。
func cloudEndpoint(base, fallback, suffix string, originOnly bool) (string, error) {
	if strings.HasPrefix(base, "env.") {
		value, err := cloudValue(base)
		if err != nil {
			return "", err
		}
		base = value
	}
	if base == "" {
		base = fallback
	}
	u, err := url.Parse(base)
	if err != nil {
		return "", ErrInvalidConfig
	}
	ip, ipErr := netip.ParseAddr(u.Hostname())
	privateHTTP := u.Scheme == "http" && ipErr == nil && ip.Unmap().IsPrivate() && !forbiddenIP(ip)
	if privateHTTP {
		u.Scheme = "https"
	}
	target, err := endpoint(u.String(), "", suffix, originOnly)
	if err != nil || !privateHTTP {
		return target, err
	}
	u, err = url.Parse(target)
	if err != nil {
		return "", ErrInvalidConfig
	}
	u.Scheme = "http"
	return u.String(), nil
}

type cloudIdentityTransport struct{}

// RoundTrip 在凭据 SDK 的每次实际请求上校验目标，不能借认证配置泄露凭据到元数据地址。
func (cloudIdentityTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.URL == nil || req.URL.User != nil {
		return nil, ErrProvider
	}
	if _, err := cloudEndpoint(req.URL.Scheme+"://"+req.URL.Host, "", "", true); err != nil {
		return nil, ErrProvider
	}
	return providerHTTP.Transport.RoundTrip(req)
}

var cloudIdentityHTTP = &http.Client{
	Transport:     cloudIdentityTransport{},
	CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
}

type cloudSDKHTTP struct{}

func (cloudSDKHTTP) Do(req *http.Request) (*http.Response, error) {
	return cloudIdentityHTTP.Do(req)
}
