import { KnownProvidersNames } from "@/lib/constants/logs";
import { isRedacted } from "@/lib/utils/validation";
import { z } from "zod";
import i18n from "@/lib/i18n";
import type { TFunction } from "i18next";

/** 在校验时读取当前语言，避免模块加载时冻结错误文案。 */
export const schemaMessage = (key: string, defaultValue: string, values?: Record<string, unknown>) =>
	i18n.t(`schemaUi.${key}`, { ns: "models", defaultValue, ...values });

/** 共享配置校验在执行时取文案，不改变各 schema 的输入输出。 */
const configSchemaMessage = (key: string) => i18n.t(`validation.${key}`, { ns: "config" });

// Global error map - turns Zod's default messages into readable, human-friendly ones.
// Individual schemas can still override by passing their own message.
z.config({
	/** 已知字段沿用定制消息，其余中文错误交给 Zod 内置 locale 格式化。 */
	customError: (issue) => {
		if (issue.code === "invalid_type") {
			// Field is missing / undefined
			if (issue.input === undefined || issue.input === null) {
				return schemaMessage("required", "This field is required");
			}
			const expected = issue.expected;
			const received = typeof issue.input;
			if (expected === "number") return schemaMessage("number", "Must be a valid number");
			if (expected === "string") return schemaMessage("text", "Must be a valid text value");
			if (expected === "boolean") return schemaMessage("boolean", "Must be true or false");
			return schemaMessage("type", "Expected {{expected}}, received {{received}}", { expected, received });
		}
		if (issue.code === "too_small") {
			if (issue.origin === "string" && issue.minimum === 1) {
				return schemaMessage("required", "This field is required");
			}
			if (issue.origin === "number") {
				return schemaMessage("minimum", "Must be at least {{min}}", { min: issue.minimum });
			}
			if (issue.origin === "array" && issue.minimum === 1) {
				return schemaMessage("oneItem", "At least one item is required");
			}
		}
		if (issue.code === "too_big") {
			if (issue.origin === "number") {
				return schemaMessage("maximum", "Must be at most {{max}}", { max: issue.maximum });
			}
			if (issue.origin === "string") {
				return schemaMessage("maxCharacters", "Must be at most {{max}} characters", { max: issue.maximum });
			}
		}
		if (issue.code === "invalid_format") {
			if (issue.format === "url") return schemaMessage("url", "Must be a valid URL");
			if (issue.format === "email") return schemaMessage("email", "Must be a valid email");
		}
		if ((i18n.resolvedLanguage ?? i18n.language) === "zh-CN") {
			return z.locales.zhCN().localeError(issue);
		}
		return undefined;
	},
});

// Base Zod schemas matching the TypeScript types

// Known provider schema
export const knownProviderSchema = z.enum(KnownProvidersNames as unknown as [string, ...string[]]);

// Custom provider name schema (branded type simulation)
export const customProviderNameSchema = z.string().min(1, { error: () => configSchemaMessage("customProviderName") });

// Model provider name schema (union of known and custom providers)
export const modelProviderNameSchema = z.union([knownProviderSchema, customProviderNameSchema]);

// SecretVar schema - matches the Go SecretVar type from schemas/secretvar.go
export const _secretVarBase = z.object({
	value: z.string().optional(),
	ref: z.string().optional(),
	type: z.enum(["plain_text", "env", "vault"]).optional(),
});

// Extending the base schema
export const secretVarSchema = Object.assign(_secretVarBase, {
	required: (message: string) => _secretVarBase.refine((v) => !!v?.value?.trim() || !!v?.ref?.trim(), message),
});

// Helper to check if a secretVar field has a value or secret reference
function isSecretVarSet(v: { value?: string; ref?: string } | undefined): boolean {
	if (!v) return false;
	return !!v.value?.trim() || !!v.ref?.trim();
}

// Azure key config schema
export const azureKeyConfigSchema = z
	.object({
		_auth_type: z.enum(["api_key", "entra_id", "default_credential"]).optional(),
		endpoint: secretVarSchema.optional(),
		client_id: secretVarSchema.optional(),
		client_secret: secretVarSchema.optional(),
		tenant_id: secretVarSchema.optional(),
		scopes: z.array(z.string()).optional(),
	})
	.refine((data) => isSecretVarSet(data.endpoint), {
		error: () => configSchemaMessage("endpoint"),
		path: ["endpoint"],
	})
	.refine(
		(data) => {
			// When using Entra ID, all three fields are required
			if (data._auth_type === "entra_id") {
				return isSecretVarSet(data.client_id) && isSecretVarSet(data.client_secret) && isSecretVarSet(data.tenant_id);
			}
			// Otherwise, if any Entra ID field is set, all three must be set
			const hasClientId = isSecretVarSet(data.client_id);
			const hasClientSecret = isSecretVarSet(data.client_secret);
			const hasTenantId = isSecretVarSet(data.tenant_id);
			const anyEntraField = hasClientId || hasClientSecret || hasTenantId;
			if (!anyEntraField) return true;
			return hasClientId && hasClientSecret && hasTenantId;
		},
		{
			error: () => configSchemaMessage("entraCredentials"),
			path: ["client_id"],
		},
	);

// Vertex AWS Workload Identity Federation block. The audience is the only mandatory field; the
// service account, region and role hop are optional refinements of the exchange.
export const vertexAWSWorkloadIdentitySchema = z.object({
	audience: secretVarSchema.optional(),
	service_account_email: secretVarSchema.optional(),
	token_lifetime_seconds: z
		.number()
		.int({ error: () => configSchemaMessage("tokenLifetimeWhole") })
		.min(600, { error: () => configSchemaMessage("tokenLifetimeMin") })
		.max(43200, { error: () => configSchemaMessage("tokenLifetimeMax") })
		.optional(),
	aws_region: secretVarSchema.optional(),
	aws_role_arn: secretVarSchema.optional(),
});

// Vertex key config schema
export const vertexKeyConfigSchema = z
	.object({
		_auth_type: z.enum(["service_account", "service_account_json", "api_key", "aws_workload_identity"]).optional(),
		project_id: secretVarSchema.optional(),
		project_number: secretVarSchema.optional(),
		region: secretVarSchema.optional(),
		auth_credentials: secretVarSchema.optional(),
		force_single_region: z.boolean().optional(),
		aws_workload_identity: vertexAWSWorkloadIdentitySchema.optional(),
	})
	.refine((data) => isSecretVarSet(data.project_id), {
		error: () => configSchemaMessage("projectId"),
		path: ["project_id"],
	})
	.refine((data) => isSecretVarSet(data.region), {
		error: () => configSchemaMessage("region"),
		path: ["region"],
	})
	.refine(
		(data) => {
			// When using service_account_json auth, auth_credentials is required
			if (data._auth_type === "service_account_json") {
				return isSecretVarSet(data.auth_credentials);
			}
			return true;
		},
		{
			error: () => configSchemaMessage("serviceAccountCredentials"),
			path: ["auth_credentials"],
		},
	)
	.refine(
		(data) => {
			// The federation tab hides every other credential input, so the audience is what
			// makes the key usable; without it the key would silently fall back to ADC.
			if (data._auth_type === "aws_workload_identity") {
				return isSecretVarSet(data.aws_workload_identity?.audience);
			}
			return true;
		},
		{
			error: () => configSchemaMessage("workloadAudience"),
			path: ["aws_workload_identity", "audience"],
		},
	)
	.refine(
		(data) => {
			// Federation and a credentials JSON are two different identities; never send both.
			if (isSecretVarSet(data.aws_workload_identity?.audience)) {
				return !isSecretVarSet(data.auth_credentials);
			}
			return true;
		},
		{
			error: () => configSchemaMessage("workloadCredentialsConflict"),
			path: ["auth_credentials"],
		},
	);

// S3 bucket configuration for Bedrock batch operations
export const s3BucketConfigSchema = z.object({
	bucket_name: z.string().min(1, { error: () => configSchemaMessage("bucketName") }),
	prefix: z.string().optional(),
	is_default: z.boolean().optional(),
});

export const batchS3ConfigSchema = z.object({
	buckets: z.array(s3BucketConfigSchema).optional(),
});

// Interface VPC endpoint hosts, one per AWS endpoint service Bifrost dials for Bedrock.
export const bedrockEndpointsSchema = z.object({
	runtime: secretVarSchema.optional(),
	control_plane: secretVarSchema.optional(),
	mantle: secretVarSchema.optional(),
	agent_runtime: secretVarSchema.optional(),
	s3: secretVarSchema.optional(),
});

// Bedrock key config schema
export const bedrockKeyConfigSchema = z
	.object({
		_auth_type: z.enum(["iam_role", "explicit", "api_key"]).optional(),
		access_key: secretVarSchema.optional(),
		secret_key: secretVarSchema.optional(),
		session_token: secretVarSchema.optional(),
		region: secretVarSchema.optional(),
		role_arn: secretVarSchema.optional(),
		external_id: secretVarSchema.optional(),
		session_name: secretVarSchema.optional(),
		batch_role_arn: secretVarSchema.optional(),
		arn: secretVarSchema.optional(),
		project_id: secretVarSchema.optional(),
		batch_s3_config: batchS3ConfigSchema.optional(),
		endpoints: bedrockEndpointsSchema.optional(),
	})
	.refine(
		(data) => {
			// Region is required for Bedrock
			return isSecretVarSet(data.region);
		},
		{
			error: () => configSchemaMessage("region"),
			path: ["region"],
		},
	)
	.refine(
		(data) => {
			// When using explicit credentials, both access_key and secret_key are required
			if (data._auth_type === "explicit") {
				return isSecretVarSet(data.access_key) && isSecretVarSet(data.secret_key);
			}
			// Otherwise, if either is set both must be set
			const hasAccessKey = isSecretVarSet(data.access_key);
			const hasSecretKey = isSecretVarSet(data.secret_key);
			if (!hasAccessKey && !hasSecretKey) return true;
			return hasAccessKey && hasSecretKey;
		},
		{
			error: () => configSchemaMessage("explicitCredentials"),
			path: ["access_key"],
		},
	);

// Bedrock Mantle key config schema (SigV4 credentials; no ARN / batch S3 config)
export const bedrockMantleKeyConfigSchema = z
	.object({
		_auth_type: z.enum(["iam_role", "explicit", "api_key"]).optional(),
		access_key: secretVarSchema.optional(),
		secret_key: secretVarSchema.optional(),
		session_token: secretVarSchema.optional(),
		region: secretVarSchema.optional(),
		role_arn: secretVarSchema.optional(),
		external_id: secretVarSchema.optional(),
		session_name: secretVarSchema.optional(),
		project_id: secretVarSchema.optional(),
		endpoints: bedrockEndpointsSchema.optional(),
	})
	.refine((data) => isSecretVarSet(data.region), {
		error: () => configSchemaMessage("region"),
		path: ["region"],
	})
	.refine(
		(data) => {
			// Explicit auth must carry both keys; a region-only config fails at request time.
			if (data._auth_type === "explicit") {
				return isSecretVarSet(data.access_key) && isSecretVarSet(data.secret_key);
			}
			// If either access_key or secret_key is set, both must be set.
			const hasAccessKey = isSecretVarSet(data.access_key);
			const hasSecretKey = isSecretVarSet(data.secret_key);
			// IAM-role path: both keys empty is valid, but a lone session token cannot sign SigV4.
			if (!hasAccessKey && !hasSecretKey) return !isSecretVarSet(data.session_token);
			return hasAccessKey && hasSecretKey;
		},
		{
			error: () => configSchemaMessage("explicitCredentials"),
			path: ["access_key"],
		},
	);

// VLLM key config schema
export const vllmKeyConfigSchema = z
	.object({
		url: secretVarSchema.optional(),
		model_name: z
			.string()
			.trim()
			.min(1, { error: () => configSchemaMessage("modelName") }),
	})
	.refine((data) => isSecretVarSet(data.url), {
		error: () => configSchemaMessage("serverUrl"),
		path: ["url"],
	});

export const replicateKeyConfigSchema = z.object({
	use_deployments_endpoint: z.boolean().optional(),
});

// A secret that resolves elsewhere cannot have its shape judged here, so format checks apply
// only to literals.
//
// Only a non-empty `ref` counts as indirect. The `type` tag alone is not enough: a payload
// like { value: "not-numeric", ref: "", type: "env" } still carries its value inline, and
// trusting the tag would let any malformed literal skip every check below.
const isSecretVarRef = (v: { value?: string; ref?: string; type?: string } | undefined): boolean => !!v?.ref?.trim();

// A stored secret comes back from the API masked ("******" or "1234****...****5678"), and the
// edit form round-trips that mask untouched so the server keeps the original. Judging the
// mask's shape would fail every edit of a key whose credentials were not all retyped.
//
// isRedacted also treats env./vault. prefixes as hidden, but here references live in `ref`.
// With no ref the server stores an "env.x" value as plain text, so it gets checked like one.
const isSecretVarMasked = (v: { value?: string; ref?: string; type?: string } | undefined): boolean => {
	const value = v?.value ?? "";
	if (value.startsWith("env.") || value.startsWith("vault.")) return false;
	return isRedacted(value);
};

const isLiteralDigits = (v: { value?: string; ref?: string; type?: string } | undefined): boolean => {
	if (!isSecretVarSet(v)) return true; // presence is checked separately
	if (isSecretVarRef(v) || isSecretVarMasked(v)) return true;
	return /^\d+$/.test((v?.value ?? "").trim());
};

// GitHub issues App keys as PKCS#1 ("RSA PRIVATE KEY"); openssl can convert them to PKCS#8
// ("PRIVATE KEY"). Nothing else signs an RS256 App JWT, so an EC or passphrase-encrypted key
// is rejected here rather than at the first inference call.
//
// This checks the envelope only: the browser cannot parse DER. The server does the real
// parse in validateProviderKeyURL, so this is a fast typo check, not the security boundary.
// Literal backslash-n is tolerated because that is how a PEM most often arrives when it has
// been round-tripped through JSON or an environment variable.
const PEM_PRIVATE_KEY = /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*\n([\s\S]*?)\n\s*-----END \1-----$/;

const isLiteralPEM = (v: { value?: string; ref?: string; type?: string } | undefined): boolean => {
	if (!isSecretVarSet(v)) return true;
	if (isSecretVarRef(v) || isSecretVarMasked(v)) return true;
	const body = (v?.value ?? "").replace(/\\n/g, "\n").trim();
	const match = PEM_PRIVATE_KEY.exec(body);
	// The back-reference makes BEGIN and END agree; the body must also carry something.
	return !!match && match[2].trim().length > 0;
};

// githubCopilotKeyConfigComplete reports whether all four App credentials are present. It is
// the check the outer key schema uses to decide whether this block is a real credential.
export const githubCopilotKeyConfigComplete = (
	data: { app_id?: unknown; installation_id?: unknown; repository_id?: unknown; private_key?: unknown } | undefined,
): boolean => {
	if (!data) return false;
	const d = data as Record<string, { value?: string; ref?: string } | undefined>;
	return isSecretVarSet(d.app_id) && isSecretVarSet(d.installation_id) && isSecretVarSet(d.repository_id) && isSecretVarSet(d.private_key);
};

// GitHub Copilot key config schema. Every field is optional because the whole block is
// optional: a Copilot API token in `value` is the other valid auth mode. Once the operator
// starts filling this block in, all four become required together and literals are checked
// for shape, so a typo is caught in the form rather than at the first inference call.
export const githubCopilotKeyConfigSchema = z
	.object({
		app_id: secretVarSchema.optional(),
		installation_id: secretVarSchema.optional(),
		repository_id: secretVarSchema.optional(),
		private_key: secretVarSchema.optional(),
		github_domain: secretVarSchema.optional(),
	})
	.superRefine((data, ctx) => {
		const started =
			isSecretVarSet(data.app_id) ||
			isSecretVarSet(data.installation_id) ||
			isSecretVarSet(data.repository_id) ||
			isSecretVarSet(data.private_key);
		if (!started) return;

		for (const field of ["app_id", "installation_id", "repository_id", "private_key"] as const) {
			if (!isSecretVarSet(data[field])) {
				ctx.addIssue({
					code: "custom",
					path: [field],
					message: schemaMessage("githubRequired", "Required when using GitHub App credentials"),
				});
			}
		}
		if (!isLiteralDigits(data.installation_id)) {
			ctx.addIssue({
				code: "custom",
				path: ["installation_id"],
				message: schemaMessage("installationNumeric", "Installation ID must be numeric"),
			});
		}
		if (!isLiteralDigits(data.repository_id)) {
			ctx.addIssue({
				code: "custom",
				path: ["repository_id"],
				message: schemaMessage("repositoryNumeric", "Repository ID must be numeric"),
			});
		}
		if (!isLiteralPEM(data.private_key)) {
			ctx.addIssue({
				code: "custom",
				path: ["private_key"],
				message: schemaMessage("privateKeyPem", "Private key must be a PKCS#1 or PKCS#8 PEM block"),
			});
		}
	});

// Ollama key config schema
export const ollamaKeyConfigSchema = z
	.object({
		url: secretVarSchema.optional(),
	})
	.refine((data) => isSecretVarSet(data.url), {
		error: () => configSchemaMessage("serverUrl"),
		path: ["url"],
	});

// SGL key config schema
export const sglKeyConfigSchema = z
	.object({
		url: secretVarSchema.optional(),
	})
	.refine((data) => isSecretVarSet(data.url), {
		error: () => configSchemaMessage("serverUrl"),
		path: ["url"],
	});

// Databricks key config schema
export const databricksKeyConfigSchema = z
	.object({
		workspace_url: secretVarSchema.optional(),
		api_format: z.enum(["auto", "model_serving", "ai_gateway"]).optional(),
		client_id: secretVarSchema.optional(),
		client_secret: secretVarSchema.optional(),
		forward_gateway_tags: z.boolean().optional(),
		// UI-only discriminator, mirroring the azure/vertex/bedrock key forms.
		_auth_type: z.enum(["pat", "oauth_m2m"]).optional(),
	})
	.refine((data) => isSecretVarSet(data.workspace_url), {
		error: () => configSchemaMessage("workspaceUrl"),
		path: ["workspace_url"],
	})
	// The OAuth M2M tab hides the token field, so a key saved from it needs the whole service
	// principal or it has no credentials at all. Mirrors the Azure Entra ID rule.
	.refine((data) => data._auth_type !== "oauth_m2m" || (isSecretVarSet(data.client_id) && isSecretVarSet(data.client_secret)), {
		error: () => configSchemaMessage("oauthM2mCredentials"),
		path: ["client_id"],
	})
	// A service principal only authenticates as a pair; half of one is always a misconfiguration.
	.refine((data) => isSecretVarSet(data.client_id) === isSecretVarSet(data.client_secret), {
		error: () => configSchemaMessage("clientCredentialsTogether"),
		path: ["client_secret"],
	});

// Model family enum schema — must mirror schemas.ModelFamily in Go.
export const modelFamilySchema = z.enum([
	"anthropic",
	"openai",
	"mistral",
	"cohere",
	"gemini",
	"gemma",
	"llama",
	"imagen",
	"veo",
	"nova",
	"titan",
]);

// AliasConfig schema — mirrors schemas.AliasConfig with the embedded
// provider sub-configs flattened to top-level optional fields (matches Go's
// embedded-pointer-struct JSON output).
const aliasConfigObjectSchema = z.object({
	model_id: z
		.string()
		.trim()
		.min(1, { error: () => configSchemaMessage("modelId") }),
	model_name: z.string().trim().optional(),
	model_family: modelFamilySchema.optional(),
	description: z.string().optional(),
	region: secretVarSchema.optional(),
	// Azure overrides
	api_version: z.string().optional(),
	anthropic_version: z.string().optional(),
	endpoint: secretVarSchema.optional(),
	// Shared per-alias project override (Vertex / Bedrock / Bedrock Mantle)
	project_id: secretVarSchema.optional(),
	// Vertex overrides
	project_number: secretVarSchema.optional(),
	force_single_region: z.boolean().optional(),
	// Bedrock overrides
	inference_profile_arn: secretVarSchema.optional(),
	// Replicate overrides
	use_deployments_endpoint: z.boolean().optional(),
	use_anthropic_endpoints: z.boolean().optional(),
	use_openai_endpoints: z.boolean().optional(),
});

// The Go server emits the legacy string wire shape (`{"my-alias": "model-id"}`)
// for aliases that only carry ModelID — see AliasConfig.MarshalJSON. Accept
// both shapes here so edit-time validation doesn't reject hydrated state.
export const aliasConfigSchema = z.preprocess(
	(value) => (typeof value === "string" ? { model_id: value } : value),
	aliasConfigObjectSchema,
);

// Model provider key schema
export const modelProviderKeySchema = z
	.object({
		id: z.string().min(1, { error: () => configSchemaMessage("id") }),
		name: z.string().min(1, { error: () => configSchemaMessage("name") }),
		value: secretVarSchema.optional(),
		models: z.array(z.string()).optional().default(["*"]),
		blacklisted_models: z.array(z.string()).default([]).optional(),
		weight: z
			.union([z.number(), z.string()])
			.transform((val, ctx) => {
				if (typeof val === "number") return val;
				if (val.trim() === "") return 1.0;
				// Use Number() rather than parseFloat() so that strings like "0.5abc"
				// are rejected outright instead of silently parsing to 0.5.
				const num = Number(val);
				if (!Number.isFinite(num)) {
					ctx.addIssue({
						code: "custom",
						message: configSchemaMessage("weightNumber"),
					});
					return z.NEVER;
				}
				return num;
			})
			.pipe(
				z
					.number()
					.min(0, { error: () => configSchemaMessage("weightMin") })
					.max(1, { error: () => configSchemaMessage("weightMax") }),
			),
		aliases: z.record(z.string(), aliasConfigSchema).optional(),
		azure_key_config: azureKeyConfigSchema.optional(),
		vertex_key_config: vertexKeyConfigSchema.optional(),
		bedrock_key_config: bedrockKeyConfigSchema.optional(),
		bedrock_mantle_key_config: bedrockMantleKeyConfigSchema.optional(),
		vllm_key_config: vllmKeyConfigSchema.optional(),
		replicate_key_config: replicateKeyConfigSchema.optional(),
		ollama_key_config: ollamaKeyConfigSchema.optional(),
		sgl_key_config: sglKeyConfigSchema.optional(),
		databricks_key_config: databricksKeyConfigSchema.optional(),
		github_copilot_key_config: githubCopilotKeyConfigSchema.optional(),
		use_for_batch_api: z.boolean().optional(),
		use_anthropic_endpoints: z.boolean().optional(),
		use_openai_endpoints: z.boolean().optional(),
		enabled: z.boolean().optional(),
	})
	.refine(
		(data) => {
			if (data.vllm_key_config || data.ollama_key_config || data.sgl_key_config) {
				return true;
			}
			// Databricks authenticates with a personal access token (the key value) or with an
			// OAuth M2M service principal; only require a key value on the token path.
			// Decided from the credentials themselves rather than from _auth_type: the form
			// re-seeds that discriminator only on mount, so a reset (which the key form does
			// when the key resolves asynchronously) leaves it undefined on an M2M key that is
			// perfectly valid.
			if (data.databricks_key_config) {
				const databricks = data.databricks_key_config;
				if (databricks._auth_type === "oauth_m2m") {
					return true;
				}
				// Only infer the M2M path from the credentials when the discriminator is absent;
				// an explicit token method must still carry a token.
				if (databricks._auth_type === undefined && (isSecretVarSet(databricks.client_id) || isSecretVarSet(databricks.client_secret))) {
					return true;
				}
				return isSecretVarSet(data.value);
			}
			// GitHub Copilot authenticates from its own key config when no API token is given.
			// An empty block, or one carrying only github_domain, is not a credential: the
			// nested schema permits it so token auth stays valid, so this is the only place
			// that catches a key with no usable authentication at all.
			if (githubCopilotKeyConfigComplete(data.github_copilot_key_config)) {
				return true;
			}
			// Bedrock Mantle authenticates via SigV4 (its key config) or a Bearer key — only require
			// a top-level API key when the user explicitly chose the api_key auth method.
			if (data.bedrock_mantle_key_config) {
				if (data.bedrock_mantle_key_config._auth_type === "api_key") {
					return isSecretVarSet(data.value);
				}
				return true;
			}
			// Azure requires API key only when using api_key auth
			if (data.azure_key_config) {
				if (data.azure_key_config._auth_type === "api_key") {
					return isSecretVarSet(data.value);
				}
				return true;
			}
			// Bedrock only requires API key when using api_key auth
			if (data.bedrock_key_config) {
				if (data.bedrock_key_config._auth_type === "api_key") {
					return isSecretVarSet(data.value);
				}
				return true;
			}
			// Vertex requires API key only when using api_key auth
			if (data.vertex_key_config) {
				if (data.vertex_key_config._auth_type === "api_key") {
					return isSecretVarSet(data.value);
				}
				return true;
			}
			// Otherwise, value is required
			return isSecretVarSet(data.value);
		},
		{
			error: () => configSchemaMessage("apiKey"),
			path: ["value"],
		},
	);

// Network config schema
export const networkConfigSchema = z
	.object({
		base_url: z.union([z.string().url({ error: () => configSchemaMessage("url") }), z.string().length(0)]).optional(),
		extra_headers: z.record(z.string(), z.string()).optional(),
		default_request_timeout_in_seconds: z
			.number()
			.min(1, { error: () => configSchemaMessage("timeoutMin") })
			.max(3600, { error: () => configSchemaMessage("timeoutMax") }),
		max_retries: z
			.number()
			.min(0, { error: () => configSchemaMessage("retriesMin") })
			.max(10, { error: () => configSchemaMessage("retriesMax") }),
		retry_backoff_initial: z.number().min(100),
		retry_backoff_max: z.number().min(100),
		insecure_skip_verify: z.boolean().optional(),
		ca_cert_pem: secretVarSchema.optional(),
		stream_idle_timeout_in_seconds: z
			.number()
			.int({ error: () => configSchemaMessage("streamTimeoutWhole") })
			.min(5, { error: () => configSchemaMessage("streamTimeoutMin") })
			.max(3600, { error: () => configSchemaMessage("streamTimeoutMax") })
			.optional(),
		keep_alive_timeout_in_seconds: z
			.number()
			.int({ error: () => configSchemaMessage("keepAliveWhole") })
			.min(1, { error: () => configSchemaMessage("keepAliveMin") })
			.max(3600, { error: () => configSchemaMessage("keepAliveMax") })
			.optional(),
		max_conns_per_host: z
			.number()
			.int({ error: () => configSchemaMessage("connectionsWhole") })
			.min(1, { error: () => configSchemaMessage("connectionsMin") })
			.max(10000, { error: () => configSchemaMessage("connectionsMax") })
			.optional(),
		enforce_http2: z.boolean().optional(),
		http2_ping_interval_in_seconds: z
			.number()
			.int({ error: () => configSchemaMessage("http2PingWhole") })
			.min(0, { error: () => configSchemaMessage("http2PingMin") })
			.max(3600, { error: () => configSchemaMessage("http2PingMax") })
			.optional(),
		allow_private_network: z.boolean().optional(),
	})
	.refine((d) => d.retry_backoff_initial <= d.retry_backoff_max, {
		error: () => configSchemaMessage("backoffFieldsOrder"),
		path: ["retry_backoff_initial"],
	});

// Network form schema - more lenient for form inputs
export const networkFormConfigSchema = z
	.object({
		base_url: z
			.union([
				z
					.string()
					.url({ error: () => configSchemaMessage("url") })
					.refine((url) => url.startsWith("https://") || url.startsWith("http://"), {
						error: () => configSchemaMessage("httpUrl"),
					}),
				z.string().length(0),
			])
			.optional(),
		extra_headers: z.record(z.string(), z.string()).optional(),
		default_request_timeout_in_seconds: z.coerce
			.number({ error: () => configSchemaMessage("timeoutNumber") })
			.min(1, { error: () => configSchemaMessage("timeoutMin") })
			.max(172800, { error: () => configSchemaMessage("timeoutFormMax") }),
		max_retries: z.coerce
			.number({ error: () => configSchemaMessage("retriesNumber") })
			.min(0, { error: () => configSchemaMessage("retriesMin") })
			.max(10, { error: () => configSchemaMessage("retriesMax") }),
		retry_backoff_initial: z.coerce
			.number({ error: () => configSchemaMessage("backoffInitialNumber") })
			.min(100, { error: () => configSchemaMessage("backoffInitialMin") })
			.max(1000000, { error: () => configSchemaMessage("backoffInitialMax") }),
		retry_backoff_max: z.coerce
			.number({ error: () => configSchemaMessage("backoffMaxNumber") })
			.min(100, { error: () => configSchemaMessage("backoffMaxMin") })
			.max(1000000, { error: () => configSchemaMessage("backoffMaxMax") }),
		insecure_skip_verify: z.boolean().optional(),
		ca_cert_pem: secretVarSchema.optional(),
		stream_idle_timeout_in_seconds: z.coerce
			.number({ error: () => configSchemaMessage("streamTimeoutNumber") })
			.int({ error: () => configSchemaMessage("streamTimeoutWhole") })
			.min(5, { error: () => configSchemaMessage("streamTimeoutMin") })
			.max(3600, { error: () => configSchemaMessage("streamTimeoutMax") })
			.optional(),
		keep_alive_timeout_in_seconds: z.coerce
			.number({ error: () => configSchemaMessage("keepAliveNumber") })
			.int({ error: () => configSchemaMessage("keepAliveWhole") })
			.min(1, { error: () => configSchemaMessage("keepAliveMin") })
			.max(3600, { error: () => configSchemaMessage("keepAliveMax") })
			.optional(),
		max_conns_per_host: z.coerce
			.number({ error: () => configSchemaMessage("connectionsNumber") })
			.int({ error: () => configSchemaMessage("connectionsWhole") })
			.min(1, { error: () => configSchemaMessage("connectionsMin") })
			.max(10000, { error: () => configSchemaMessage("connectionsMax") })
			.optional(),
		enforce_http2: z.boolean().optional(),
		http2_ping_interval_in_seconds: z.coerce
			.number({ error: () => configSchemaMessage("http2PingNumber") })
			.int({ error: () => configSchemaMessage("http2PingWhole") })
			.min(0, { error: () => configSchemaMessage("http2PingMin") })
			.max(3600, { error: () => configSchemaMessage("http2PingMax") })
			.optional(),
		allow_private_network: z.boolean().optional(),
	})
	.refine((d) => d.retry_backoff_initial <= d.retry_backoff_max, {
		error: () => configSchemaMessage("backoffOrder"),
		path: ["retry_backoff_initial"],
	});

// Concurrency and buffer size schema
export const concurrencyAndBufferSizeSchema = z.object({
	concurrency: z
		.number()
		.min(1, { error: () => configSchemaMessage("concurrencyMin") })
		.max(100, { error: () => configSchemaMessage("concurrencyMax") }),
	buffer_size: z
		.number()
		.min(1, { error: () => configSchemaMessage("bufferMin") })
		.max(1000, { error: () => configSchemaMessage("bufferMax") }),
});

// Proxy type schema
export const proxyTypeSchema = z.enum(["none", "http", "socks5", "environment"]);

// Proxy config schema
export const proxyConfigSchema = z
	.object({
		type: proxyTypeSchema,
		url: secretVarSchema.optional(),
		username: secretVarSchema.optional(),
		password: secretVarSchema.optional(),
		ca_cert_pem: secretVarSchema.optional(),
	})
	.refine(
		(data) =>
			!(data.type === "http" || data.type === "socks5") ||
			data.url?.type === "env" ||
			data.url?.type === "vault" ||
			(data.url?.value && data.url.value.trim().length > 0),
		{
			error: () => configSchemaMessage("proxyUrlRequired"),
			path: ["url"],
		},
	)
	.refine(
		(data) => {
			if ((data.type === "http" || data.type === "socks5") && data.url?.value?.trim()) {
				if (isRedacted(data.url.value)) {
					return true;
				}
				try {
					new URL(data.url.value);
					return true;
				} catch {
					return false;
				}
			}
			return true;
		},
		{
			error: () => configSchemaMessage("proxyUrl"),
			path: ["url"],
		},
	);

// Proxy form schema - more lenient for form inputs with conditional validation
export const proxyFormConfigSchema = z
	.object({
		type: proxyTypeSchema,
		url: secretVarSchema.optional(),
		username: secretVarSchema.optional(),
		password: secretVarSchema.optional(),
		ca_cert_pem: secretVarSchema.optional(),
	})
	.refine(
		(data) => {
			if (data.type === "none") {
				return true;
			}
			// URL is required when proxy type is http or socks5
			if (data.type === "http" || data.type === "socks5") {
				// Env-backed URLs may have empty resolved value before env resolution.
				if (!!(data.url?.type && data.url?.type !== "plain_text") || data.url?.ref) return true;
				// Literal URLs must be non-empty.
				if (!data.url?.value || data.url.value.trim().length === 0) return false;
			}
			return true;
		},
		{
			error: () => configSchemaMessage("proxyUrlRequired"),
			path: ["url"],
		},
	)
	.refine(
		(data) => {
			// URL must be valid format when provided and proxy type requires it
			if ((data.type === "http" || data.type === "socks5") && data.url?.value && data.url.value.trim().length > 0) {
				if (isRedacted(data.url.value)) {
					return true;
				}
				try {
					new URL(data.url.value);
					return true;
				} catch {
					return false;
				}
			}
			return true;
		},
		{
			error: () => configSchemaMessage("proxyUrl"),
			path: ["url"],
		},
	);

// OpenAI Config tab
export const openaiConfigFormSchema = z.object({
	disable_store: z.boolean(),
});

export type OpenAIConfigFormSchema = z.infer<typeof openaiConfigFormSchema>;

// Prompt cache tab
export const cacheControlInjectionPointSchema = z
	.object({
		location: z.literal("message"),
		role: z.enum(["system", "developer", "user", "assistant"]).optional(),
		index: z.number().int().optional(),
	})
	.refine((p) => p.role !== undefined || p.index !== undefined, {
		error: () => configSchemaMessage("cacheInjectionPoint"),
	});

export const promptCacheFormSchema = z.object({
	auto_inject: z.boolean(),
	ttl: z.string().optional(),
	cache_control_injection_points: z.array(cacheControlInjectionPointSchema).optional(),
});

export type PromptCacheFormSchema = z.infer<typeof promptCacheFormSchema>;

// Allowed requests schema
export const allowedRequestsSchema = z.object({
	text_completion: z.boolean(),
	text_completion_stream: z.boolean(),
	chat_completion: z.boolean(),
	chat_completion_stream: z.boolean(),
	responses: z.boolean(),
	responses_stream: z.boolean(),
	responses_retrieve: z.boolean().optional(),
	responses_delete: z.boolean().optional(),
	responses_cancel: z.boolean().optional(),
	responses_input_items: z.boolean().optional(),
	embedding: z.boolean(),
	speech: z.boolean(),
	speech_stream: z.boolean(),
	transcription: z.boolean(),
	transcription_stream: z.boolean(),
	image_generation: z.boolean(),
	image_generation_stream: z.boolean(),
	image_edit: z.boolean(),
	image_edit_stream: z.boolean(),
	image_variation: z.boolean(),
	ocr: z.boolean().optional(),
	ocr_stream: z.boolean().optional(),
	rerank: z.boolean(),
	decisions: z.boolean().optional(),
	video_generation: z.boolean(),
	video_edit: z.boolean(),
	video_retrieve: z.boolean(),
	video_download: z.boolean(),
	video_delete: z.boolean(),
	video_list: z.boolean(),
	video_remix: z.boolean(),
	count_tokens: z.boolean(),
	list_models: z.boolean(),
	model_retrieve: z.boolean().optional(),
	websocket_responses: z.boolean(),
	realtime: z.boolean(),
	live: z.boolean().optional(),
});

// Custom provider config schema
export const customProviderConfigSchema = z
	.object({
		base_provider_type: knownProviderSchema,
		is_key_less: z.boolean().optional(),
		does_not_send_done_marker: z.boolean().optional(),
		wait_for_usage: z.boolean().optional(),
		allowed_requests: allowedRequestsSchema.optional(),
		request_path_overrides: z.record(z.string(), z.string().optional()).optional(),
	})
	.refine(
		(data) => {
			if (data.base_provider_type === "bedrock") {
				return !data.is_key_less;
			}
			return true;
		},
		{
			error: () => configSchemaMessage("bedrockKeyless"),
			path: ["is_key_less"],
		},
	);

// Form-specific custom provider config schema
export const formCustomProviderConfigSchema = z
	.object({
		base_provider_type: z.string().min(1, { error: () => configSchemaMessage("baseProviderType") }),
		is_key_less: z.boolean().optional(),
		does_not_send_done_marker: z.boolean().optional(),
		wait_for_usage: z.boolean().optional(),
		allowed_requests: allowedRequestsSchema.optional(),
		request_path_overrides: z.record(z.string(), z.string().optional()).optional(),
	})
	.refine(
		(data) => {
			if (data.base_provider_type === "bedrock") {
				return !data.is_key_less;
			}
			return true;
		},
		{
			error: () => configSchemaMessage("bedrockKeyless"),
			path: ["is_key_less"],
		},
	);

// Full model provider config schema
export const modelProviderConfigSchema = z.object({
	keys: z.array(modelProviderKeySchema).min(1, { error: () => configSchemaMessage("oneKey") }),
	network_config: networkConfigSchema.optional(),
	concurrency_and_buffer_size: concurrencyAndBufferSizeSchema.optional(),
	proxy_config: proxyConfigSchema.optional(),
	send_back_raw_request: z.boolean().optional(),
	send_back_raw_response: z.boolean().optional(),
	store_raw_request_response: z.boolean().optional(),
	ignore_provider_cost: z.boolean().optional(),
	custom_provider_config: customProviderConfigSchema.optional(),
});

// Model provider schema
export const modelProviderSchema = modelProviderConfigSchema.extend({
	name: modelProviderNameSchema,
});

// Form-specific model provider config schema
export const formModelProviderConfigSchema = z.object({
	keys: z.array(modelProviderKeySchema).min(1, { error: () => configSchemaMessage("oneKey") }),
	network_config: networkConfigSchema.optional(),
	concurrency_and_buffer_size: concurrencyAndBufferSizeSchema.optional(),
	proxy_config: proxyConfigSchema.optional(),
	send_back_raw_request: z.boolean().optional(),
	send_back_raw_response: z.boolean().optional(),
	store_raw_request_response: z.boolean().optional(),
	ignore_provider_cost: z.boolean().optional(),
	custom_provider_config: formCustomProviderConfigSchema.optional(),
});

// Flexible model provider schema for form data - allows any string for name
export const formModelProviderSchema = formModelProviderConfigSchema.extend({
	name: z.string().min(1, { error: () => configSchemaMessage("providerName") }),
});

// Add provider request schema
export const addProviderRequestSchema = z.object({
	provider: modelProviderNameSchema,
	keys: z.array(modelProviderKeySchema).min(1, { error: () => configSchemaMessage("oneKey") }),
	network_config: networkConfigSchema.optional(),
	concurrency_and_buffer_size: concurrencyAndBufferSizeSchema.optional(),
	proxy_config: proxyConfigSchema.optional(),
	send_back_raw_request: z.boolean().optional(),
	send_back_raw_response: z.boolean().optional(),
	store_raw_request_response: z.boolean().optional(),
	ignore_provider_cost: z.boolean().optional(),
	custom_provider_config: customProviderConfigSchema.optional(),
	openai_config: openaiConfigFormSchema.optional(),
	prompt_cache: promptCacheFormSchema.optional(),
});

// Update provider request schema
export const updateProviderRequestSchema = z.object({
	keys: z.array(modelProviderKeySchema).min(1, { error: () => configSchemaMessage("oneKey") }),
	network_config: networkConfigSchema,
	concurrency_and_buffer_size: concurrencyAndBufferSizeSchema,
	proxy_config: proxyConfigSchema,
	send_back_raw_request: z.boolean().optional(),
	send_back_raw_response: z.boolean().optional(),
	store_raw_request_response: z.boolean().optional(),
	ignore_provider_cost: z.boolean().optional(),
	custom_provider_config: customProviderConfigSchema.optional(),
	openai_config: openaiConfigFormSchema.optional(),
	prompt_cache: promptCacheFormSchema.optional(),
});

// Cache config schema
const baseCacheConfigSchema = z.object({
	ttl: z.number().int().min(1).default(3600),
	threshold: z.number().min(0).max(1).default(0.8),
	conversation_history_threshold: z.number().int().min(0).optional(),
	exclude_system_prompt: z.boolean().optional(),
	cache_by_model: z.boolean().default(false),
	cache_by_provider: z.boolean().default(false),
	vector_store_namespace: z.string().min(1).optional(),
	default_cache_key: z.string().min(1).optional(),
	created_at: z.string().optional(),
	updated_at: z.string().optional(),
});

const directCacheConfigSchema = baseCacheConfigSchema
	.extend({
		dimension: z.literal(1),
		keys: z.array(modelProviderKeySchema).optional(),
	})
	.strict();

const providerBackedCacheConfigSchema = baseCacheConfigSchema
	.extend({
		provider: modelProviderNameSchema,
		keys: z.array(modelProviderKeySchema).optional(),
		embedding_model: z.string().min(1, { error: () => configSchemaMessage("embeddingModel") }),
		dimension: z
			.number()
			.int()
			.min(2, { error: () => configSchemaMessage("cacheDimension") }),
	})
	.strict();

export const cacheConfigSchema = z.union([directCacheConfigSchema, providerBackedCacheConfigSchema]);

// Core config schema
export const coreConfigSchema = z.object({
	drop_excess_requests: z.boolean().default(false),
	initial_pool_size: z.number().min(1).default(10),
	prometheus_labels: z.array(z.string()).default([]),
	enable_logging: z.boolean().default(true),
	disable_content_logging: z.boolean().default(false),
	enforce_auth_on_inference: z.boolean().default(true),
	hide_deleted_virtual_keys_in_filters: z.boolean().default(false),
	delete_expired_virtual_keys: z.boolean().default(false),
	hidden_request_types: z.array(z.string()).default([]),
	allowed_origins: z.array(z.string()).default(["*"]),
	max_request_body_size_mb: z.number().min(1).default(100),
	mcp_agent_depth: z.number().min(1).default(10),
	mcp_tool_execution_timeout: z.number().min(1).default(30),
	mcp_code_mode_binding_level: z.enum(["server", "tool"]).default("server"),
	mcp_disable_auto_tool_inject: z.boolean().default(false),
	mcp_max_instructions_per_client: z.number().int().min(0).default(0),
	mcp_max_instructions_total: z.number().int().min(0).default(0),
	mcp_code_mode_limits: z
		.object({
			max_source_bytes: z.number().int().min(0).optional(),
			max_steps: z.number().int().min(0).optional(),
			max_memory_bytes: z.number().int().min(0).optional(),
			max_log_bytes: z.number().int().min(0).optional(),
			max_tool_calls: z.number().int().min(0).optional(),
			max_value_bytes: z
				.number()
				.int()
				.refine((v) => v === 0 || v >= 1024, { error: () => configSchemaMessage("codeModeValueBytes") })
				.optional(),
			max_nesting_depth: z.number().int().min(0).max(1000).optional(),
		})
		.optional(),
	mcp_enable_temp_token_auth: z.boolean().default(false),
});

// Bifrost config schema
export const bifrostConfigSchema = z.object({
	client_config: coreConfigSchema,
	is_db_connected: z.boolean(),
	is_cache_connected: z.boolean(),
	is_logs_connected: z.boolean(),
	is_git_available: z.boolean().optional().default(false),
});

// Network and proxy form schema - combined for the NetworkFormFragment
export const networkAndProxyFormSchema = z.object({
	network_config: networkFormConfigSchema.optional(),
	proxy_config: proxyFormConfigSchema.optional(),
});

// Proxy-only form schema for the ProxyFormFragment
export const proxyOnlyFormSchema = z.object({
	proxy_config: proxyFormConfigSchema.optional(),
});

// Network-only form schema for the NetworkFormFragment
export const networkOnlyFormSchema = z.object({
	network_config: networkFormConfigSchema.optional(),
});

// Performance form schema for the PerformanceFormFragment (concurrency/buffer only; raw request/response are in Debugging tab)
export const performanceFormSchema = z.object({
	concurrency_and_buffer_size: z
		.object({
			concurrency: z
				.number({ error: () => configSchemaMessage("concurrencyNumber") })
				.min(1, { error: () => configSchemaMessage("concurrencyMin") })
				.max(100000, { error: () => configSchemaMessage("concurrencyFormMax") }),
			buffer_size: z
				.number({ error: () => configSchemaMessage("bufferNumber") })
				.min(1, { error: () => configSchemaMessage("bufferMin") })
				.max(100000, { error: () => configSchemaMessage("bufferFormMax") }),
		})
		.refine((data) => data.concurrency <= data.buffer_size, {
			error: () => configSchemaMessage("concurrencyBuffer"),
			path: ["concurrency"],
		}),
});

// Debugging tab (raw request/response toggles)
export const debuggingFormSchema = z.object({
	send_back_raw_request: z.boolean(),
	send_back_raw_response: z.boolean(),
	store_raw_request_response: z.boolean(),
});

export type DebuggingFormSchema = z.infer<typeof debuggingFormSchema>;

// Pricing tab (provider-reported cost handling)
export const pricingFormSchema = z.object({
	ignore_provider_cost: z.boolean(),
});

export type PricingFormSchema = z.infer<typeof pricingFormSchema>;

// Beta Headers tab
export const betaHeadersFormSchema = z.object({
	beta_header_overrides: z.record(z.string(), z.boolean()).optional(),
});

export type BetaHeadersFormSchema = z.infer<typeof betaHeadersFormSchema>;

// OTEL Configuration Schema
export const otelConfigSchema = z
	.object({
		// Per-profile enable toggle. A disabled profile exports nothing and is not validated.
		enabled: z.boolean().default(true),
		// Trace export toggle. When false the profile is metrics-only; collector_url isn't required.
		traces_enabled: z.boolean().default(true),
		service_name: z.string().optional(),
		collector_url: secretVarSchema.default({ value: "" }),
		trace_type: z
			.enum(["genai_extension", "vercel", "open_inference"], {
				error: () => schemaMessage("traceType", "Please select a trace type"),
			})
			.default("genai_extension"),
		// Common headers go to both endpoints; per-signal headers override on collision.
		headers: z.record(z.string(), secretVarSchema).optional(),
		trace_headers: z.record(z.string(), secretVarSchema).optional(),
		metrics_headers: z.record(z.string(), secretVarSchema).optional(),
		protocol: z
			.enum(["http", "grpc"], {
				error: () => schemaMessage("protocol", "Please select a protocol"),
			})
			.default("http"),
		// TLS configuration
		tls_ca_cert: z.string().optional(),
		insecure: z.boolean().default(true),
		// Bounds a single trace export. gRPC exports have no other timeout, so an
		// endpoint that accepts the connection but never replies would otherwise block
		// an export goroutine indefinitely.
		export_timeout: z.number().int().min(1).max(60).default(5),
		// Metrics push configuration
		metrics_enabled: z.boolean().default(false),
		// Export per-component Bifrost overhead latency as a histogram.
		overhead_breakdown_enabled: z.boolean().default(false),
		metrics_endpoint: secretVarSchema.optional(),
		metrics_push_interval: z.number().int().min(1).max(300).default(15),
		request_headers: z.array(z.string()).default([]),
		disable_content_logging: z.boolean().default(false),
		export_raw_payloads: z.boolean().default(false),
		group_traces_by_session: z.boolean().default(false),
		disable_root_span_content: z.boolean().default(false),
	})
	.superRefine((data, ctx) => {
		// A disabled profile is not sent anywhere, so skip all validation for it.
		if (data.enabled === false) return;

		const protocol = data.protocol;
		const hostPortRegex = /^(?!https?:\/\/)([a-zA-Z0-9.-]+|\[[0-9a-fA-F:]+\]|\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/;

		// Helper to validate URL format
		const validateHttpUrl = (url: string, path: string[]) => {
			try {
				const u = new URL(url);
				if (!(u.protocol === "http:" || u.protocol === "https:")) {
					ctx.addIssue({
						code: "custom",
						path,
						message: schemaMessage("httpUrl", "Must be a valid HTTP or HTTPS URL"),
					});
					return false;
				}
				return true;
			} catch {
				ctx.addIssue({
					code: "custom",
					path,
					message: schemaMessage("httpUrl", "Must be a valid HTTP or HTTPS URL"),
				});
				return false;
			}
		};

		// Helper to validate host:port format
		const validateHostPort = (value: string, path: string[], example: string) => {
			const match = value.match(hostPortRegex);
			if (!match) {
				ctx.addIssue({
					code: "custom",
					path,
					message: schemaMessage("grpcAddress", "Must be in the format <host>:<port> for gRPC (e.g. {{example}})", { example }),
				});
				return false;
			}
			const port = Number(match[2]);
			if (!(port >= 1 && port <= 65535)) {
				ctx.addIssue({
					code: "custom",
					path,
					message: schemaMessage("portRange", "Port must be between 1 and 65535"),
				});
				return false;
			}
			return true;
		};

		// collector_url is required and validated only when traces are enabled.
		if (data.traces_enabled) {
			if (!isSecretVarSet(data.collector_url)) {
				ctx.addIssue({
					code: "custom",
					path: ["collector_url"],
					message: schemaMessage("collectorRequired", "Collector address is required"),
				});
			}

			// Validate collector_url format — skip format check for env var references
			const collectorUrl = (data.collector_url?.value || "").trim();
			if (collectorUrl && (data.collector_url?.type === "plain_text" || !data.collector_url?.type) && protocol === "http") {
				validateHttpUrl(collectorUrl, ["collector_url"]);
			} else if (collectorUrl && (data.collector_url?.type === "plain_text" || !data.collector_url?.type) && protocol === "grpc") {
				validateHostPort(collectorUrl, ["collector_url"], "otel-collector:4317");
			}
		}

		// Validate metrics_endpoint when metrics_enabled is true
		if (data.metrics_enabled) {
			const metricsEndpoint = (data.metrics_endpoint?.value || "").trim();
			if (!isSecretVarSet(data.metrics_endpoint)) {
				ctx.addIssue({
					code: "custom",
					path: ["metrics_endpoint"],
					message: schemaMessage("metricsRequired", "Metrics endpoint is required when metrics push is enabled"),
				});
			} else if (metricsEndpoint && (data.metrics_endpoint?.type === "plain_text" || !data.metrics_endpoint?.type) && protocol === "http") {
				validateHttpUrl(metricsEndpoint, ["metrics_endpoint"]);
			} else if (metricsEndpoint && (data.metrics_endpoint?.type === "plain_text" || !data.metrics_endpoint?.type) && protocol === "grpc") {
				validateHostPort(metricsEndpoint, ["metrics_endpoint"], "otel-collector:4317");
			}
		}
	});

// OTEL form schema for the OtelFormFragment. The plugin itself is gated by `enabled`;
// it carries one or more export profiles, each independently enable-able.
export const otelFormSchema = z.object({
	enabled: z.boolean().default(true),
	profiles: z.array(otelConfigSchema).min(1, { error: () => configSchemaMessage("oneProfile") }),
});

// Maxim Configuration Schema
export const maximConfigSchema = z.object({
	api_key: z.string().default(""),
	log_repo_id: z.string().optional(),
	request_headers: z.array(z.string()).default([]),
});

// Maxim form schema for the MaximFormFragment
export const maximFormSchema = z
	.object({
		enabled: z.boolean().default(true),
		maxim_config: maximConfigSchema,
	})
	.superRefine((data, ctx) => {
		if (data.enabled) {
			const apiKey = (data.maxim_config.api_key || "").trim();
			if (!apiKey) {
				ctx.addIssue({
					code: "custom",
					path: ["maxim_config", "api_key"],
					message: configSchemaMessage("apiKey"),
				});
			} else if (!apiKey.startsWith("sk_mx_")) {
				ctx.addIssue({
					code: "custom",
					path: ["maxim_config", "api_key"],
					message: configSchemaMessage("maximKeyPrefix"),
				});
			}
		}
	});

// Prometheus Push Gateway Configuration Schema
export const prometheusConfigSchema = z
	.object({
		push_gateway_url: secretVarSchema.optional(),
		job_name: z.string().default("bifrost"),
		instance_id: z.string().optional(),
		push_interval: z.number().min(1).max(300).default(15),
		basic_auth_username: secretVarSchema.optional(),
		basic_auth_password: secretVarSchema.optional(),
	})
	.superRefine((data, ctx) => {
		// Validate push_gateway_url format — skip for env var references
		const url = (data.push_gateway_url?.value || "").trim();
		if (url && (data.push_gateway_url?.type === "plain_text" || !data.push_gateway_url?.type)) {
			try {
				const u = new URL(url);
				if (!(u.protocol === "http:" || u.protocol === "https:")) {
					ctx.addIssue({
						code: "custom",
						path: ["push_gateway_url"],
						message: configSchemaMessage("httpUrl"),
					});
				}
			} catch {
				ctx.addIssue({
					code: "custom",
					path: ["push_gateway_url"],
					message: configSchemaMessage("pushGatewayUrl"),
				});
			}
		}

		// Validate basic auth: if one credential is provided, both must be provided
		const hasUsername = isSecretVarSet(data.basic_auth_username);
		const hasPassword = isSecretVarSet(data.basic_auth_password);
		if (hasUsername && !hasPassword) {
			ctx.addIssue({
				code: "custom",
				path: ["basic_auth_password"],
				message: configSchemaMessage("passwordWithUsername"),
			});
		}
		if (hasPassword && !hasUsername) {
			ctx.addIssue({
				code: "custom",
				path: ["basic_auth_username"],
				message: configSchemaMessage("usernameWithPassword"),
			});
		}
	});

// Prometheus form schema for the PrometheusFormFragment.
export const prometheusFormSchema = z
	.object({
		metrics_enabled: z.boolean().default(true),
		overhead_breakdown_enabled: z.boolean().default(false),
		user_labels_enabled: z.boolean().default(false),
		push_gateway_enabled: z.boolean().default(false),
		prometheus_config: prometheusConfigSchema,
	})
	.superRefine((data, ctx) => {
		if (data.push_gateway_enabled) {
			const urlIsSet = isSecretVarSet(data.prometheus_config.push_gateway_url);
			if (!urlIsSet) {
				ctx.addIssue({
					code: "custom",
					path: ["prometheus_config", "push_gateway_url"],
					message: configSchemaMessage("pushGatewayUrlRequired"),
				});
			}
		}
	});

// MCP Client update schema
export const mcpClientUpdateSchema = z
	.object({
		is_code_mode_client: z.boolean().optional(),
		is_ping_available: z.boolean().optional(),
		needs_session_stickiness: z.boolean().optional(),
		allow_by_default: z.boolean().optional(),
		disabled: z.boolean().optional(),
		name: z
			.string()
			.min(1, { error: () => configSchemaMessage("name") })
			.refine((val) => !val.includes("-"), {
				error: () => configSchemaMessage("clientNameHyphens"),
			})
			.refine((val) => !val.includes(" "), {
				error: () => configSchemaMessage("clientNameSpaces"),
			})
			.refine((val) => !/^[0-9]/.test(val), {
				error: () => configSchemaMessage("clientNameNumber"),
			}),
		headers: z.record(z.string(), secretVarSchema).optional().nullable(),
		per_user_header_keys: z
			.array(
				z
					.string()
					.trim()
					.min(1, { error: () => configSchemaMessage("headerName") }),
			)
			.optional()
			.refine(
				(headers) => {
					if (!headers) return true;
					const normalized = headers.map((h) => h.trim().toLowerCase());
					return normalized.length === new Set(normalized).size;
				},
				{ error: () => configSchemaMessage("duplicateHeaders") },
			),
		tools_to_execute: z
			.array(z.string())
			.optional()
			.refine(
				(tools) => {
					if (!tools || tools.length === 0) return true;
					const hasWildcard = tools.includes("*");
					return !hasWildcard || tools.length === 1;
				},
				{ error: () => configSchemaMessage("wildcardTools") },
			)
			.refine(
				(tools) => {
					if (!tools) return true;
					return tools.length === new Set(tools).size;
				},
				{ error: () => configSchemaMessage("duplicateTools") },
			),
		tools_to_auto_execute: z
			.array(z.string())
			.optional()
			.refine(
				(tools) => {
					if (!tools || tools.length === 0) return true;
					const hasWildcard = tools.includes("*");
					return !hasWildcard || tools.length === 1;
				},
				{ error: () => configSchemaMessage("wildcardTools") },
			)
			.refine(
				(tools) => {
					if (!tools) return true;
					return tools.length === new Set(tools).size;
				},
				{ error: () => configSchemaMessage("duplicateTools") },
			),
		tool_pricing: z.record(z.string(), z.number().min(0, { error: () => configSchemaMessage("toolCost") })).optional(),
		tool_sync_interval: z
			.number()
			.min(0, { error: () => configSchemaMessage("toolSyncInterval") })
			.optional(), // 0 = use global, >0 = custom interval in minutes
		tool_execution_timeout: z.number().int().min(0).optional(), // 0 = use global, >0 = per-server timeout in seconds
		max_instructions_length: z.number().int().min(0).optional(), // 0 = use global, >0 = per-server instruction byte cap
		allowed_extra_headers: z
			.array(z.string())
			.optional()
			.refine(
				(headers) => {
					if (!headers || headers.length === 0) return true;
					const hasWildcard = headers.includes("*");
					return !hasWildcard || headers.length === 1;
				},
				{ error: () => configSchemaMessage("wildcardHeaders") },
			),
		oauth_config: z
			.object({
				client_id: secretVarSchema.optional(),
				client_secret: secretVarSchema.optional(),
				authorize_url: z
					.string()
					.optional()
					.refine((val) => !val || /^https?:\/\/.+$/.test(val), { error: () => configSchemaMessage("authorizeUrl") }),
				token_url: z
					.string()
					.optional()
					.refine((val) => !val || /^https?:\/\/.+$/.test(val), { error: () => configSchemaMessage("tokenUrl") }),
				registration_url: z
					.string()
					.optional()
					.refine((val) => !val || /^https?:\/\/.+$/.test(val), { error: () => configSchemaMessage("registrationUrl") }),
				scopes: z.array(z.string()).optional(),
				resource: z.string().optional(),
			})
			.optional(),
		token_exchange: z
			.object({
				audience: z
					.string()
					.trim()
					.min(1, { error: () => configSchemaMessage("audience") }),
				use_idp_credentials: z.boolean().optional(),
				client_id: secretVarSchema.optional(),
				client_secret: secretVarSchema.optional(),
				authorization_server_url: z
					.string()
					.optional()
					.refine((val) => !val || /^https?:\/\/.+$/.test(val), {
						error: () => configSchemaMessage("authorizationServerUrl"),
					}),
				scopes: z.array(z.string()).optional(),
			})
			.optional(),
		tls_config: z
			.object({
				insecure_skip_verify: z.boolean().optional(),
				ca_cert_pem: secretVarSchema.optional(),
			})
			.optional(),
	})
	.superRefine((data, ctx) => {
		// per_user_header_keys is only ever set on the form for per_user_headers
		// auth clients (undefined otherwise), so an empty array here means the
		// admin cleared every entry, not that the field doesn't apply.
		if (data.per_user_header_keys !== undefined && data.per_user_header_keys.length === 0) {
			ctx.addIssue({
				code: "custom",
				path: ["per_user_header_keys"],
				message: configSchemaMessage("oneUserHeader"),
			});
		}
	});

// Global proxy type schema
export const globalProxyTypeSchema = z.enum(["http", "socks5", "tcp"]);

// Global proxy configuration schema
export const globalProxyConfigSchema = z
	.object({
		enabled: z.boolean(),
		type: globalProxyTypeSchema,
		url: z.string(),
		username: z.string().optional(),
		password: z.string().optional(),
		ca_cert_pem: z.string().optional(),
		no_proxy: z.string().optional(),
		timeout: z.number().min(0).optional(),
		skip_tls_verify: z.boolean().optional(),
		enable_for_scim: z.boolean(),
		enable_for_inference: z.boolean(),
		enable_for_api: z.boolean(),
	})
	.refine(
		(data) => {
			// URL is required when proxy is enabled
			if (data.enabled && (!data.url || data.url.trim().length === 0)) {
				return false;
			}
			return true;
		},
		{
			error: () => configSchemaMessage("enabledProxyUrl"),
			path: ["url"],
		},
	)
	.refine(
		(data) => {
			// Validate URL format when provided and enabled
			if (data.enabled && data.url && data.url.trim().length > 0) {
				try {
					new URL(data.url);
					return true;
				} catch {
					return false;
				}
			}
			return true;
		},
		{
			error: () => configSchemaMessage("proxyUrl"),
			path: ["url"],
		},
	);

// Global proxy form schema for the ProxyView
export const globalProxyFormSchema = z.object({
	proxy_config: globalProxyConfigSchema,
});

// Global header filter configuration schema
// Controls which headers with the x-bf-eh-* prefix are forwarded to LLM providers
export const globalHeaderFilterConfigSchema = z.object({
	allowlist: z.array(z.string()).optional(), // If non-empty, only these headers are allowed
	denylist: z.array(z.string()).optional(), // Headers to always block
});

// Global header filter form schema for the HeaderFilterView
export const globalHeaderFilterFormSchema = z.object({
	header_filter_config: globalHeaderFilterConfigSchema,
});

// Routing rule creation schema
export const routingRuleSchema = z
	.object({
		name: z
			.string()
			.min(1, { error: () => configSchemaMessage("ruleName") })
			.max(255, { error: () => configSchemaMessage("ruleNameMax") }),
		description: z
			.string()
			.max(1000, { error: () => configSchemaMessage("descriptionMax") })
			.optional(),
		cel_expression: z.string().optional(),
		provider: z.string().min(1, { error: () => configSchemaMessage("provider") }),
		model: z.string().optional(),
		fallbacks: z.array(z.string()).optional().default([]),
		scope: z.enum(["global", "team", "customer", "virtual_key"]),
		scope_id: z.string().optional(),
		priority: z
			.number()
			.min(0, { error: () => configSchemaMessage("priorityMin") })
			.max(1000, { error: () => configSchemaMessage("priorityMax") }),
		enabled: z.boolean().default(true),
		chain_rule: z.boolean().default(false),
	})
	.refine((data) => data.scope === "global" || (data.scope_id != null && data.scope_id.trim() !== ""), {
		error: () => configSchemaMessage("scopeId"),
		path: ["scope_id"],
	});

// Budget override form schema (BudgetOverrideDialog)
/** 可注入界面翻译器；未注入时保留原有英文校验合同。 */
export const createBudgetOverrideFormSchema = (t?: TFunction) =>
	z
		.object({
			amount: z
				.number({ error: () => (t ? t("overrideUi.amountPositive", { ns: "governance" }) : "Additional budget must be greater than 0.") })
				.positive({
					error: () => (t ? t("overrideUi.amountPositive", { ns: "governance" }) : "Additional budget must be greater than 0."),
				}),
			mode: z.enum(["cycles", "forever"]),
			cycles: z.number().optional(),
		})
		.refine((data) => data.mode !== "cycles" || (data.cycles !== undefined && Number.isSafeInteger(data.cycles) && data.cycles > 0), {
			error: () => (t ? t("overrideUi.cyclesPositive", { ns: "governance" }) : "Reset cycles must be a positive whole number."),
			path: ["cycles"],
		});
export const budgetOverrideFormSchema = createBudgetOverrideFormSchema();

// Proof of control for an auth_config change made while dashboard auth is disabled but an
// admin account exists (SecurityView). PUT /api/config refuses such a change with 403 unless
// it carries the stored admin password or the operator's setup token, so one of the two must
// be filled in; the issue lands on current_password because that is the field shown first.
// current_password is sent exactly as typed: the server compares it against the stored hash
// byte for byte and the password policy allows spaces. The setup token is trimmed, matching
// how the server reads the configured one.
export const authProofOfControlSchema = z
	.object({
		current_password: z.string(),
		setup_token: z.string().trim(),
	})
	.superRefine((data, ctx) => {
		if (!data.current_password.trim() && !data.setup_token) {
			ctx.addIssue({
				code: "custom",
				path: ["current_password"],
				message: schemaMessage(
					"authProof",
					"Enter the current admin password to confirm this change. Dashboard protection is off, so this session is not signed in. If you do not know the password, use the setup token instead.",
				),
			});
		}
	});

// Export type inference helpers
export type SecretVar = z.infer<typeof secretVarSchema>;
export type AuthProofOfControl = z.infer<typeof authProofOfControlSchema>;
export type MCPClientUpdateSchema = z.infer<typeof mcpClientUpdateSchema>;
export type ModelProviderKeySchema = z.infer<typeof modelProviderKeySchema>;
export type NetworkConfigSchema = z.infer<typeof networkConfigSchema>;
export type NetworkFormConfigSchema = z.infer<typeof networkFormConfigSchema>;
export type ProxyFormConfigSchema = z.infer<typeof proxyFormConfigSchema>;
export type NetworkAndProxyFormSchema = z.infer<typeof networkAndProxyFormSchema>;
export type ProxyOnlyFormSchema = z.infer<typeof proxyOnlyFormSchema>;
export type OtelConfigSchema = z.infer<typeof otelConfigSchema>;
export type OtelFormSchema = z.infer<typeof otelFormSchema>;
export type MaximConfigSchema = z.infer<typeof maximConfigSchema>;
export type MaximFormSchema = z.infer<typeof maximFormSchema>;
export type PrometheusConfigSchema = z.infer<typeof prometheusConfigSchema>;
export type PrometheusFormSchema = z.infer<typeof prometheusFormSchema>;
export type NetworkOnlyFormSchema = z.infer<typeof networkOnlyFormSchema>;
export type PerformanceFormSchema = z.infer<typeof performanceFormSchema>;
export type CustomProviderConfigSchema = z.infer<typeof customProviderConfigSchema>;
export type GlobalProxyConfigSchema = z.infer<typeof globalProxyConfigSchema>;
export type GlobalProxyFormSchema = z.infer<typeof globalProxyFormSchema>;
export type GlobalHeaderFilterConfigSchema = z.infer<typeof globalHeaderFilterConfigSchema>;
export type GlobalHeaderFilterFormSchema = z.infer<typeof globalHeaderFilterFormSchema>;
export type RoutingRuleSchema = z.infer<typeof routingRuleSchema>;
export type BudgetOverrideFormSchema = z.infer<typeof budgetOverrideFormSchema>;
// OSS setup lock: the operator's setup token entered on the login setup view.
export const setupTokenFormSchema = z.object({
	setup_token: z
		.string()
		.trim()
		.min(1, { error: () => schemaMessage("setupToken", "Enter the setup token configured for this Bifrost instance") }),
});

export type SetupTokenFormSchema = z.infer<typeof setupTokenFormSchema>;