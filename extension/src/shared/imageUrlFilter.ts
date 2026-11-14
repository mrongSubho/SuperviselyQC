const NON_WORKSPACE_URL_RE =
  /(github\.com\/|githubusercontent\.com\/|supervisely-ecosystem|youtube\.com\/|vimeo\.com\/|gravatar\.com\/|favicon|logo|avatar|icon|sprite|tutorial|guide|badge|emoji|readme|\.svg(\?|$))/i;

/** Returns true for docs, app-store banners, avatars, or icons that cannot be a labeling target photo. */
export function isNonWorkspaceImageUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) return false;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.startsWith("chrome-extension:")) return true;
  if (trimmed.startsWith("data:") || trimmed.startsWith("blob:")) return false;
  return NON_WORKSPACE_URL_RE.test(trimmed);
}

/**
 * Service Worker fetch fallback is only permitted for origins covered by manifest host_permissions
 * (the active page origin, *.supervisely.com, localhost, or 127.0.0.1). Calling SW fetch on other
 * third-party hosts triggers a chrome-extension:// CORS error.
 */
export function isPermittedServiceWorkerFetchUrl(
  rawUrl: string,
  pageOrigin: string,
): boolean {
  if (!rawUrl || rawUrl.startsWith("blob:") || rawUrl.startsWith("data:")) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl, pageOrigin);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    if (parsed.origin === pageOrigin) {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    return (
      host === "supervisely.com" ||
      host.endsWith(".supervisely.com") ||
      host === "127.0.0.1" ||
      host === "localhost"
    );
  } catch {
    return false;
  }
}
