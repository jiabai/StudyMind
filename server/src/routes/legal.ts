import type { FastifyInstance } from "fastify";
import { detectLocale, extractQueryLang } from "../i18n.js";
import { renderLegalPage, type LegalPageKind } from "../legalPages.js";

export function registerLegalRoutes(app: FastifyInstance): void {
  for (const kind of ["privacy", "terms"] as const) {
    app.get(`/${kind}`, async (request, reply) => {
      const query = request.query as Record<string, unknown>;
      const acceptLanguage = request.headers["accept-language"];
      const locale = detectLocale({
        cookie: request.headers.cookie,
        queryLang: extractQueryLang(query),
        acceptLanguage: Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage,
      });
      reply
        .header("cache-control", "public, max-age=3600")
        .type("text/html; charset=utf-8")
        .send(renderLegalPage(kind satisfies LegalPageKind, locale));
    });
  }
}
