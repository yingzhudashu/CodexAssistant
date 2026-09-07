import { describe, expect, it } from "vitest";
import { sanitizeText, projectName, normalizeStatus, deriveTaskStatus, normalizeActiveFlags, normalizeRuntimeStatus, normalizeTurn } from "../src/sanitize.js";

describe("desktop redaction", () => {
  it("removes paths, secrets, whitespace and truncates titles", () => {
    const value = sanitizeText("Fix C:\\Users\\alice\\repo\\src\\index.ts sk-test-secret-value token=other-secret-value\nnext", 30);
    expect(value).not.toContain("C:\\");
    expect(value).not.toContain("sk-test");
    expect(value.length).toBeLessThanOrEqual(30);
    expect(value).not.toMatch(/[\r\n]/);
  });
  it("keeps only the project directory name and maps app-server statuses", () => {
    expect(projectName("D:\\work\\CodexAssistant")).toBe("CodexAssistant");
    expect(normalizeStatus({ type: "systemError" })).toBe("failed");
    expect(normalizeStatus({ type: "active" })).toBe("active");
    expect(normalizeRuntimeStatus({ type: "active", activeFlags: ["waitingOnUserInput"] })).toBe("active");
    expect(normalizeActiveFlags({ type: "active", activeFlags: ["waitingOnUserInput", "invalid"] })).toEqual(["waitingOnUserInput"]);
    expect(deriveTaskStatus(undefined, "active", ["waitingOnApproval"], { status: "inProgress" })).toBe("waiting");
    expect(deriveTaskStatus(undefined, "systemError", [], undefined)).toBe("failed");
    expect(deriveTaskStatus("complete", "idle", [], undefined)).toBe("complete");
    expect(deriveTaskStatus(undefined, "idle", [], { status: "completed" })).toBe("complete");
    expect(deriveTaskStatus(undefined, "idle", [], { status: "interrupted" })).toBe("idle");
    expect(normalizeTurn({ status: "failed", startedAt: 1_700_000_000_000, error: { code: "RPC_FAILED", message: "temporary" } })).toMatchObject({ status: "failed", error: { code: "RPC_FAILED" } });
  });
});
