import i18n from "@/lib/i18n";
import { BifrostErrorResponse } from "@/lib/types/config";
import { getApiBaseUrl } from "@/lib/utils/port";
import { createApi, fetchBaseQuery, type BaseQueryFn } from "@reduxjs/toolkit/query/react";
import { getActiveTempToken, getSuppressGlobal401 } from "./tempToken";
// Auth tokens are now stored in HTTP-only cookies (set by server)
// No client-side token needed — handled by credentials: "include"
export const getTokenFromStorage = (): Promise<string | null> => {
	return Promise.resolve(null);
};
// OSS 会话由服务端 HTTPOnly cookie 管理。
export const setAuthToken = (_token: string | null) => {};
// Helper function to clear all auth-related storage
export const clearAuthStorage = () => {
	if (typeof window === "undefined") {
		return;
	}
	try {
		// Clear traditional auth token
		localStorage.removeItem("bifrost-auth-token");
	} catch (error) {
		console.error("Error clearing auth storage:", error);
	}
};
// Define the base query with authentication headers
const baseQuery = fetchBaseQuery({
	baseUrl: getApiBaseUrl(),
	credentials: "include",
	prepareHeaders: async (headers, { arg }) => {
		// Skip the JSON default for multipart/FormData uploads so the browser
		// can set Content-Type with the multipart boundary itself (e.g. uploadSkillFile).
		const isFormData = arg !== null && typeof arg === "object" && arg.body instanceof FormData;
		if (!isFormData && !headers.has("Content-Type")) {
			headers.set("Content-Type", "application/json");
		}
		// Automatically include token from localStorage in Authorization header
		const token = await getTokenFromStorage();
		if (token) {
			headers.set("Authorization", `Bearer ${token}`);
		}
		// Attach a temp token when a TempTokenScope wrapper is mounted. The
		// dashboard cookie (if present) still takes precedence on the server
		// side; the temp token is the fallback that rescues unauthenticated
		// browsers visiting a scoped page.
		const tempToken = getActiveTempToken();
		if (tempToken) {
			headers.set("X-Bifrost-Temp-Token", tempToken);
		}
		return headers;
	},
});
/** 保留认证处理及原始错误身份，客户端消息不依赖请求时的界面语言。 */
const baseQueryWithErrorHandling: BaseQueryFn = async (args, api, extraOptions) => {
	const result = await baseQuery(args, api, extraOptions);
	// Then handle other error types
	if (result.error) {
		const error = result.error as any;
		if (error?.status === 401) {
			// When a TempTokenScope wrapper is active, the wrapped page handles
			// its own 401 display (an "invalid/expired link" view). Skip the
			// global redirect so the user stays on the page they opened.
			if (getSuppressGlobal401()) {
				return result;
			}
			clearAuthStorage();
			if (typeof window !== "undefined" && !window.location.pathname.includes("/login")) {
				const goto = window.location.pathname + window.location.search;
				window.location.href = `/login?goto=${encodeURIComponent(goto)}`;
			}
			return result;
		}
		// Handle specific error types
		if (error?.status === "FETCH_ERROR" || error?.status === "TIMEOUT_ERROR") {
			return {
				...result,
				error: {
					...error,
					data: {
						error: {
							message: error.status === "TIMEOUT_ERROR" ? "Request timeout" : "Network error: Unable to connect to the server",
						},
					},
				},
			};
		}
		// 原始载荷和诊断不补写；缺失消息的展示兜底由 getErrorMessage 处理。
	}
	return result;
};
// Create the base API
export const baseApi = createApi({
	reducerPath: "api",
	baseQuery: baseQueryWithErrorHandling,
	tagTypes: [
		"Logs",
		"MCPLogs",
		"Providers",
		"MCPClients",
		"Config",
		"CacheConfig",
		"VirtualKeys",
		"Teams",
		"Customers",
		"Budgets",
		"RateLimits",
		"UsageStats",
		"DebugStats",
		"HealthCheck",
		"DBKeys",
		"ProviderKeys",
		"Models",
		"BaseModels",
		"ModelConfigs",
		"ProviderGovernance",
		"Plugins",
		"Guardrails",
		"GuardrailRules",
		"RoutingRules",
		"PricingOverrides",
		"MCPToolGroups",
		"VirtualMCPs",
		"LoadBalancerConfig",
		"LoadBalancerHistory",
		"Folders",
		"Prompts",
		"Versions",
		"Sessions",
		"MCPSessions",
		"MCPPerUserHeaderCredentials",
		"MCPLibrary",
		"FeatureFlags",
		"ComplexityAnalyzerConfig",
		"Skills",
		"OAuth2Grants",
		"OAuth2Config",
		"UserAgentMappings",
		"CircuitBreakerPolicies",
		"CircuitBreakerState",
		"WebhookEndpoints",
		"WebhookDeliveries",
		"Notifications",
		"SidekiqJobs",
		"WarpConfig",
		"WarpBackfillStatus",
		"WarpConversations",
		"Agents",
		"AgentLogs",
	],
	endpoints: () => ({}),
});
export const getErrorCode = (error: unknown): string | undefined => {
	if (typeof error !== "object" || !error || !("data" in error)) {
		return undefined;
	}
	const data = (
		error as {
			data?: BifrostErrorResponse;
		}
	).data;
	return typeof data?.error?.code === "string" ? data.error.code : undefined;
};
/** 按当前语言展示已确认的客户端错误，未知服务端消息和原始诊断保持原样。 */
export const getErrorMessage = (error: unknown): string => {
	if (error === undefined || error === null) {
		return i18n.t("clientErrors.unexpected", { ns: "common" });
	}
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "object" && "status" in error) {
		if (error.status === "TIMEOUT_ERROR") {
			return i18n.t("clientErrors.timeout", { ns: "common" });
		}
		if (error.status === "FETCH_ERROR") {
			const data = "data" in error ? error.data : undefined;
			const isReleaseNetworkError =
				typeof data === "object" &&
				data !== null &&
				"error" in data &&
				typeof data.error === "object" &&
				data.error !== null &&
				"message" in data.error &&
				data.error.message === "Network error";
			return i18n.t(isReleaseNetworkError ? "clientErrors.network" : "clientErrors.unableToConnect", { ns: "common" });
		}
	}
	if (
		typeof error === "object" &&
		error &&
		"data" in error &&
		error.data &&
		typeof error.data === "object" &&
		"error" in error.data &&
		error.data.error &&
		typeof error.data.error === "object" &&
		"message" in error.data.error &&
		typeof error.data.error.message === "string"
	) {
		return error.data.error.message;
	}
	if (
		typeof error === "object" &&
		"data" in error &&
		typeof error.data === "object" &&
		error.data !== null &&
		"message" in error.data &&
		typeof error.data.message === "string"
	) {
		return error.data.message;
	}
	if (typeof error === "object" && error && "message" in error && typeof error.message === "string") {
		return error.message;
	}
	if (typeof error === "object" && "error" in error && typeof error.error === "string") {
		return error.error;
	}
	return i18n.t("clientErrors.unexpected", { ns: "common" });
};
