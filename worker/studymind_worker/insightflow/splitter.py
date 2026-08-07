from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass


@dataclass(frozen=True)
class MarkdownChunk:
    id: int
    summary: str
    content: str
    start_byte: int = 0
    end_byte: int = 0
    sha256: str = ""


class MarkdownSplitter:
    def __init__(self, max_length: int = 2000) -> None:
        self.max_length = max_length

    def split(self, markdown: str) -> list[MarkdownChunk]:
        if not markdown or self.max_length <= 0:
            return []

        chunks: list[MarkdownChunk] = []
        start = 0
        start_byte = 0
        while start < len(markdown):
            end = self._find_chunk_end(markdown, start)
            content = markdown[start:end]
            content_bytes = content.encode("utf-8")
            end_byte = start_byte + len(content_bytes)
            chunks.append(
                MarkdownChunk(
                    id=len(chunks) + 1,
                    summary=self._heading_at(markdown, start),
                    content=content,
                    start_byte=start_byte,
                    end_byte=end_byte,
                    sha256=hashlib.sha256(content_bytes).hexdigest(),
                )
            )
            start = end
            start_byte = end_byte
        return chunks

    def _find_chunk_end(self, markdown: str, start: int) -> int:
        hard_end = min(start + self.max_length, len(markdown))
        if hard_end == len(markdown):
            return hard_end

        paragraph_end = markdown.rfind("\n\n", start, hard_end)
        if paragraph_end >= start:
            return paragraph_end + 2
        sentence_end = markdown.rfind("。", start, hard_end)
        if sentence_end >= start:
            return sentence_end + 1
        return hard_end

    @staticmethod
    def _heading_at(markdown: str, start: int) -> str:
        matches = list(
            re.finditer(r"^(#{1,6})\s+(.+)$", markdown[: start + 1], re.MULTILINE)
        )
        return matches[-1].group(2).strip() if matches else "内容摘要"
