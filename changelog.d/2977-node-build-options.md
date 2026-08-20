- **The Node heap for `docker compose build` can now be set from `.env`
  (#2977).** On a server with limited memory, `next build` — the memory peak
  of the whole image build — can be killed part-way, sometimes with nothing
  more informative than "JavaScript heap out of memory". The only remedy was
  editing the `Dockerfile` by hand, which then had to be removed before every
  `git pull` and re-applied afterwards.

  Set `NODE_BUILD_OPTIONS=--max-old-space-size=4096` in `.env` instead. It
  reaches `next build` as `NODE_OPTIONS` inside the builder stage and nothing
  else — not the running container, not your shell. Empty by default, so every
  existing deployment builds exactly as it did before.

  If your server is tight on memory, the better answer is not to build there at
  all: point `APP_IMAGE` at an image CI has already published and
  `docker compose up -d` pulls it rather than compiling.
