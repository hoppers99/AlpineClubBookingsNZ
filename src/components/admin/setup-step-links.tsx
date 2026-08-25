import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A readiness check's EXTRA destinations (#221, epic #213 C6).
 *
 * A check carries one `href` — "the settings page for this step" — and that is
 * enough for eighteen of the twenty steps. The lodges step needs a list whose
 * length is the club's own: one link per lodge, into that lodge's own setup
 * flow, so per-lodge completeness is reported separately from the club's
 * without becoming extra steps in the journey.
 *
 * ONE component rather than a copy on each surface. The readiness cards
 * (`/admin/setup`) and the wizard's step frame (`/admin/setup/wizard`) render
 * the same checks, and a second copy is how the two would end up disagreeing
 * about where a lodge's setup lives.
 *
 * Renders nothing at all for a check with no extra links, so every other step
 * is untouched by its existence.
 */
export function SetupStepLinks({
  links,
  testId,
}: {
  links: readonly { label: string; href: string }[] | undefined;
  testId?: string;
}) {
  if (!links || links.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2" data-testid={testId}>
      {links.map((link) => (
        <li key={link.href}>
          <Button asChild variant="outline" size="sm">
            <a href={link.href}>
              <ExternalLink className="h-4 w-4" />
              {link.label}
            </a>
          </Button>
        </li>
      ))}
    </ul>
  );
}
