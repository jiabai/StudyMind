import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

type MarkdownContentProps = {
  markdown: string;
  emptyText: string;
};

export function MarkdownContent({ markdown, emptyText }: MarkdownContentProps) {
  const content = markdown.trim();

  if (!content) {
    return <p className="markdown-empty">{emptyText}</p>;
  }

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
