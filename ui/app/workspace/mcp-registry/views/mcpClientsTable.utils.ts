import { MCPClient } from "@/lib/types/mcp";

export function canReconnectMCPClient(
	config: Pick<MCPClient["config"], "auth_type" | "connection_type" | "needs_session_stickiness">,
): boolean {
	const alwaysPerCall = config.auth_type === "per_user_oauth" || config.auth_type === "per_user_headers";
	const sharedButPerCallViaStickiness = config.connection_type === "http" && config.needs_session_stickiness !== true;
	return !(alwaysPerCall || sharedButPerCallViaStickiness);
}