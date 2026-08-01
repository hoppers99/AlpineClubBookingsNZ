- **New "AI Diagnostics" module — a separate admin-only assistant with its own
  key, spend budget, and safety controls (#2371).** The Modules admin page now
  has an **AI Diagnostics** switch. It ships **off**, and it is a different thing
  from the existing AI help assistant: where the help assistant answers members'
  page questions, AI Diagnostics is an admin-only tool that will be able to
  explain the deployed system and look up bounded, permission-scoped operational
  facts. This release lays its foundations — the capability, its configuration,
  its spend controls, and its safety limits; the diagnostics screens themselves
  arrive in a later release.

  Because it is a paid tool, turning the switch on does **not** by itself let it
  spend anything. Two deliberate steps are needed first, and until both are done
  the tool reports itself "not ready" and makes no paid calls:

  - a **dedicated Anthropic API key**, entered under Admin → Integrations. It is
    a **separate key** from the AI help assistant's — the two are never shared,
    so you can point diagnostics at its own Anthropic workspace with its own
    billing and limits. Only a Full Admin can enter it; any admin can see whether
    it is set.
  - a **monthly spend budget**, in dollars. It ships at **NZ$0**, which
    hard-stops every paid diagnostics call, so the tool can never start spending
    by accident. Raise it deliberately when you are ready.

  The spend controls are strict by design: the budget is enforced so that even a
  burst of activity cannot go over the monthly cap, and per-admin, per-address,
  and whole-site rate limits stop runaway use. If the club's usage records can't
  be written, diagnostics stops rather than spending un-metered. What the club
  keeps about each diagnostics call is deliberately minimal — how much it cost
  and whether it failed — and never the questions asked or the answers given.

  This configuration is **per-deployment**: neither the switch, the key, nor the
  budget travels in a configuration bundle, so restoring or copying a bundle can
  never turn diagnostics on, or plant a spend budget, on another club's site.
