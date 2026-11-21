/**
 * WebVTT cue text → a small node tree the caption layer renders with React. Supports the cue
 * markup subtitles use in practice (`<i>`, `<b>`, `<u>`, `<c.class>`, `<v Speaker>`, `<lang>`,
 * `<ruby>`/`<rt>`); timestamps and unknown tags are dropped, text is never parsed as HTML.
 */

export type CueNode =
  | { type: "text"; text: string }
  | { type: "br" }
  | {
      type: "i" | "b" | "u" | "span" | "ruby" | "rt";
      classes: string[];
      voice: string | null;
      children: CueNode[];
    };

type Element = Extract<CueNode, { children: CueNode[] }>;

const TAG_TYPES: Record<string, Element["type"]> = {
  i: "i",
  b: "b",
  u: "u",
  c: "span",
  v: "span",
  lang: "span",
  ruby: "ruby",
  rt: "rt",
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  nbsp: " ",
  lrm: "‎",
  rlm: "‏",
  quot: '"',
  apos: "'",
};

export function decodeCueEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (body.startsWith("#")) {
      return safeFromCodePoint(Number.parseInt(body.slice(1), 10), match);
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

export function parseCueText(text: string): CueNode[] {
  const root: Element = { type: "span", classes: [], voice: null, children: [] };
  const stack: { tag: string; node: Element }[] = [{ tag: "", node: root }];
  const current = () => (stack[stack.length - 1] as { node: Element }).node;

  const pushText = (raw: string) => {
    const lines = decodeCueEntities(raw).split(/\r?\n/);
    lines.forEach((line, index) => {
      if (index > 0) current().children.push({ type: "br" });
      if (line) current().children.push({ type: "text", text: line });
    });
  };

  const tagPattern = /<([^>]*)>/g;
  let last = 0;
  for (let match = tagPattern.exec(text); match !== null; match = tagPattern.exec(text)) {
    if (match.index > last) pushText(text.slice(last, match.index));
    last = match.index + match[0].length;
    const body = (match[1] ?? "").trim();
    if (body.startsWith("/")) {
      const name = body.slice(1).split(/[\s.]/)[0]?.toLowerCase() ?? "";
      const at = findLastIndex(stack, (entry) => entry.tag === name);
      if (at > 0) stack.length = at;
      continue;
    }
    const [head = "", ...annotation] = body.split(/\s+/);
    const [rawName = "", ...classes] = head.split(".");
    const name = rawName.toLowerCase();
    const type = TAG_TYPES[name];
    if (!type) continue; // timestamps (<00:01.000>) and unknown tags
    const node: Element = {
      type,
      classes: classes.filter(Boolean),
      voice: name === "v" ? annotation.join(" ") || null : null,
      children: [],
    };
    current().children.push(node);
    stack.push({ tag: name, node });
  }
  if (last < text.length) pushText(text.slice(last));
  return root.children;
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (predicate(items[i] as T)) return i;
  }
  return -1;
}

/** Plain text of a cue (for announcements and tests). */
export function cueNodesToText(nodes: readonly CueNode[]): string {
  return nodes
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.type === "br") return "\n";
      return cueNodesToText(node.children);
    })
    .join("");
}
