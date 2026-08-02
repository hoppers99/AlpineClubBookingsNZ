- **Deployments now build a verified snapshot of their own code, docs, and
  schema for the upcoming AI Diagnostics tool (#2372).** Each image now carries a
  deterministic "knowledge bundle" — an indexed, hashed record of the deployed
  commit's documentation and database schema — so that when the admin-only AI
  Diagnostics product arrives it can answer "what does the running system say?"
  from the artifact actually deployed, never from a stale working copy or a
  guess.

  The bundle is generated automatically during the image build and needs no
  operator action; the commit being deployed is stamped into it, and the build
  refuses to proceed if a credential is ever detected in the files it reads.
  Nothing is sent anywhere yet — this release only builds and ships the bundle
  inside the image. A club that maintains a private fork can optionally point the
  bundle at extra files with a git-ignored `config/diagnostics-knowledge.json`
  overlay; the public build never includes any club-specific content.
