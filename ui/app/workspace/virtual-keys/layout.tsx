import { createFileRoute } from "@tanstack/react-router";
import VirtualKeysRedirectPage from "./page";
function RouteComponent() {
	return <VirtualKeysRedirectPage />;
}
export const Route = createFileRoute("/workspace/virtual-keys")({
	component: RouteComponent,
});