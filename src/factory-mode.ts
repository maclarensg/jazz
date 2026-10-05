import { z } from "zod"

const isolatedHint = z.string().refine((value) =>
  value.startsWith("/tmp/opencode/") && !value.split("/").some((part) => part === "." || part === ".."),
"namespaceDirectory must name scratch space under /tmp/opencode")

const modeSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("legacy") }).strict(),
  z.object({ mode: z.literal("foundation"), namespaceDirectory: isolatedHint.optional() }).strict(),
])

/** The directory is a diagnostic hint, NOT storage scope or ownership proof. */
export function parseFactoryMode(value: unknown): z.infer<typeof modeSchema> {
  return value === undefined ? { mode: "legacy" } : modeSchema.parse(value)
}
