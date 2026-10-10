import { createFileRoute } from "@tanstack/react-router";
import SkillsRepoPage from "./page";
function RouteComponent() {
	return <SkillsRepoPage />;
}
export const Route = createFileRoute("/workspace/skills-repo")({
	component: RouteComponent,
});