import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

describe("MarkdownContent", () => {
  test("renders GFM markdown without passing through raw HTML", () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        emptyText="empty"
        markdown={`# 要点总结

- [x] 已完成

| 项目 | 状态 |
| --- | --- |
| 摘要 | 可读 |

<script>alert("bad")</script>`}
      />,
    );

    expect(html).toContain("<h1>要点总结</h1>");
    expect(html).toContain("<table>");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("alert");
  });

  test("shows empty text when markdown is blank", () => {
    expect(
      renderToStaticMarkup(<MarkdownContent emptyText="暂无内容" markdown="  " />),
    ).toContain("暂无内容");
  });
});
