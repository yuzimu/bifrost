import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import GuardrailsPage from "./page";

function RouteComponent() {
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <GuardrailsPage /> : <Outlet />;
}

export const Route = createFileRoute("/workspace/guardrails")({
	component: RouteComponent,
});