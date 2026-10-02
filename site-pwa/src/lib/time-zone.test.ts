/**
 * The panel's half of one clock rule (TZ-1-e, ADR-0108 points 4, 7). What
 * would break silently here, and nowhere else:
 *
 *  - **a browser report never goes over a choice**, and is not sent when it
 *    would change nothing — so a page load costs one read, not a write;
 *  - **a date is drawn in the resolved zone**, not the browser's, once the
 *    session knows it — a user in Tehran who chose Berlin reads Berlin;
 *  - **a saved zone this browser does not list is still offered**, so opening
 *    a picker never silently changes what is stored.
 */
import { formatInstant } from "@/app/(panel)/_lib/datetime";
import { browserReport, setDisplayZone, zoneChoices } from "./time-zone";

describe("browserReport", () => {
  it("reports the browser's zone when the user has none, or only an older report", () => {
    expect(browserReport({ timezone: null, source: null }, "Europe/Berlin")).toEqual({ zone: "Europe/Berlin", source: "browser" });
    expect(browserReport({ timezone: "Asia/Tehran", source: "browser" }, "Europe/Berlin")).toEqual({ zone: "Europe/Berlin", source: "browser" });
  });

  it("sends nothing over the user's choice, for a zone already stored, or with no browser zone", () => {
    expect(browserReport({ timezone: "Asia/Tehran", source: "user" }, "Europe/Berlin")).toBeNull();
    expect(browserReport({ timezone: "Europe/Berlin", source: "browser" }, "Europe/Berlin")).toBeNull();
    expect(browserReport({ timezone: null, source: null }, null)).toBeNull();
  });
});

describe("formatInstant in the resolved zone", () => {
  afterEach(() => setDisplayZone(null));
  const instant = "2026-09-27T22:45:00Z";

  it("draws the instant on the resolved zone's wall clock", () => {
    setDisplayZone("Asia/Tehran");
    expect(formatInstant(instant, "en")).toContain("02:15");
    setDisplayZone("Europe/Berlin");
    expect(formatInstant(instant, "en")).toBe("09/28/2026, 12:45 AM");
  });

  it("ignores a zone this browser cannot read rather than failing the page", () => {
    setDisplayZone("Mars/Olympus");
    expect(formatInstant(instant, "en")).not.toBeNull();
  });
});

describe("zoneChoices", () => {
  it("keeps a saved zone the browser does not list, first, and lists the browser's", () => {
    const zones = zoneChoices("Etc/GMT+5");
    expect(zones[0]).toBe("Etc/GMT+5");
    expect(zones).toContain("Asia/Tehran");
    expect(zones.filter((z) => z === "Asia/Tehran")).toHaveLength(1);
    expect(zoneChoices("Asia/Tehran").filter((z) => z === "Asia/Tehran")).toHaveLength(1);
    expect(zoneChoices(null)).not.toContain(null);
  });
});
