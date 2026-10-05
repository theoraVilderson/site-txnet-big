/**
 * A browser's user agent as a person would name it — "Chrome on Windows" —
 * for the active-sessions list (SES-1-b).
 *
 * `null` for anything it cannot name (a script, an unknown engine): the list
 * then says "unknown browser" rather than guessing, because a session list is
 * read to spot a device that is *not* yours, and a wrong name hides one.
 *
 * Order matters: Edge, Opera and Samsung Internet all also say `Chrome`, and
 * Chrome also says `Safari`.
 */
export function describeDevice(userAgent: string | null): { browser: string; os: string } | null {
  if (!userAgent) return null;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const os = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (!browser || !os) return null;
  return { browser, os };
}

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\bOPR\/|\bOpera\b/, "Opera"],
  [/\bSamsungBrowser\//, "Samsung Internet"],
  [/\bFirefox\/|\bFxiOS\//, "Firefox"],
  [/\bChrome\/|\bCriOS\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\bAndroid\b/, "Android"],
  [/\biPhone\b|\biPod\b/, "iOS"],
  [/\biPad\b/, "iPadOS"],
  [/\bWindows NT\b/, "Windows"],
  [/\bMac OS X\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];
