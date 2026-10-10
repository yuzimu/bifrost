import { createFileRoute } from "@tanstack/react-router";
import WebhookDeliveriesPage from "./page";
function RouteComponent() {
	return <WebhookDeliveriesPage />;
}
export const Route = createFileRoute("/workspace/webhooks/deliveries")({
	component: RouteComponent,
});