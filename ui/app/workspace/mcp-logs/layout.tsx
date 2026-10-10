import { createFileRoute } from "@tanstack/react-router";
import MCPLogsPage from "./page";
function RouteComponent() {
	return <MCPLogsPage />;
}
export const Route = createFileRoute("/workspace/mcp-logs")({
	component: RouteComponent,
});