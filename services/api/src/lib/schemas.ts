import { z } from "zod";

/**
 * Shared Zod schemas for Atlas backend route handlers.
 *
 * Every POST/PATCH handler in src/routes/* should validate its request body
 * with a schema before running downstream logic. Use these helpers when the
 * shape is common; define a route-local schema otherwise.
 *
 * Convention (from Atlas BO 30): use `schema.safeParse(req.body)` at the top
 * of the handler, return 400 with the shape produced by
 * `validationFailResponse(result.error)` on failure, and use `result.data`
 * instead of `req.body` downstream.
 *
 * Example:
 *
 *   const fooSchema = z.object({ name: z.string().min(1) });
 *
 *   router.post("/foo", (req, res) => {
 *     const parsed = fooSchema.safeParse(req.body);
 *     if (!parsed.success) {
 *       return res.status(400).json(validationFailResponse(parsed.error));
 *     }
 *     const { name } = parsed.data;
 *     // ...
 *   });
 */

/**
 * Strict empty body — use on action endpoints where the URL carries all
 * required state (e.g. `POST /:id/publish`, `POST /disconnect`). `.strict()`
 * rejects any unexpected field rather than silently ignoring it.
 */
export const emptyBodySchema = z.object({}).strict();

/**
 * Standardized shape for 400 validation-failure responses. Produces the
 * `{ error: 'Validation failed', details: error.flatten() }` envelope the
 * Atlas contract expects from any Zod-gated handler.
 */
export function validationFailResponse(error: z.ZodError) {
  return {
    error: "Validation failed",
    details: error.flatten(),
  };
}

/**
 * Pagination query-string schema (coerces string values to numbers). Bounds
 * mirror `lib/pagination.ts`: limit in [1, 100], offset ≥ 0. Intended for
 * use with `req.query` on GET endpoints, but exported here so POST/PATCH
 * handlers that accept pagination in the body can share the shape.
 */
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/**
 * Generic `{ id }` path-param schema. Express only gives us strings from
 * the URL, so we enforce non-empty rather than UUID format (some IDs in
 * Atlas are cuid2, some are database ints cast to string).
 */
export const idParamSchema = z.object({
  id: z.string().min(1),
});
