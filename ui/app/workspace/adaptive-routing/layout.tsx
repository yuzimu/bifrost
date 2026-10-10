import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import AdaptiveRoutingPage from "./page";

function RouteComponent() {
	const childMatches = useChildMatches();
	// Render the dashboard at the base path; defer to child routes (e.g. /settings).
	return childMatches.length === 0 ? <AdaptiveRoutingPage /> : <Outlet />;
}

export const Route = createFileRoute("/workspace/adaptive-routing")({
	component: RouteComponent,
});