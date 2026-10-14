// The browser engine and the operating system Dialect runs in, for About: WebView2 in the desktop app, the browser in the
// web build.

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
  getHighEntropyValues: (hints: string[]) => Promise<{ fullVersionList?: Brand[]; platformVersion?: string }>
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

/** The operating system from a user agent string, or null when it names none of these. */
export function osFromUserAgent(ua: string): string | null {
  // Windows 11 still says "Windows NT 10.0": only navigator.userAgentData tells it from 10 (osVersion).
  if (/\bWindows NT\b/.test(ua)) return 'Windows'
  if (/\b(iPhone|iPad)\b/.test(ua)) return 'iOS'
  if (/\bMac OS X\b/.test(ua)) return 'macOS'
  if (/\bAndroid\b/.test(ua)) return 'Android'
  if (/\bCrOS\b/.test(ua)) return 'ChromeOS'
  if (/\bLinux\b/.test(ua)) return 'Linux'
  return null
}

/** Windows' name from navigator.userAgentData's platformVersion: 13 and up is Windows 11, 1 to 12 Windows 10. */
export function windowsName(platformVersion: string): string {
  const major = Number(platformVersion.split('.')[0])
  return major >= 13 ? 'Windows 11' : major >= 1 ? 'Windows 10' : 'Windows'
}

/** The operating system, as exactly as the browser tells it (Windows 10 or 11 only through userAgentData), or null. */
export async function osVersion(): Promise<string | null> {
  const fallback = osFromUserAgent(navigator.userAgent)
  const data = (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData
  if (!data || fallback !== 'Windows') return fallback
  try {
    const { platformVersion } = await data.getHighEntropyValues(['platformVersion'])
    if (platformVersion) return windowsName(platformVersion)
  } catch {
    // Not allowed here: "Windows" will do.
  }
  return fallback
}
