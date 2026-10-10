import { createFileRoute } from "@tanstack/react-router";
import MCPLibraryPage from "./page";
function RouteComponent() {
	return <MCPLibraryPage />;
}
export const Route = createFileRoute("/workspace/mcp-registry/library")({
	component: RouteComponent,
});