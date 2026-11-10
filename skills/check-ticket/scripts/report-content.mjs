// Formatting only: never ask an LLM to rewrite the original report body.
export function formatOriginalAnswer(answer, { includeInternalSections = false } = {}) {
  const protectedParts = [];
  let text = String(answer).replace(/```[^\n]*\n[\s\S]*?```|~~~[^\n]*\n[\s\S]*?~~~|`[^`\n]+`/g, value => {
    protectedParts.push(value);
    return `\u0000CODE${protectedParts.length - 1}\u0000`;
  });
  if (!includeInternalSections) {
    const appendix = /^(?:#{1,6}\s*)?(?:\*\*)?(?:Sources\s*:?(?:\*\*)?|(?:⚠️\s*)?(?:\*\*)?Citation audit[^\n]*)\s*$/im.exec(text);
    if (appendix) text = text.slice(0, appendix.index);
  }
  text = text
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/^\s*(?:---+|___+|\*\*\*+)\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.replace(/\u0000CODE(\d+)\u0000/g, (_, index) => protectedParts[Number(index)]);
}
