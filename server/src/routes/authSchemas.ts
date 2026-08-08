import { z } from "zod";
const state = z.string().min(8).max(160).regex(/^[A-Za-z0-9._~-]+$/);
export const emailStartSchema = z.object({ email: z.string().min(3).max(254), state }).strict();
export const emailVerifySchema = z.object({ email: z.string().min(3).max(254), code: z.string().regex(/^\d{6}$/), state }).strict();
export const ticketExchangeSchema = z.object({ ticket: z.string().min(15).max(205).regex(/^smlt_[A-Za-z0-9_-]+$/), state }).strict();
