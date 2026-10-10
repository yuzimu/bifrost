import type {
	AdaptiveConfig,
	AdaptiveSnapshot,
	CircuitPolicy,
	CircuitPolicyResponse,
	CircuitState,
	GuardrailEvaluationRequest,
	GuardrailEvaluationResult,
	GuardrailProfileConfig,
	GuardrailProfile,
	GuardrailProvider,
	GuardrailRule,
	GuardrailRuleInput,
	ReleaseHoldRequest,
} from "@/lib/types/forkFeatures";
import { baseApi } from "./baseApi";

export const forkFeaturesApi = baseApi.injectEndpoints({
	endpoints: (builder) => ({
		getForkGuardrailProviders: builder.query<GuardrailProvider[], void>({
			query: () => "/guardrails",
			providesTags: ["Guardrails"],
		}),
		saveForkGuardrailProfile: builder.mutation<
			GuardrailProfile,
			{
				provider: string;
				id?: number;
				name: string;
				enabled: boolean;
				config: GuardrailProfileConfig;
			}
		>({
			query: ({ provider, id, ...body }) => ({
				url: `/guardrails/${encodeURIComponent(provider)}`,
				method: id === undefined ? "POST" : "PUT",
				body: { ...body, ...(id === undefined ? {} : { id }) },
			}),
			invalidatesTags: ["Guardrails", "GuardrailRules"],
		}),
		deleteForkGuardrailProfile: builder.mutation<{ message: string }, { provider: string; id: number }>({
			query: ({ provider, id }) => ({
				url: `/guardrails/${encodeURIComponent(provider)}`,
				method: "DELETE",
				body: { id },
			}),
			invalidatesTags: ["Guardrails", "GuardrailRules"],
		}),
		getForkGuardrailRules: builder.query<{ rules: GuardrailRule[]; count: number }, void>({
			query: () => "/guardrails/rules",
			providesTags: ["GuardrailRules"],
		}),
		saveForkGuardrailRule: builder.mutation<GuardrailRule, { id?: number; rule: GuardrailRuleInput }>({
			query: ({ id, rule }) => ({
				url: id === undefined ? "/guardrails/rules" : `/guardrails/rules/${id}`,
				method: id === undefined ? "POST" : "PUT",
				body: rule,
			}),
			invalidatesTags: ["GuardrailRules"],
		}),
		deleteForkGuardrailRule: builder.mutation<{ message: string }, number>({
			query: (id) => ({ url: `/guardrails/rules/${id}`, method: "DELETE" }),
			invalidatesTags: ["GuardrailRules"],
		}),
		evaluateForkGuardrails: builder.mutation<GuardrailEvaluationResult, GuardrailEvaluationRequest>({
			query: (body) => ({ url: "/guardrails/evaluate", method: "POST", body }),
		}),
		getForkAdaptiveConfig: builder.query<AdaptiveConfig, void>({
			query: () => "/load-balancer-config",
			providesTags: ["LoadBalancerConfig"],
		}),
		saveForkAdaptiveConfig: builder.mutation<AdaptiveConfig, AdaptiveConfig>({
			query: (body) => ({ url: "/load-balancer-config", method: "PUT", body }),
			invalidatesTags: ["LoadBalancerConfig"],
		}),
		getForkAdaptiveSnapshot: builder.query<AdaptiveSnapshot, void>({
			query: () => "/adaptive-routing",
			providesTags: ["LoadBalancerHistory"],
		}),
		releaseForkHeldKeys: builder.mutation<{ cleared: string[]; count: number }, ReleaseHoldRequest>({
			query: (body) => ({ url: "/load-balancer-config/conditions/clear", method: "POST", body }),
			invalidatesTags: ["LoadBalancerHistory"],
		}),
		getForkCircuitPolicies: builder.query<{ policies: CircuitPolicy[]; count: number }, void>({
			query: () => "/circuit-breaker/policies",
			transformResponse: (response: { policies: CircuitPolicyResponse[]; count: number }) => ({
				...response,
				policies: response.policies.map((policy) => ({
					...policy,
					default_cooldown: `${policy.default_cooldown}ns`,
					primary_key_ids: policy.primary_key_ids ?? [],
				})),
			}),
			providesTags: ["CircuitBreakerPolicies"],
		}),
		saveForkCircuitPolicy: builder.mutation<CircuitPolicyResponse, { name?: string; policy: CircuitPolicy }>({
			query: ({ name, policy }) => ({
				url: name === undefined ? "/circuit-breaker/policies" : `/circuit-breaker/policies/${encodeURIComponent(name)}`,
				method: name === undefined ? "POST" : "PUT",
				body: policy,
			}),
			invalidatesTags: ["CircuitBreakerPolicies", "CircuitBreakerState"],
		}),
		deleteForkCircuitPolicy: builder.mutation<{ message: string }, string>({
			query: (name) => ({ url: `/circuit-breaker/policies/${encodeURIComponent(name)}`, method: "DELETE" }),
			invalidatesTags: ["CircuitBreakerPolicies", "CircuitBreakerState"],
		}),
		getForkCircuitState: builder.query<{ circuits: Record<string, CircuitState> }, void>({
			query: () => "/circuit-breaker/state",
			providesTags: ["CircuitBreakerState"],
		}),
	}),
});

export const {
	useGetForkGuardrailProvidersQuery,
	useSaveForkGuardrailProfileMutation,
	useDeleteForkGuardrailProfileMutation,
	useGetForkGuardrailRulesQuery,
	useSaveForkGuardrailRuleMutation,
	useDeleteForkGuardrailRuleMutation,
	useEvaluateForkGuardrailsMutation,
	useGetForkAdaptiveConfigQuery,
	useSaveForkAdaptiveConfigMutation,
	useGetForkAdaptiveSnapshotQuery,
	useReleaseForkHeldKeysMutation,
	useGetForkCircuitPoliciesQuery,
	useSaveForkCircuitPolicyMutation,
	useDeleteForkCircuitPolicyMutation,
	useGetForkCircuitStateQuery,
} = forkFeaturesApi;