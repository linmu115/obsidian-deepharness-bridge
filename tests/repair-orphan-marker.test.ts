import { describe, expect, it } from "vitest";

import { removeSingleOrphanReferenceClosingMarker } from "../scripts/repair-orphan-reference-marker.mjs";

describe("orphan dsh-reference marker repair", () => {
  it("removes one standalone closing marker without changing surrounding text", () => {
    expect(removeSingleOrphanReferenceClosingMarker("前文\r\n<!-- /dsh-reference -->\r\n后文\r\n"))
      .toBe("前文\r\n后文\r\n");
  });

  it("refuses notes with a matching opening marker or an ambiguous repair", () => {
    expect(() => removeSingleOrphanReferenceClosingMarker(
      "<!-- dsh-reference:{\"referenceId\":\"r1\"} -->\n<!-- /dsh-reference -->\n",
    )).toThrow(/opening marker/);
    expect(() => removeSingleOrphanReferenceClosingMarker("正文\n")).toThrow(/found 0/);
    expect(() => removeSingleOrphanReferenceClosingMarker(
      "<!-- /dsh-reference -->\n<!-- /dsh-reference -->\n",
    )).toThrow(/found 2/);
  });
});
