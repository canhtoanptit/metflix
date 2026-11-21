import { describe, expect, it } from "vitest";
import { cueNodesToText, decodeCueEntities, parseCueText } from "../src/core/cue-text.ts";

describe("WebVTT cue text", () => {
  it("keeps plain text and line breaks", () => {
    expect(parseCueText("Hello\nworld")).toEqual([
      { type: "text", text: "Hello" },
      { type: "br" },
      { type: "text", text: "world" },
    ]);
  });

  it("parses italics, classes and voices", () => {
    const nodes = parseCueText("<v Mara>Look</v> <i>there</i> <c.yellow.bg>now</c>");
    expect(nodes[0]).toMatchObject({
      type: "span",
      voice: "Mara",
      children: [{ type: "text", text: "Look" }],
    });
    expect(nodes[2]).toMatchObject({ type: "i", children: [{ type: "text", text: "there" }] });
    expect(nodes[4]).toMatchObject({ type: "span", classes: ["yellow", "bg"] });
    expect(cueNodesToText(nodes)).toBe("Look there now");
  });

  it("drops timestamps and unknown tags, never parses HTML", () => {
    const nodes = parseCueText("<00:01.000>One <script>alert(1)</script><b>two</b>");
    expect(cueNodesToText(nodes)).toBe("One alert(1)two");
    expect(JSON.stringify(nodes)).not.toContain("script");
  });

  it("tolerates unclosed and stray closing tags", () => {
    expect(cueNodesToText(parseCueText("<i>open"))).toBe("open");
    expect(cueNodesToText(parseCueText("text</b> more"))).toBe("text more");
  });

  it("decodes entities", () => {
    expect(decodeCueEntities("Tom &amp; Jerry &lt;3 &#233;&#x41;&nbsp;&bogus;")).toBe(
      "Tom & Jerry <3 éA &bogus;",
    );
  });
});
