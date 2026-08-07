export type TranscriptTextRange = { start: number; end: number };

export function utf8ByteRangeToTextRange(
  text: string,
  startByte: number,
  endByte: number,
): TranscriptTextRange | null {
  if (
    !Number.isSafeInteger(startByte) ||
    !Number.isSafeInteger(endByte) ||
    startByte < 0 ||
    endByte <= startByte
  ) {
    return null;
  }

  let byteOffset = 0;
  let codeUnitOffset = 0;
  let start: number | null = startByte === 0 ? 0 : null;
  let end: number | null = null;
  for (const character of text) {
    if (byteOffset === startByte) {
      start = codeUnitOffset;
    }
    if (byteOffset === endByte) {
      end = codeUnitOffset;
      break;
    }
    byteOffset += new TextEncoder().encode(character).length;
    codeUnitOffset += character.length;
    if (byteOffset > startByte && start === null) {
      return null;
    }
    if (byteOffset > endByte) {
      return null;
    }
  }
  if (byteOffset === startByte) {
    start = codeUnitOffset;
  }
  if (byteOffset === endByte) {
    end = codeUnitOffset;
  }
  return start !== null && end !== null ? { start, end } : null;
}
