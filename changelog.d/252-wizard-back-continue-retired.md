- **The setup wizard drops its Back and Continue buttons — the rail is the
  whole of navigation now (#252).** Continue did nothing on the happy path: it
  was disabled on the step you are actually working through, and its one
  working case — stepping forward from a step you had gone back to revisit —
  is something the rail already does better, since a row shows a step's state
  before you click it and the destination is a rail row either way.

  Both buttons are gone from the step frame. Marking a step done or skipping
  it is what unlocks the next row in the rail; clicking that row, or any other
  unlocked one, is how you move around the journey. If you have not clicked a
  row yourself and are simply resting where the wizard put you, marking that
  step done carries you straight on to the next one, exactly as it always has.

  A locked row's tooltip now explains why it is locked — the sentence that
  used to live only on Continue's disabled state moved there, so the Lock icon
  is never left saying nothing about why the row will not open.
