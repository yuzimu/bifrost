import { createFileRoute, Outlet, useChildMatches } from "@tanstack/react-router";
import Providers from "./page";
function RouteComponent() {
	const childMatches = useChildMatches();
	return childMatches.length === 0 ? <Providers /> : <Outlet />;
}
export const Route = createFileRoute("/workspace/providers")({
	component: RouteComponent,
});