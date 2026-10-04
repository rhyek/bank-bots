/**
 * The user agent a scrape presents. Headless Chromium announces itself as `HeadlessChrome/<v>`,
 * which bank sites treat as a bot, so the context overrides it — with the launched browser's own
 * major, so the claim never drifts from the engine across Playwright upgrades.
 */
export function chromeUserAgent(browserVersion: string): string {
  const major = /^(\d+)\./.exec(browserVersion)?.[1];
  if (!major) {
    throw new Error(`Cannot read a major from browser version "${browserVersion}"`);
  }
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
