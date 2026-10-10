import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import CircuitBreakerPage from "./page";

function RouteComponent() {
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <CircuitBreakerPage /> : <Outlet />;
}

export const Route = createFileRoute("/workspace/circuit-breaker")({
	component: RouteComponent,
});