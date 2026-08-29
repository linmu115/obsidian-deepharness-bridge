import { describe, expect, it, vi } from "vitest";

import { launchUrlFromLog, resolveDshViewerUrl } from "../src/webviewer/launch-url.ts";

describe("authenticated DSH Web Viewer launch URL", () => {
  it("uses the latest launch URL emitted by the configured DSH process", () => {
    const log = [
      "dsh web: http://127.0.0.1:3080/?token=old",
      "ready",
      "dsh web: http://127.0.0.1:3080/?token=current",
    ].join("\n");
    expect(launchUrlFromLog(log, "http://127.0.0.1:3080"))
      .toBe("http://127.0.0.1:3080/?token=current");
  });

  it("rejects a launch URL for a different or non-loopback server", () => {
    expect(() => launchUrlFromLog(
      "dsh web: http://127.0.0.1:3081/?token=wrong",
      "http://127.0.0.1:3080",
    )).toThrow(/does not match/i);
    expect(() => launchUrlFromLog(
      "dsh web: https://example.com/?token=wrong",
      "http://127.0.0.1:3080",
    )).toThrow(/loopback/i);
  });

  it("reads the configured log on every resolution and falls back when it is unset", async () => {
    const readLog = vi.fn(async () => "dsh web: http://127.0.0.1:3080/?token=fresh");
    const configured = { dshOrigin: "http://127.0.0.1:3080", dshLaunchLogPath: " D:\\dsh.stdout.log " };
    await expect(resolveDshViewerUrl(configured, readLog)).resolves
      .toBe("http://127.0.0.1:3080/?token=fresh");
    await expect(resolveDshViewerUrl(configured, readLog)).resolves
      .toBe("http://127.0.0.1:3080/?token=fresh");
    expect(readLog).toHaveBeenNthCalledWith(1, "D:\\dsh.stdout.log");
    expect(readLog).toHaveBeenCalledTimes(2);

    await expect(resolveDshViewerUrl({
      dshOrigin: "http://127.0.0.1:3080",
      dshLaunchLogPath: "",
    }, readLog)).resolves.toBe("http://127.0.0.1:3080/");
    expect(readLog).toHaveBeenCalledTimes(2);
  });
});
