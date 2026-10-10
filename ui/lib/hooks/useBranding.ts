export interface BrandingAssets {
	logoSrc: string;
	iconSrc: string;
	logoAlt: string;
}

export function getCachedBrandingAssets(isDark: boolean): BrandingAssets {
	return {
		logoSrc: isDark ? "/bifrost-logo-dark.webp" : "/bifrost-logo.webp",
		iconSrc: isDark ? "/bifrost-icon-dark.webp" : "/bifrost-icon.webp",
		logoAlt: "Bifrost",
	};
}

export function useBranding(isDark: boolean): BrandingAssets {
	return getCachedBrandingAssets(isDark);
}