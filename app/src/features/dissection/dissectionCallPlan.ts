const MAX_CHUNK_CHARACTERS = 2000;
const CHUNKS_PER_MAP_CALL = 4;
const REDUCE_CALLS = 1;
const MAX_REPAIR_CALLS = 1;
const MAX_TOTAL_CALLS = 6;

export type DissectionCallPlan = {
  version: 1;
  chunkCount: number;
  minimumCalls: number;
  maximumCalls: number;
  eligible: boolean;
};

export function buildDissectionCallPlan(transcript: string): DissectionCallPlan {
  const chunkCount = transcript.trim() ? countChunks(transcript) : 0;
  const mapCalls = Math.ceil(chunkCount / CHUNKS_PER_MAP_CALL);
  const minimumCalls = mapCalls + REDUCE_CALLS;
  const maximumCalls = minimumCalls + MAX_REPAIR_CALLS;
  return {
    version: 1,
    chunkCount,
    minimumCalls,
    maximumCalls,
    eligible: chunkCount > 0 && maximumCalls <= MAX_TOTAL_CALLS,
  };
}

function countChunks(transcript: string): number {
  const characters = Array.from(transcript);
  let start = 0;
  let count = 0;
  while (start < characters.length) {
    const hardEnd = Math.min(start + MAX_CHUNK_CHARACTERS, characters.length);
    if (hardEnd === characters.length) {
      count += 1;
      break;
    }
    const paragraphEnd = findLastParagraphEnd(characters, start, hardEnd);
    const sentenceEnd = findLastCharacter(characters, "\u3002", start, hardEnd);
    const end = paragraphEnd >= start
      ? paragraphEnd + 2
      : sentenceEnd >= start
        ? sentenceEnd + 1
        : hardEnd;
    count += 1;
    start = end;
  }
  return count;
}

function findLastParagraphEnd(
  characters: string[],
  start: number,
  hardEnd: number,
): number {
  for (let index = hardEnd - 2; index >= start; index -= 1) {
    if (characters[index] === "\n" && characters[index + 1] === "\n") {
      return index;
    }
  }
  return -1;
}

function findLastCharacter(
  characters: string[],
  target: string,
  start: number,
  hardEnd: number,
): number {
  for (let index = hardEnd - 1; index >= start; index -= 1) {
    if (characters[index] === target) {
      return index;
    }
  }
  return -1;
}
