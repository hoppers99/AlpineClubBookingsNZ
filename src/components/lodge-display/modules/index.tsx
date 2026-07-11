import type { ComponentType } from "react";
import type { DisplayState } from "@/lib/lodge-display-state";
import type { DisplayModuleName } from "@/lib/lodge-display/template-registry";
import type { DisplayPanelOptions } from "./module-options";
import { ArrivalsBoard } from "./arrivals-board";
import { ChoresBoard } from "./chores-board";
import { LodgeRules } from "./lodge-rules";
import { NoticeBoard } from "./notice-board";
import { OccupancyGrid } from "./occupancy-grid";
import { SinglesBoard } from "./singles-board";
import { WelcomePanel } from "./welcome-panel";

// Module name -> renderer map for the lobby display (fork issue #30). Every
// component is a pure function of the privacy-reduced DisplayState payload —
// none of them query anything (issue #30 AC7). Names come from the closed
// registry in template-registry.ts; entries land as their issues deliver
// (LTV-006: chores/rules/text; LTV-007: header/footer; LTV-011: notice), and
// the display page renders a neutral placeholder for names without a
// component yet, so a template referencing a future module degrades safely.

export interface DisplayModuleProps {
  state: DisplayState;
  options?: DisplayPanelOptions;
}

export const DISPLAY_MODULE_COMPONENTS: Partial<
  Record<DisplayModuleName, ComponentType<DisplayModuleProps>>
> = {
  "arrivals-board": ArrivalsBoard,
  "occupancy-grid": OccupancyGrid,
  welcome: WelcomePanel,
  "singles-board": SinglesBoard,
  "chores-board": ChoresBoard,
  "lodge-rules": LodgeRules,
  "notice-board": NoticeBoard,
};
