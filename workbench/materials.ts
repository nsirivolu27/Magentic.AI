import { z } from "zod";

export const materialSchema = z.object({
  id: z.string().uuid(), title: z.string().trim().min(1).max(120),
  content: z.string().trim().max(6000),
  url: z.string().url().max(2000).refine(value => {
    try {
      const url = new URL(value);
      return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
    } catch { return false; }
  }, "Use an HTTP or HTTPS source without credentials.").optional(),
}).strict().refine(value => Boolean(value.content || value.url), "Provide an excerpt or a source link.");

// A bounded snapshot keeps later source edits from changing an agent's inputs.
export const materialsSchema = z.array(materialSchema).max(8).superRefine((items, context) => {
  if (new Set(items.map(item => item.id)).size !== items.length)
    context.addIssue({ code: "custom", message: "Material IDs must be unique." });
  if (items.reduce((size, item) => size + item.content.length, 0) > 16000)
    context.addIssue({ code: "custom", message: "Reference excerpts must total at most 16000 characters." });
});
export type Material = z.infer<typeof materialSchema>;

export const FEDERAL_SERVICE_STARTER = {
  title: "Build an accessible disaster declaration finder",
  brief: "Help public-service staff and residents find disaster declarations by state and incident date. Build one accessible search flow in the connected repository. Start with requirements, then plan, design, implement, validate, review, and prepare delivery evidence.\n\nAcceptance: keyboard-accessible filters; explicit loading, empty and error states; source and retrieval date on results; automated tests for filtering and invalid data. Review the OpenFEMA source and record a small reproducible data sample before implementation. Declaration records do not determine an individual's assistance eligibility. No live dataset has been imported by this starter. Delivery requires human review; do not publish or deploy.",
  source: "https://catalog.data.gov/dataset/disaster-declarations-summaries",
};
