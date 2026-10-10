package guardrails

// PIITemplate 返回公开文档中的五条 RE2 模板，动作和脱敏设置由调用方明确指定。
func PIITemplate(action, strategy, mode string) RegexConfig {
	patterns := []Pattern{
		{Pattern: `\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`, Description: "Email address", EntityType: "EMAIL", Flags: "i"},
		{Pattern: `\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b`, Description: "US phone number", EntityType: "PHONE_NUMBER"},
		{Pattern: `\b\d{3}-\d{2}-\d{4}\b`, Description: "US Social Security Number", EntityType: "US_SSN"},
		{Pattern: `\b(?:\d[ -]?){13,19}\b`, Description: "Credit card-like number", EntityType: "CREDIT_CARD"},
		{Pattern: `\b(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}\b`, Description: "IPv4 address", EntityType: "IP_ADDRESS"},
	}
	for i := range patterns {
		patterns[i].Action, patterns[i].RedactionStrategy, patterns[i].RedactionMode = action, strategy, mode
	}
	return RegexConfig{Patterns: patterns}
}
