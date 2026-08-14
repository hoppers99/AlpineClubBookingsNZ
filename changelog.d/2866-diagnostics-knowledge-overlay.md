- **AI Diagnostics can now be given private, deployment-specific knowledge without
  putting any of it in the public code (#2861).** A deployment may drop extra
  diagnostic knowledge — a private runbook, fork-only operational notes — into its
  own `config/diagnostics-knowledge.json` (or a location it names via
  `DIAGNOSTICS_KNOWLEDGE_CONFIG_PATH`), and Diagnostics layers it on top of the
  public deployed knowledge bundle. It is entirely optional: with none supplied,
  Diagnostics works exactly as before and the bundle is byte-for-byte unchanged.
  The overlay is deployment-local and never travels between deployments. Overlay
  content is treated as untrusted like everything else the assistant reads — it is
  secret-scanned (a secret stops the build), size-bounded, always cited, and
  defused so nothing inside it can pose as an instruction — and it can never expose
  an env file, a key, or any other excluded path. A malformed overlay stops the
  build rather than shipping. Operators: see the AI Diagnostics deployment guide.
