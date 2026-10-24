import { describe, expect, it } from "vitest";
import { GET, dynamic } from "./route";

// hosting H24 (OPS-1-aa): the container check asks whether the Next server
// answers, and nothing else — no session, no tenant, no locale-service.
describe("GET /api/health", () => {
  it("answers 200 from a page built once, so a check every 10s renders nothing", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(dynamic).toBe("force-static");
  });
});
