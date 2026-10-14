// The browser engine Dialect runs in, for About: WebView2 in the desktop app, the browser in the web build.

/** The browser's name and version from a user agent string, or null when it isn't one of these. */
export function engineFromUserAgent(ua: string, kind: 'web' | 'desktop'): string | null {
  const edge = /\bEdg\/([\d.]+)/.exec(ua)
  if (edge) return `${kind === 'desktop' ? 'WebView2' : 'Microsoft Edge'} ${edge[1]}`
  const firefox = /\bFirefox\/([\d.]+)/.exec(ua)
  if (firefox) return `Firefox ${firefox[1]}`
  const chrome = /\bChrome\/([\d.]+)/.exec(ua)
  if (chrome) return `${kind === 'desktop' ? 'WebView2' : 'Chrome'} ${chrome[1]}`
  const safari = /\bVersion\/([\d.]+).*\bSafari\//.exec(ua)
  if (safari) return `Safari ${safari[1]}`
  return null
}

interface Brand {
  brand: string
  version: string
}
interface UserAgentData {
  getHighEntropyValues: (hints: string[]) => Promise<{ fullVersionList?: Brand[] }>
}

/**
 * The engine with its full version where the browser gives it (Chromium's user agent string reduces it to "155.0.0.0";
 * navigator.userAgentData has the full one), else from the user agent string, else "unknown".
 */
export async function engineVersion(kind: 'web' | 'desktop'): Promise<string> {
  const fallback = engineFromUserAgent(navigator.userAgent, kind) ?? 'unknown'
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  if (!data) return fallback
  try {
    const { fullVersionList = [] } = await data.getHighEntropyValues(['fullVersionList'])
    const edge = fullVersionList.find((b) => b.brand === 'Microsoft Edge' || b.brand === 'Microsoft Edge WebView2')
    if (edge) return `${kind === 'desktop' ? 'WebView2' : 'Microsoft Edge'} ${edge.version}`
    const chrome = fullVersionList.find((b) => b.brand === 'Google Chrome' || b.brand === 'Chromium')
    if (chrome) return `${kind === 'desktop' ? 'WebView2' : chrome.brand === 'Chromium' ? 'Chromium' : 'Chrome'} ${chrome.version}`
  } catch {
    // Not allowed here: the user agent string's version will do.
  }
  return fallback
}
