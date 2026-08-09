# Admin LLM Configuration Form Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the placeholder LLM section in the admin page with a polished, functional configuration form backed by the existing admin API.

**Architecture:** Keep the current server-rendered HTML approach. `adminPage.ts` will render the form and small inline client behavior; the existing `POST /admin/api/llm-config` route remains the single persistence boundary and continues encrypting the API key. The page will expose only public state (configured flag and API-key last four characters), never the stored secret.

**Tech Stack:** TypeScript, Fastify server-rendered HTML, inline browser JavaScript, Vitest.

---

### Task 1: Lock down the rendered form contract

**Files:**
- Modify: `server/tests/pageI18n.test.ts` or the existing admin page test file after locating its render assertions
- Test: `server/tests/admin.test.ts`

- [ ] Add assertions that the authenticated admin page contains labels/controls for provider, base URL, model, API key, timeout, save action, and the CSRF header wiring.
- [ ] Run the focused test and confirm it fails because the current page only renders `configured` and `last4` text.

### Task 2: Implement the admin LLM form

**Files:**
- Modify: `server/src/adminPage.ts`

- [ ] Render a responsive card with grouped fields, accessible labels, helper text, current configuration status, masked last-four display, and a save button.
- [ ] Add inline browser behavior that submits JSON to `/admin/api/llm-config`, sends `x-studymind-csrf`, disables the button while saving, and displays success/error feedback without exposing the API key.
- [ ] Keep the page self-contained and compatible with the existing CSP (`unsafe-inline` is already allowed for this page).

### Task 3: Verify behavior and regressions

**Files:**
- No additional production files

- [ ] Run the focused admin/page tests.
- [ ] Run `npm.cmd --prefix server test`.
- [ ] Run `npm.cmd --prefix server run build`.
- [ ] Start the server with the configured `.env` and verify `/health/ready` returns 200.
