import { useState, useCallback, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import type { SummaryAnnotation } from "../../annotationClient";
import { AnnotationPopover } from "./AnnotationPopover";

const ANNOTATION_COLORS = [
  { key: "yellow", label: "重点", className: "color-yellow" },
  { key: "blue", label: "疑问", className: "color-blue" },
  { key: "green", label: "已掌握", className: "color-green" },
  { key: "red", label: "待复习", className: "color-red" },
];

type AnnotatedMarkdownContentProps = {
  markdown: string;
  emptyText: string;
  targetTab: string;
  annotations: SummaryAnnotation[];
  onAddAnnotation: (
    targetTab: string,
    textAnchor: string,
    charIndex: number,
    content: string,
    color: string | null,
  ) => void;
  onUpdateAnnotation: (
    id: string,
    content: string,
    color: string | null,
  ) => void;
  onDeleteAnnotation: (id: string) => void;
  activeAnnotationId: string | null;
};

type PopoverState = {
  isOpen: boolean;
  position: { x: number; y: number };
  textAnchor: string;
  charIndex: number;
  existingAnnotation: SummaryAnnotation | null;
};

export function AnnotatedMarkdownContent({
  markdown,
  emptyText,
  targetTab,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  onDeleteAnnotation,
  activeAnnotationId,
}: AnnotatedMarkdownContentProps) {
  const [popover, setPopover] = useState<PopoverState>({
    isOpen: false,
    position: { x: 0, y: 0 },
    textAnchor: "",
    charIndex: 0,
    existingAnnotation: null,
  });
  const contentRef = useRef<HTMLDivElement>(null);

  const handleMouseUp = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }

    const selectedText = selection.toString().trim();
    if (!selectedText || selectedText.length < 2) {
      return;
    }

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    const textBeforeSelection = markdown.slice(
      0,
      markdown.indexOf(selectedText),
    );
    const charIndex = textBeforeSelection.length;

    const existing = annotations.find(
      (a) =>
        a.target_tab === targetTab && a.text_anchor === selectedText,
    );

    setPopover({
      isOpen: true,
      position: {
        x: rect.left + window.scrollX,
        y: rect.bottom + window.scrollY + 8,
      },
      textAnchor: selectedText,
      charIndex,
      existingAnnotation: existing ?? null,
    });
  }, [annotations, markdown, targetTab]);

  const handlePopoverSave = useCallback(
    (content: string, color: string | null) => {
      if (popover.existingAnnotation) {
        onUpdateAnnotation(popover.existingAnnotation.id, content, color);
      } else {
        onAddAnnotation(
          targetTab,
          popover.textAnchor,
          popover.charIndex,
          content,
          color,
        );
      }
    },
    [onAddAnnotation, onUpdateAnnotation, popover, targetTab],
  );

  const handlePopoverDelete = useCallback(() => {
    if (popover.existingAnnotation) {
      onDeleteAnnotation(popover.existingAnnotation.id);
    }
  }, [onDeleteAnnotation, popover]);

  const closePopover = useCallback(() => {
    setPopover((prev) => ({ ...prev, isOpen: false }));
    window.getSelection()?.removeAllRanges();
  }, []);

  const content = markdown.trim();
  if (!content) {
    return <p className="markdown-empty">{emptyText}</p>;
  }

  const tabAnnotations = annotations.filter(
    (a) => a.target_tab === targetTab,
  );

  return (
    <div
      ref={contentRef}
      className={`markdown-content annotated ${
        activeAnnotationId ? `highlight-${activeAnnotationId}` : ""
      }`}
      onMouseUp={handleMouseUp}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        components={{
          p: ({ children }) => {
            const text = String(children);
            const matchingAnnotations = tabAnnotations.filter((a) =>
              text.includes(a.text_anchor),
            );

            if (matchingAnnotations.length === 0) {
              return <p>{children}</p>;
            }

            const colorClass = (a: SummaryAnnotation) => {
              const base = "annotation-highlight";
              const color = ANNOTATION_COLORS.find(
                (c) => c.key === a.color,
              );
              return `${base} ${color?.className ?? "color-yellow"}`;
            };

            let result: React.ReactNode[] = [children];
            for (const ann of matchingAnnotations) {
              const newResult: React.ReactNode[] = [];
              for (const node of result) {
                if (typeof node === "string") {
                  const parts = node.split(ann.text_anchor);
                  for (let i = 0; i < parts.length; i++) {
                    newResult.push(parts[i]);
                    if (i < parts.length - 1) {
                      newResult.push(
                        <mark
                          key={`${ann.id}-${i}`}
                          className={colorClass(ann)}
                          data-annotation-id={ann.id}
                        >
                          {ann.text_anchor}
                        </mark>,
                      );
                    }
                  }
                } else {
                  newResult.push(node);
                }
              }
              result = newResult;
            }
            return <p>{result}</p>;
          },
        }}
      >
        {content}
      </ReactMarkdown>

      <AnnotationPopover
        isOpen={popover.isOpen}
        position={popover.position}
        textAnchor={popover.textAnchor}
        existingAnnotation={popover.existingAnnotation}
        colors={ANNOTATION_COLORS}
        onSave={handlePopoverSave}
        onDelete={handlePopoverDelete}
        onClose={closePopover}
      />
    </div>
  );
}
