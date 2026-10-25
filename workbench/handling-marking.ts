import { z } from "zod";
import { setting } from "../env.js";
import { escape } from "./ui.js";

/**
 * The handling marking: the banner text an agency requires on every screen
 * and every export that carries controlled information, for example
 * "CUI" or "CUI//SP-PRVCY". One setting per deployment; the operator sets
 * it, nobody changes it from a page. The marking is shown at the top and
 * bottom of every page and stamped into every audit package.
 *
 * Magentic shows the marking. It does not decide what the information is;
 * that stays with the people who own it.
 */

export const HANDLING_SETTING = "MAGENTIC_HANDLING_MARKING";

/** Upper case letters, digits, spaces and the separators markings use. Short enough to read in a banner. */
export const handlingMarkingSchema = z.string().trim().min(1).max(80).regex(/^[A-Z0-9][A-Z0-9 /()\-,]*$/, "Use upper case letters, digits, spaces and / ( ) - , only.");

/** Reads the setting once at start. An invalid value stops the server with the reason; an absent one means no banner. */
export function loadHandlingMarking(readSetting: (name: string) => string | undefined = setting): string | undefined {
  const raw = readSetting(HANDLING_SETTING);
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = handlingMarkingSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`${HANDLING_SETTING}: ${parsed.error.issues[0]?.message ?? "invalid marking"}`);
  return parsed.data;
}

/** The banner at the top and the one at the bottom are the same element rendered twice; both say where they are for screen readers. */
export function handlingBannerHtml(marking: string, position: "top" | "bottom"): string {
  return `<div class="handling-banner" role="note" aria-label="Handling marking, ${position} of page"><span>${escape(marking)}</span></div>`;
}
