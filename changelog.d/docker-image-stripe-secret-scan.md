- **The deployed knowledge bundle can no longer ship a Stripe-key-shaped example
  string (#2531).** A documentation example that showed the *shape* of a Stripe
  test key was being copied into the diagnostics knowledge bundle baked into the
  container image, where the image secret scan (Trivy, the `docker-image-security`
  gate) flagged it as a possible leaked credential and failed the build. The
  example is now written in a broken, unmistakably-fake form, and the bundle's own
  secret scanner now refuses **any** Stripe key shape — test, live, restricted, or
  webhook-signing — even when it is labelled a placeholder, so a future docs
  example can never re-introduce the finding. No real credential was ever exposed.
