/**
 * Profile avatars. Original artwork, drawn by `tools/media` from the `art` parameters
 * (character kind, background, face and accent colours, expression).
 */
type Kind =
  | "smiley"
  | "cat"
  | "bear"
  | "fox"
  | "owl"
  | "frog"
  | "robot"
  | "alien"
  | "ghost"
  | "monster"
  | "astronaut"
  | "panda";
type Expression = "smile" | "grin" | "wink" | "wow" | "cool" | "calm" | "laugh";

const avatar = (
  id: string,
  name: string,
  groupId: string,
  kind: Kind,
  bg: string,
  face: string,
  accent: string,
  expression: Expression,
) => ({ id: `a-${id}`, name, groupId, art: { kind, bg, face, accent, expression } });

export const avatarGroups = [
  { id: "ag-classics", name: "Classics" },
  { id: "ag-critters", name: "Critters" },
  { id: "ag-far-out", name: "Far Out" },
  { id: "ag-after-dark", name: "After Dark" },
];

export const avatars = [
  avatar("sunny", "Sunny", "ag-classics", "smiley", "#2a6fdb", "#ffd23f", "#ff7aa2", "smile"),
  avatar(
    "tangerine",
    "Tangerine",
    "ag-classics",
    "smiley",
    "#0f9d8a",
    "#ff9f43",
    "#ff5e7e",
    "grin",
  ),
  avatar(
    "bubblegum",
    "Bubblegum",
    "ag-classics",
    "smiley",
    "#5b3cc4",
    "#ff8fc7",
    "#ff4f81",
    "wink",
  ),
  avatar("mint", "Mint", "ag-classics", "smiley", "#1d2b53", "#7ce0b5", "#ff8a8a", "cool"),
  avatar("lemon", "Lemon", "ag-classics", "smiley", "#e4572e", "#fff07c", "#f9a03f", "laugh"),
  avatar("sky", "Sky", "ag-classics", "smiley", "#f4a259", "#8ecae6", "#ff7b9c", "calm"),
  avatar("plum", "Plum", "ag-classics", "smiley", "#ffbe0b", "#b388eb", "#ff5c8a", "wow"),
  avatar("whiskers", "Whiskers", "ag-critters", "cat", "#3d5a80", "#ffb26b", "#ff7d9c", "smile"),
  avatar("midnight-cat", "Midnight", "ag-critters", "cat", "#ffcb47", "#3b3b58", "#ff8fab", "wink"),
  avatar("bramble", "Bramble", "ag-critters", "bear", "#7bc950", "#a0673a", "#f2c094", "grin"),
  avatar("bamboo", "Bamboo", "ag-critters", "panda", "#56c4a1", "#ffffff", "#f7a8b8", "calm"),
  avatar("rusty", "Rusty", "ag-critters", "fox", "#264653", "#f4a261", "#ff6b6b", "smile"),
  avatar("hoot", "Hoot", "ag-critters", "owl", "#e9c46a", "#7a5c3e", "#f4a261", "wow"),
  avatar("lily", "Lily", "ag-critters", "frog", "#f28482", "#84dcc6", "#ff6f91", "laugh"),
  avatar("bolt", "Bolt", "ag-far-out", "robot", "#ff6b35", "#c9d6df", "#3ddc97", "smile"),
  avatar("pixel", "Pixel", "ag-far-out", "robot", "#3a0ca3", "#f1c0e8", "#4cc9f0", "calm"),
  avatar("zorp", "Zorp", "ag-far-out", "alien", "#14213d", "#90e0ef", "#ffd166", "grin"),
  avatar("blip", "Blip", "ag-far-out", "alien", "#ff9e00", "#9ef01a", "#ff006e", "wow"),
  avatar("cosmo", "Cosmo", "ag-far-out", "astronaut", "#0b132b", "#ffb4a2", "#ff6b6b", "smile"),
  avatar("nova", "Nova", "ag-far-out", "astronaut", "#7209b7", "#ffe8d6", "#4cc9f0", "wink"),
  avatar("boo", "Boo", "ag-after-dark", "ghost", "#22223b", "#f2e9e4", "#ff8fab", "smile"),
  avatar("wisp", "Wisp", "ag-after-dark", "ghost", "#0f4c5c", "#caf0f8", "#ffb703", "wow"),
  avatar("gnash", "Gnash", "ag-after-dark", "monster", "#ffd60a", "#8338ec", "#ff006e", "grin"),
  avatar("fuzz", "Fuzz", "ag-after-dark", "monster", "#06d6a0", "#ef476f", "#ffd166", "grin"),
  avatar("grumble", "Grumble", "ag-after-dark", "monster", "#ff7f51", "#2ec4b6", "#3a0ca3", "grin"),
  avatar("nightowl", "Night Owl", "ag-after-dark", "owl", "#1b263b", "#415a77", "#ffd166", "calm"),
  avatar("shadow-cat", "Shadow", "ag-after-dark", "cat", "#6a4c93", "#1f1f2e", "#ffd166", "cool"),
  avatar("toad", "Toad", "ag-after-dark", "frog", "#283618", "#a7c957", "#bc4749", "cool"),
];
