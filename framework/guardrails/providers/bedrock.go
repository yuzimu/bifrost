package providers

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/arn"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/credentials/stscreds"
	"github.com/aws/aws-sdk-go-v2/service/bedrockruntime"
	bedrocktypes "github.com/aws/aws-sdk-go-v2/service/bedrockruntime/types"
	"github.com/aws/aws-sdk-go-v2/service/sts"
	"github.com/aws/smithy-go/auth/bearer"
)

type BedrockGuardrailConfig struct {
	AuthType         string `json:"auth_type,omitempty"`
	AccessKey        string `json:"access_key,omitempty"`
	SecretKey        string `json:"secret_key,omitempty"`
	SessionToken     string `json:"session_token,omitempty"`
	BedrockAPIKey    string `json:"bedrock_api_key,omitempty"`
	RoleARN          string `json:"role_arn,omitempty"`
	ExternalID       string `json:"external_id,omitempty"`
	SessionName      string `json:"session_name,omitempty"`
	GuardrailARN     string `json:"guardrail_arn"`
	GuardrailVersion string `json:"guardrail_version"`
	Region           string `json:"region,omitempty"`
	ImagesEnabled    *bool  `json:"images_enabled,omitempty"`
	Timeout          int    `json:"timeout,omitempty"`
}

var bedrockVersion = regexp.MustCompile(`^(DRAFT|[1-9][0-9]{0,7})$`)
var bedrockRegion = regexp.MustCompile(`^[a-z]{2}(-[a-z0-9]+)+-[0-9]+$`)
var bedrockAccount = regexp.MustCompile(`^[0-9]{12}$`)
var bedrockSession = regexp.MustCompile(`^[A-Za-z0-9_+=,.@-]{2,64}$`)

// loadBedrockGuardrail 明确认证来源并从完整 ARN 派生区域，拒绝未接入的图像能力。
func loadBedrockGuardrail(raw json.RawMessage) (BedrockGuardrailConfig, error) {
	var c BedrockGuardrailConfig
	if err := decodeConfig(raw, &c); err != nil {
		return c, err
	}
	var err error
	c.GuardrailARN, err = cloudValue(c.GuardrailARN)
	if err != nil {
		return c, err
	}
	c.GuardrailVersion, err = cloudValue(c.GuardrailVersion)
	if err != nil {
		return c, err
	}
	parsed, err := arn.Parse(c.GuardrailARN)
	if err != nil || parsed.Service != "bedrock" || !bedrockAccount.MatchString(parsed.AccountID) ||
		!strings.HasPrefix(parsed.Resource, "guardrail/") ||
		!cloudResourceSegment.MatchString(strings.TrimPrefix(parsed.Resource, "guardrail/")) ||
		!bedrockVersion.MatchString(c.GuardrailVersion) {
		return c, ErrInvalidConfig
	}
	switch parsed.Partition {
	case "aws", "aws-us-gov", "aws-cn":
	default:
		return c, ErrInvalidConfig
	}
	if c.Region == "" {
		c.Region = parsed.Region
	} else {
		c.Region, err = cloudValue(c.Region)
		if err != nil {
			return c, err
		}
	}
	if !bedrockRegion.MatchString(c.Region) || c.Region != parsed.Region {
		return c, fmt.Errorf("%w: guardrail ARN region mismatch", ErrInvalidConfig)
	}
	if c.ImagesEnabled == nil || *c.ImagesEnabled {
		return c, fmt.Errorf("%w: images_enabled must be false until host supplies images", ErrInvalidConfig)
	}
	if c.AuthType == "" {
		switch {
		case c.BedrockAPIKey != "":
			c.AuthType = "api_key"
		case c.AccessKey != "" || c.SecretKey != "":
			c.AuthType = "keys"
		default:
			c.AuthType = "iam_role"
		}
	}
	switch c.AuthType {
	case "keys":
		if c.BedrockAPIKey != "" {
			return c, ErrInvalidConfig
		}
		if _, err := secret(c.AccessKey); err != nil {
			return c, err
		}
		if _, err := secret(c.SecretKey); err != nil {
			return c, err
		}
		if c.SessionToken != "" {
			if _, err := secret(c.SessionToken); err != nil {
				return c, err
			}
		}
	case "api_key":
		if c.AccessKey != "" || c.SecretKey != "" || c.SessionToken != "" || c.RoleARN != "" {
			return c, ErrInvalidConfig
		}
		if _, err := secret(c.BedrockAPIKey); err != nil {
			return c, err
		}
	case "iam_role":
		if c.AccessKey != "" || c.SecretKey != "" || c.SessionToken != "" || c.BedrockAPIKey != "" {
			return c, ErrInvalidConfig
		}
	default:
		return c, fmt.Errorf("%w: unsupported Bedrock auth_type", ErrInvalidConfig)
	}
	if c.RoleARN == "" && (c.ExternalID != "" || c.SessionName != "") {
		return c, ErrInvalidConfig
	}
	if c.RoleARN != "" {
		c.RoleARN, err = cloudValue(c.RoleARN)
		if err != nil {
			return c, err
		}
		role, e := arn.Parse(c.RoleARN)
		if e != nil || role.Service != "iam" || role.Partition != parsed.Partition ||
			!bedrockAccount.MatchString(role.AccountID) || !strings.HasPrefix(role.Resource, "role/") ||
			len(strings.TrimPrefix(role.Resource, "role/")) == 0 {
			return c, ErrInvalidConfig
		}
	}
	if c.ExternalID != "" {
		if _, err := secret(c.ExternalID); err != nil {
			return c, err
		}
	}
	if c.SessionName != "" {
		c.SessionName, err = cloudValue(c.SessionName)
		if err != nil || !bedrockSession.MatchString(c.SessionName) {
			return c, ErrInvalidConfig
		}
	}
	_, err = timeoutSeconds(c.Timeout)
	return c, err
}

func validateBedrockGuardrail(raw json.RawMessage) error {
	_, err := loadBedrockGuardrail(raw)
	return err
}

// bedrockGuardrailClient 复用 AWS SDK 默认凭据链、STS 和 Bearer 认证，不保留明文配置。
func bedrockGuardrailClient(ctx context.Context, c BedrockGuardrailConfig) (*bedrockruntime.Client, error) {
	options := []func(*awsconfig.LoadOptions) error{
		awsconfig.WithRegion(c.Region), awsconfig.WithHTTPClient(cloudSDKHTTP{}),
		awsconfig.WithRetryMaxAttempts(1),
	}
	if c.AuthType == "keys" {
		access, err := secret(c.AccessKey)
		if err != nil {
			return nil, err
		}
		key, err := secret(c.SecretKey)
		if err != nil {
			return nil, err
		}
		session := ""
		if c.SessionToken != "" {
			session, err = secret(c.SessionToken)
			if err != nil {
				return nil, err
			}
		}
		options = append(options, awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(access, key, session)))
	}
	if c.AuthType == "api_key" {
		options = append(options, awsconfig.WithCredentialsProvider(aws.AnonymousCredentials{}))
	}
	cfg, err := awsconfig.LoadDefaultConfig(ctx, options...)
	if err != nil {
		return nil, fmt.Errorf("%w: AWS credential initialization failed", ErrProvider)
	}
	cfg.ClientLogMode = 0
	if c.RoleARN != "" {
		external := ""
		if c.ExternalID != "" {
			external, err = secret(c.ExternalID)
			if err != nil {
				return nil, err
			}
		}
		cfg.Credentials = aws.NewCredentialsCache(stscreds.NewAssumeRoleProvider(sts.NewFromConfig(cfg), c.RoleARN,
			func(o *stscreds.AssumeRoleOptions) {
				if external != "" {
					o.ExternalID = aws.String(external)
				}
				if c.SessionName != "" {
					o.RoleSessionName = c.SessionName
				}
			}))
	}
	return bedrockruntime.NewFromConfig(cfg, func(o *bedrockruntime.Options) {
		o.HTTPClient = cloudSDKHTTP{}
		if c.AuthType == "api_key" {
			o.BearerAuthTokenProvider = bearer.TokenProviderFunc(func(context.Context) (bearer.Token, error) {
				key, err := secret(c.BedrockAPIKey)
				return bearer.Token{Value: key}, err
			})
			o.AuthSchemePreference = []string{"smithy.api#httpBearerAuth"}
		} else {
			o.AuthSchemePreference = []string{"aws.auth#sigv4"}
			o.BearerAuthTokenProvider = nil
		}
	}), nil
}

// bedrockAnonymization 仅接受纯敏感数据匿名化；任何阻断、未知动作或其他干预均不可改写放行。
func bedrockAnonymization(assessments []bedrocktypes.GuardrailAssessment) bool {
	found := false
	for _, a := range assessments {
		if a.AutomatedReasoningPolicy != nil && len(a.AutomatedReasoningPolicy.Findings) != 0 {
			return false
		}
		if a.ContentPolicy != nil {
			for _, f := range a.ContentPolicy.Filters {
				if string(f.Action) != "NONE" {
					return false
				}
			}
		}
		if a.ContextualGroundingPolicy != nil {
			for _, f := range a.ContextualGroundingPolicy.Filters {
				if string(f.Action) != "NONE" {
					return false
				}
			}
		}
		if a.TopicPolicy != nil {
			for _, f := range a.TopicPolicy.Topics {
				if string(f.Action) != "NONE" {
					return false
				}
			}
		}
		if a.WordPolicy != nil {
			for _, f := range a.WordPolicy.CustomWords {
				if string(f.Action) != "NONE" {
					return false
				}
			}
			for _, f := range a.WordPolicy.ManagedWordLists {
				if string(f.Action) != "NONE" {
					return false
				}
			}
		}
		if a.SensitiveInformationPolicy == nil {
			continue
		}
		accept := func(action bedrocktypes.GuardrailSensitiveInformationPolicyAction, detected *bool) bool {
			switch action {
			case bedrocktypes.GuardrailSensitiveInformationPolicyActionNone:
				return true
			case bedrocktypes.GuardrailSensitiveInformationPolicyActionAnonymized:
				if detected != nil && !*detected {
					return false
				}
				found = true
				return true
			default:
				return false
			}
		}
		for _, f := range a.SensitiveInformationPolicy.PiiEntities {
			if !accept(f.Action, f.Detected) {
				return false
			}
		}
		for _, f := range a.SensitiveInformationPolicy.Regexes {
			if !accept(f.Action, f.Detected) {
				return false
			}
		}
	}
	return found
}

// evaluateBedrockGuardrail 一次只提交一份原文，SDK 输出因而只能回写该原文的唯一索引。
func evaluateBedrockGuardrail(ctx context.Context, raw json.RawMessage, in Input) (Result, error) {
	c, err := loadBedrockGuardrail(raw)
	if err != nil {
		return Result{}, err
	}
	items, err := cloudItems(in)
	if err != nil {
		return Result{}, err
	}
	ctx, cancel, err := cloudContext(ctx, c.Timeout)
	if err != nil {
		return Result{}, err
	}
	defer cancel()
	client, err := bedrockGuardrailClient(ctx, c)
	if err != nil {
		return Result{}, err
	}
	source := bedrocktypes.GuardrailContentSourceInput
	if in.Phase == "output" {
		source = bedrocktypes.GuardrailContentSourceOutput
	}
	result := Result{Reason: "Bedrock Guardrails allowed content"}
	for _, item := range items {
		out, err := client.ApplyGuardrail(ctx, &bedrockruntime.ApplyGuardrailInput{
			GuardrailIdentifier: aws.String(c.GuardrailARN), GuardrailVersion: aws.String(c.GuardrailVersion),
			Source: source, Content: []bedrocktypes.GuardrailContentBlock{
				&bedrocktypes.GuardrailContentBlockMemberText{Value: bedrocktypes.GuardrailTextBlock{Text: aws.String(item.Text)}},
			},
		})
		if err != nil {
			return Result{}, fmt.Errorf("%w: Bedrock guardrail invocation failed", ErrProvider)
		}
		if out == nil || out.Usage == nil || len(out.Assessments) == 0 {
			return Result{}, ErrInvalidResponse
		}
		switch out.Action {
		case bedrocktypes.GuardrailActionNone:
			if len(out.Outputs) != 0 {
				if len(out.Outputs) != 1 || out.Outputs[0].Text == nil || *out.Outputs[0].Text != item.Text {
					return Result{}, ErrInvalidResponse
				}
			}
		case bedrocktypes.GuardrailActionGuardrailIntervened:
			if !bedrockAnonymization(out.Assessments) || len(out.Outputs) != 1 || out.Outputs[0].Text == nil {
				return Result{Blocked: true, Reason: "Bedrock Guardrails blocked content"}, nil
			}
			rewrite := cloudRewrite(item, *out.Outputs[0].Text)
			if rewrite.Blocked {
				return rewrite, nil
			}
			result.Rewrites = append(result.Rewrites, rewrite.Rewrites...)
			result.Reason = rewrite.Reason
		default:
			return Result{}, ErrInvalidResponse
		}
	}
	return result, nil
}
