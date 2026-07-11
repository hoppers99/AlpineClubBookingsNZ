import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayPanelOptions } from "./module-options";

// Lodge rules / arrival information (fork issue #31): renders the sanitised
// lodge-instructions documents the serialiser provided. The HTML was
// sanitised server-side by getSanitizedLodgeInstructions before it entered
// the payload (issue #28); this module renders that payload verbatim and
// nothing else (issue #31 AC2).

export function LodgeRules({
  state,
}: {
  state: DisplayState;
  options?: DisplayPanelOptions;
}) {
  if (!state.rules || state.rules.length === 0) {
    return <div className="display-lodge-rules display-lodge-rules-empty" />;
  }

  return (
    <div className="display-lodge-rules">
      {state.rules.map((doc) => (
        <section key={doc.title} className="display-rules-doc">
          <h3 className="display-rules-title">{doc.title}</h3>
          <div
            className="display-rules-body"
            // Sanitised upstream (getSanitizedLodgeInstructions → serialiser).
            dangerouslySetInnerHTML={{ __html: doc.html }}
          />
        </section>
      ))}
    </div>
  );
}
