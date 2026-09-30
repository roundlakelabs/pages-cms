// Parses a grid aspect option into a CSS aspect-ratio value.
// Accepts "4/3", "4:3" or a number (e.g. 1.5). Falls back to square.
export const parseAspectRatio = (aspect: unknown): string => {
  if (typeof aspect === "number" && aspect > 0) return String(aspect);
  if (typeof aspect === "string") {
    const match = aspect.trim().match(/^(\d+(?:\.\d+)?)\s*[/:]\s*(\d+(?:\.\d+)?)$/);
    if (match && Number(match[1]) > 0 && Number(match[2]) > 0) return `${match[1]} / ${match[2]}`;
    if (Number(aspect) > 0) return aspect.trim();
  }
  return "1 / 1";
};
