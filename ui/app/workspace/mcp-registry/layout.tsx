import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import MCPServersPage from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <MCPServersPage /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/mcp-registry")({
	component: RouteComponent,
});