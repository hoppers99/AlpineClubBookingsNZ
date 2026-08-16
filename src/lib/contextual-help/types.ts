/**
 * The shape of a contextual-help entry, and the two builders that make one.
 *
 * A LEAF (#2689): it imports nothing, so the help corpus, `@/lib/help/types`
 * and the client components that only need a type can all reach the shape
 * without pulling the 2,700-line corpus in behind it.
 *
 * The typed shape is the point. The owner kept this content in TypeScript
 * rather than JSON precisely so a malformed help entry cannot reach a page:
 * the compiler is the schema check, and moving to data files would mean adding
 * one back.
 */
export type HelpScope = "admin" | "finance";

export type HelpField = {
  name: string;
  description: string;
};

export type HelpSection = {
  title: string;
  details: string[];
};

/**
 * A plain-English question and answer pair, distilled from an entry's own help
 * content. Defined here (rather than in `@/lib/help/types`) so this file has no
 * dependency on the help/* corpus and there is no import cycle; `help/types.ts`
 * re-exports it. Consumed by the help corpus (`@/lib/help`) and the AI grounding
 * serializer for epic #2094.
 */
export type HelpQuestion = {
  q: string;
  a: string;
  link?: { href: string; label: string };
  group?: string;
};

export type ContextualHelpContent = {
  title: string;
  summary: string;
  actions: string[];
  fields?: HelpField[];
  sections?: HelpSection[];
  notes?: string[];
  questions?: HelpQuestion[];
};

/** One page's help, keyed by the route prefix it answers for. */
export type HelpEntry = {
  path: string;
  content: ContextualHelpContent;
};

export function entry(path: string, content: ContextualHelpContent): HelpEntry {
  return { path, content };
}

export function help(
  title: string,
  summary: string,
  actions: string[],
  fields: HelpField[] = [],
  notes: string[] = [],
  sections: HelpSection[] = [],
): ContextualHelpContent {
  return { title, summary, actions, fields, notes, sections };
}
