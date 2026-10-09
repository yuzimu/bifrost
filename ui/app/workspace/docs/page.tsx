import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import GradientHeader from "@/components/ui/gradientHeader";
import { BookOpen, Code, ExternalLink, FileText, GitBranch, Play, Shield, Users, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";

const docSections = [
	{
		id: "quickStart",
		testId: "quick-start",
		icon: Play,
		url: "https://github.com/maximhq/bifrost/tree/main/docs/quickstart",
		badge: "popular",
		items: ["httpTransport", "goPackage", "docker"],
	},
	{
		id: "architecture",
		testId: "architecture",
		icon: GitBranch,
		url: "https://github.com/maximhq/bifrost/tree/main/docs/architecture",
		items: ["overview", "requestFlow", "concurrency", "decisions"],
	},
	{
		id: "usage",
		testId: "usage-guides",
		icon: BookOpen,
		url: "https://github.com/maximhq/bifrost/tree/main/docs/usage",
		badge: "comprehensive",
		items: ["providers", "keys", "errors", "memory"],
	},
	{
		id: "contributing",
		testId: "contributing",
		icon: Users,
		url: "https://github.com/maximhq/bifrost/tree/main/docs/contributing",
		items: ["guide", "providers", "plugins", "conventions"],
	},
	{
		id: "integrations",
		testId: "integration-examples",
		icon: Code,
		url: "https://github.com/maximhq/bifrost/tree/main/docs/usage/http-transport/integrations",
		items: ["openai", "anthropic", "genai", "migration"],
	},
	{
		id: "benchmarks",
		testId: "benchmarks",
		icon: Zap,
		url: "https://github.com/maximhq/bifrost/blob/main/docs/benchmarks.md",
		items: ["results", "metrics", "tuning", "hardware"],
	},
];

const featuredDocs = [
	{
		id: "mcp",
		testId: "mcp-documentation",
		href: "https://github.com/maximhq/bifrost/blob/main/docs/mcp.md",
		icon: FileText,
		borderColor: "border-primary/20",
		backgroundColor: "bg-primary/5",
		iconColor: "text-primary",
	},
	{
		id: "governance",
		testId: "governance-plugin",
		href: "https://github.com/maximhq/bifrost/blob/main/docs/governance.md",
		icon: Shield,
		borderColor: "border-green-200 dark:border-green-800",
		backgroundColor: "bg-green-50 dark:bg-green-950/20",
		iconColor: "text-green-600",
	},
];

/** 按当前语言渲染文档目录，链接与自动化标识不随语言改变。 */
export default function DocsPage() {
	const { t } = useTranslation("config");
	const { t: te } = useTranslation("enterprise");
	return (
		<div className="dark:bg-card bg-white">
			<div className="mx-auto max-w-7xl">
				<div className="space-y-8">
					{/* Header */}
					<div className="space-y-4 text-center">
						<div className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm">
							<BookOpen className="h-4 w-4" />
							<span className="font-semibold">{t("docs.title")}</span>
						</div>
						<GradientHeader title={te("docs.headline")} />
						<p className="text-muted-foreground mx-auto max-w-2xl text-lg">{t("docs.subtitle")}</p>
						<div className="flex justify-center gap-4">
							<Button asChild>
								<a
									href="https://github.com/maximhq/bifrost/tree/main/docs"
									target="_blank"
									rel="noopener noreferrer"
									data-testid="docs-view-full-documentation-link"
								>
									<ExternalLink className="mr-2 h-4 w-4" />
									{te("docs.fullDocumentation")}
								</a>
							</Button>
							<Button variant="outline" asChild>
								<a
									href="https://github.com/maximhq/bifrost/tree/main/docs/quickstart"
									target="_blank"
									rel="noopener noreferrer"
									data-testid="docs-quick-start-guide-link"
								>
									<Play className="mr-2 h-4 w-4" />
									{te("docs.quickStartGuide")}
								</a>
							</Button>
						</div>
					</div>

					{/* Documentation Sections */}
					<div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
						{docSections.map((section) => {
							const Icon = section.icon;
							return (
								<Card key={section.id} className="group transition-all duration-200 hover:shadow-lg">
									<CardHeader>
										<div className="flex items-center justify-between">
											<div className="bg-primary/10 group-hover:bg-primary/20 mb-4 flex h-12 w-12 items-center justify-center rounded-lg transition-colors">
												<Icon className="text-primary h-6 w-6" />
											</div>
											{section.badge && (
												<Badge variant="secondary" className="text-xs">
													{te(`docs.${section.badge}`)}
												</Badge>
											)}
										</div>
										<CardTitle className="text-xl">{te(`docs.sections.${section.id}.title`)}</CardTitle>
										<CardDescription className="leading-relaxed">{te(`docs.sections.${section.id}.description`)}</CardDescription>
									</CardHeader>
									<CardContent className="flex h-full flex-col justify-between gap-8">
										<div className="space-y-4">
											<ul className="space-y-2">
												{section.items.map((item, index) => (
													<li key={index} className="text-muted-foreground flex items-center gap-2 text-sm">
														<div className="bg-primary h-1.5 w-1.5 rounded-full" />
														{te(`docs.sections.${section.id}.${item}`)}
													</li>
												))}
											</ul>
										</div>
										<Button asChild variant="outline" className="w-full">
											<a
												href={section.url}
												target="_blank"
												rel="noopener noreferrer"
												className="flex items-center justify-center gap-2"
												data-testid={`docs-read-more-${section.testId}`}
											>
												{te("docs.readMore")}
												<ExternalLink className="h-4 w-4" />
											</a>
										</Button>
									</CardContent>
								</Card>
							);
						})}
					</div>

					{/* Featured Documentation */}
					<div className="grid gap-6 pt-8 md:grid-cols-2">
						{featuredDocs.map((doc, index) => (
							<Card className={`${doc.borderColor} ${doc.backgroundColor}`} key={index}>
								<CardHeader>
									<CardTitle className="flex items-center gap-2">
										<doc.icon className={`h-5 w-5 ${doc.iconColor}`} />
										{te(`docs.featured.${doc.id}.title`)}
									</CardTitle>
									<CardDescription>{te(`docs.featured.${doc.id}.description`)}</CardDescription>
								</CardHeader>
								<CardContent>
									<p className="text-muted-foreground mb-4 text-sm">{te(`docs.featured.${doc.id}.content`)}</p>
									<Button asChild className="w-full">
										<a href={doc.href} target="_blank" rel="noopener noreferrer" data-testid={`docs-featured-${doc.testId}`}>
											<doc.icon className="mr-2 h-4 w-4" />
											{te(`docs.featured.${doc.id}.button`)}
										</a>
									</Button>
								</CardContent>
							</Card>
						))}
					</div>
				</div>
			</div>
		</div>
	);
}