- **The bed-allocation admin code is now organised by what each part does, with
  no change to what any of it does (#2688).** The single file behind the bed
  allocation board, the rooms-and-beds setup screens, manual and range bed
  assignment, "Run auto allocation" and bed approval had grown to roughly 4,500
  lines covering all of those at once. It is now eighteen focused modules — one
  for room inventory, one for beds, one for the board's payload, one for each
  kind of write, and so on — so that whoever next changes one of those screens
  reads only the part that governs it.

  Nothing an administrator does changes, and nothing about how beds are
  allocated, locked, approved or audited changes: every piece of logic was moved
  across unaltered, and the checks that guard bed allocation against two people
  saving at once were verified to be the same statements, in the same order, in
  the same database transactions as before.

  Those automated guards were also tightened while the code was being moved.
  Each place that writes a bed allocation is now checked individually, in the
  order it does things, rather than by looking for the right words somewhere in
  the file — and the inventory of write points now counts them, so a second one
  added to a file that is already on the list is noticed instead of being
  assumed covered by the first.

  The one file that was deliberately left alone is the allocation algorithm
  itself. It is also large, but it is one continuous piece of reasoning about
  who gets which bed, and breaking it up would have made it harder to follow
  rather than easier. That decision, and the reason for it, is recorded in the
  maintenance notes.
