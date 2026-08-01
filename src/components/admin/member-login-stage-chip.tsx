import {
  getMemberLoginStage,
  LOGIN_STAGE_LABELS,
  LOGIN_STAGE_TONES,
  type MemberPasswordActionState,
} from "@/lib/member-login-stage";
import { CHIP_TONE_CLASSES } from "@/lib/chip-tones";

/** Shared Access chip for member directory and subscription rows. */
export function MemberLoginStageChip({
  member,
}: {
  member: MemberPasswordActionState;
}) {
  const stage = getMemberLoginStage(member);

  return (
    <span
      className={`inline-flex items-center rounded-md border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap ${CHIP_TONE_CLASSES[LOGIN_STAGE_TONES[stage]]}`}
    >
      {LOGIN_STAGE_LABELS[stage]}
    </span>
  );
}
