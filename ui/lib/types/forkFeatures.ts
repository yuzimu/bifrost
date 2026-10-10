export type GuardrailAction = "block" | "redact" | "detect_only";
export type GuardrailPhase = "input" | "output" | "both";
export type GuardrailTarget = "llm" | "mcp";
export interface GuardrailPattern {
	pattern: string;
	description?: string;
	entity_type?: string;
	flags?: string;
	action?: GuardrailAction;
	redaction_strategy?: string;
	redaction_mode?: string;
}
export interface GuardrailProfileConfig {
	patterns?: GuardrailPattern[];
	ignored_secret_keywords?: string[];
	action?: GuardrailAction;
	redaction_strategy?: string;
	redaction_mode?: string;
	judge_provider?: string;
	judge_model?: string;
	rule?: string;
	prompt_template?: string;
	timeout?: number;
	max_output_tokens?: number;
	analyzer_url?: string;
	api_key?: string;
	language?: string;
	entities?: string[];
	score_threshold?: number;
	base_url?: string;
	endpoint?: string;
	auth_type?: string;
	client_id?: string;
	client_secret?: string;
	tenant_id?: string;
	scopes?: string[];
	project_id?: string;
	app_id?: string;
	collector_instance_id?: string;
	asset_id?: string;
	policy_id?: string;
	policy_ids?: string[];
	rules?: Record<string, string>;
	violation_threshold?: number;
	reasoning_mode?: string;
	evaluators?: { evaluator: string; criteria?: string; explain_strategy?: string }[];
	capture?: string;
	api_version?: string;
	model_version?: string;
	domain?: string;
	pii_categories?: string[];
	logging_opt_out?: boolean;
	string_index_type?: string;
	analyze_enabled?: boolean;
	analyze_severity_threshold?: string;
	jailbreak_shield_enabled?: boolean;
	indirect_attack_shield_enabled?: boolean;
	copyright_enabled?: boolean;
	text_blocklist_enabled?: boolean;
	blocklist_names?: string[];
	access_key?: string;
	secret_key?: string;
	session_token?: string;
	bedrock_api_key?: string;
	role_arn?: string;
	external_id?: string;
	session_name?: string;
	guardrail_arn?: string;
	guardrail_version?: string;
	region?: string;
	images_enabled?: boolean;
	location?: string;
	template_id?: string;
	service_account_json?: string;
}
export interface GuardrailProfile extends GuardrailProfileConfig {
	id: number;
	name: string;
	enabled: boolean;
}
export interface GuardrailProvider {
	name: string;
	configs: GuardrailProfile[];
}
export interface GuardrailCapability {
	name: string;
	actions: GuardrailAction[];
	local: boolean;
}
export interface GuardrailRule {
	id: number;
	name: string;
	description?: string;
	enabled: boolean;
	target: GuardrailTarget;
	celExpression: string;
	applyTo: GuardrailPhase;
	samplingRate: number;
	timeout: number;
	selectedGuardrailProfiles: string[];
	sendAllConversationTurns?: boolean;
	maxTurnsToSend?: number;
	evaluationMode?: "bundled" | "per_turn";
	streamReplayEventIntervalMs?: number;
}
export type GuardrailRuleInput = Omit<GuardrailRule, "id">;
export interface GuardrailEvaluationRequest {
	text: string;
	target: GuardrailTarget;
	phase: "input" | "output";
}
export interface GuardrailEvaluationResult {
	blocked: boolean;
	reason?: string;
	texts: string[] | null;
	metadata?: {
		detections?: {
			phase?: string;
			rule_id?: number;
			rule_name?: string;
			guardrail_name?: string;
			guardrail_provider?: string;
			assessments?: string[];
		}[];
	};
}
export interface AdaptiveConfig {
	direction_selection_enabled: boolean;
	route_selection_enabled: boolean;
	append_fallbacks_to_pinned: boolean;
	reroute_failed_directions: boolean;
	prune_failed_fallbacks: boolean;
}
export interface AdaptiveMetric {
	provider: string;
	model: string;
	key_id?: string;
	state: "Healthy" | "Degraded" | "Failed" | "Recovering";
	latency_per_100_tokens_ms: number;
	error_rate: number;
	tokens_per_second: number;
	adaptive_factor: number;
	requests: number;
	errors: number;
	last_seen: string;
}
export interface HeldKey {
	provider: string;
	model?: string;
	key_id: string;
	failure_class: string;
	held_at: string;
	check_due_at: string;
	checking: boolean;
}
export interface AdaptiveSnapshot {
	routes: AdaptiveMetric[];
	held_keys: HeldKey[];
	circuits: Record<string, CircuitState>;
}
export interface ReleaseHoldRequest {
	provider?: string;
	key_id?: string;
	model?: string;
}
export interface CircuitSignal {
	source: "response_header";
	header_name: string;
	header_value?: string;
	header_contains?: string;
}
export interface CircuitPolicy {
	name: string;
	enabled: boolean;
	primary_provider: string;
	primary_model: string;
	primary_key_ids: string[];
	fallback_provider: string;
	fallback_model: string;
	condition: {
		operator?: "OR" | "AND";
		signals?: CircuitSignal[];
	};
	default_cooldown: string;
	cooldown_header?: string;
}
export interface CircuitState {
	status: "closed" | "open";
	opened_at?: string;
	expires_at?: string;
	cooldown: number;
}
export type CircuitPolicyResponse = Omit<CircuitPolicy, "default_cooldown"> & { default_cooldown: number };