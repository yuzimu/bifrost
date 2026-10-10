import { RateLimit } from "@/lib/types/governance";

export type ProfileRateLimit = Partial<RateLimit> | undefined;

export function hasProfileRateLimit(apRL: ProfileRateLimit): apRL is Partial<RateLimit> {
	return !!(apRL && (apRL.token_max_limit != null || apRL.request_max_limit != null));
}

export function resolveDisplayRateLimit({
	isManagedByProfile,
	isEntityGoverned = false,
	profileRateLimit,
	vkRateLimit,
}: {
	isManagedByProfile: boolean;

	isEntityGoverned?: boolean;
	profileRateLimit: ProfileRateLimit;
	vkRateLimit: RateLimit | undefined;
}): RateLimit | undefined {
	if (!isManagedByProfile || isEntityGoverned) return vkRateLimit;
	if (!hasProfileRateLimit(profileRateLimit)) return undefined;
	return {
		id: "",
		token_max_limit: profileRateLimit.token_max_limit,
		token_reset_duration: profileRateLimit.token_reset_duration,
		token_current_usage: profileRateLimit.token_current_usage ?? 0,
		token_last_reset: profileRateLimit.token_last_reset ?? "",
		request_max_limit: profileRateLimit.request_max_limit,
		request_reset_duration: profileRateLimit.request_reset_duration,
		request_current_usage: profileRateLimit.request_current_usage ?? 0,
		request_last_reset: profileRateLimit.request_last_reset ?? "",
	};
}