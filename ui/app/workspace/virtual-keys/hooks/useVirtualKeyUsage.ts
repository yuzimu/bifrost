import type { VirtualKey } from "@/lib/types/governance";
import { getEffectiveBudgetLimit } from "@/lib/utils/governance";

/** 展示虚拟密钥自身预算和限流，不因层级资金来源隐藏其独立限额。 */
export function useVirtualKeyUsage(vk: VirtualKey | null | undefined) {
	const displayBudgets = vk?.budgets;
	const displayRateLimit = vk?.rate_limit;
	const isExhausted =
		(displayBudgets?.some((budget) => budget.current_usage >= getEffectiveBudgetLimit(budget)) ?? false) ||
		(displayRateLimit?.token_current_usage != null &&
			displayRateLimit.token_max_limit != null &&
			displayRateLimit.token_current_usage >= displayRateLimit.token_max_limit) ||
		(displayRateLimit?.request_current_usage != null &&
			displayRateLimit.request_max_limit != null &&
			displayRateLimit.request_current_usage >= displayRateLimit.request_max_limit);
	return { displayBudgets, displayRateLimit, isExhausted };
}
