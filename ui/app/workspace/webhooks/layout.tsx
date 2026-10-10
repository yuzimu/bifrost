import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import WebhooksPage from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	// Render the endpoints list at the base path; defer to child routes (e.g. /deliveries).
	return childMatches.length === 0 ? <WebhooksPage /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/webhooks")({
	component: RouteComponent,
});