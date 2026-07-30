import { JSDOM } from "jsdom";
import {
  emptyWhakapapaCurlData,
  validateWhakapapaSourceUrl,
  WHAKAPAPA_DEFAULT_SELECTORS,
  WHAKAPAPA_DEFAULT_SOURCE_URL,
  type WhakapapaCondition,
  type WhakapapaCurlData,
  type WhakapapaFacilityItem,
  type WhakapapaRoadStatus,
  type WhakapapaSelectorConfig,
  type WhakapapaTrail,
  type WhakapapaTrailArea,
} from "@/lib/whakapapa-report";

export interface WhakapapaFetchOptions {
  /** Report URL to scrape. Falls back to the default (and is re-validated). */
  sourceUrl?: string;
  /** Resolved selector map. Falls back to the built-in hash-agnostic defaults. */
  selectors?: WhakapapaSelectorConfig;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLabel(value: string): string {
  return value.replace(/:\s*$/, "").trim().toLowerCase();
}

function resolveSourceUrl(candidate: string | undefined): string {
  const validated = validateWhakapapaSourceUrl(candidate);
  // Defence in depth: the admin save path already rejects out-of-allowlist
  // URLs, but if a bad value ever reaches here we fall back to the safe default
  // rather than fetch an attacker-controlled host.
  return validated.ok ? validated.url : WHAKAPAPA_DEFAULT_SOURCE_URL;
}

function parseFacilityItems(
  section: ParentNode,
  selectors: WhakapapaSelectorConfig,
): WhakapapaFacilityItem[] {
  return Array.from(section.querySelectorAll(selectors.item))
    .map((node) => ({
      name: normalizeText(node.querySelector(selectors.itemName)?.textContent),
      status: normalizeText(
        node.querySelector(selectors.itemStatus)?.textContent,
      ),
    }))
    .filter((item) => item.name.length > 0 || item.status.length > 0);
}

function findMetricValue(container: ParentNode, title: string): string {
  const target = normalizeLabel(title);
  const titleNodes = Array.from(container.querySelectorAll("div"));

  for (const node of titleNodes) {
    const nodeLabel = normalizeLabel(normalizeText(node.textContent));
    if (nodeLabel !== target) {
      continue;
    }

    const nextSiblingText = normalizeText(node.nextElementSibling?.textContent);
    if (nextSiblingText) {
      return nextSiblingText;
    }

    const parent = node.parentElement;
    if (!parent) {
      continue;
    }

    const parentChildren = Array.from(parent.children);
    const nodeIndex = parentChildren.indexOf(node);
    if (nodeIndex >= 0) {
      for (let i = nodeIndex + 1; i < parentChildren.length; i += 1) {
        const siblingText = normalizeText(parentChildren[i]?.textContent);
        if (siblingText && normalizeLabel(siblingText) !== target) {
          return siblingText;
        }
      }
    }
  }

  return "";
}

// Difficulty is drawn as a coloured SVG grade marker whose shape carries an
// id/colour on the upstream report:
//   green circle (id "green")            -> Beginner
//   blue square  (id "blue")             -> Intermediate
//   black diamond (a path with NO id)    -> Advanced
//   red diamond  (id "diamond_left"/…)   -> Expert
// Read the shape rather than any hashed class so it survives an upstream rebuild.
function parseTrailDifficulty(iconEl: Element | null): string {
  if (!iconEl) {
    return "";
  }

  const shapes = Array.from(
    iconEl.querySelectorAll("circle, ellipse, rect, path, polygon"),
  );
  if (shapes.length === 0) {
    return "";
  }

  // 1) By shape id keyword — robust to both the current lowercase ids
  //    (green / blue / diamond_left / diamond_right) and Capitalised variants
  //    (Green_circle / Blue_square / Diamond_left).
  for (const shape of shapes) {
    const id = normalizeText(shape.id).toLowerCase();
    if (id.includes("green")) return "Beginner";
    if (id.includes("blue")) return "Intermediate";
    if (id.includes("diamond")) return "Expert";
    if (id.includes("black")) return "Advanced";
  }

  // 2) Fall back to the shape kind: a circle is a green (Beginner) run, a
  //    rect a blue (Intermediate) run, and an id-less diamond path/polygon is
  //    the black (Advanced) marker.
  for (const shape of shapes) {
    const tag = shape.tagName.toLowerCase();
    if (tag === "circle" || tag === "ellipse") return "Beginner";
    if (tag === "rect") return "Intermediate";
    if (tag === "path" || tag === "polygon") return "Advanced";
  }

  return "";
}

function parseTrailSubInfo(raw: string): { groomed: boolean; size: string } {
  const parts = raw
    .split(/\s*-\s*/)
    .map(normalizeText)
    .filter((part) => part.length > 0);

  let groomed = false;
  const sizeParts: string[] = [];
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "groomed") {
      groomed = true;
    } else if (lower === "ungroomed") {
      groomed = false;
    } else {
      // Anything that is not the groomed flag (e.g. a park size) becomes size.
      sizeParts.push(part);
    }
  }

  return { groomed, size: sizeParts.join(" - ") };
}

function parseTrailItem(
  el: Element,
  selectors: WhakapapaSelectorConfig,
): WhakapapaTrail {
  const subInfo = parseTrailSubInfo(
    normalizeText(el.querySelector(selectors.trailSubInfo)?.textContent),
  );

  return {
    name: normalizeText(el.querySelector(selectors.itemName)?.textContent),
    status: normalizeText(el.querySelector(selectors.itemStatus)?.textContent),
    groomed: subInfo.groomed,
    difficulty: parseTrailDifficulty(
      el.querySelector(selectors.trailDifficultyIcon),
    ),
    size: subInfo.size,
  };
}

function parseTrailAreas(
  document: Document,
  selectors: WhakapapaSelectorConfig,
): WhakapapaTrailArea[] {
  const heading = document.getElementById(selectors.trailsHeadingId);
  const wrapper =
    heading?.closest(selectors.sectionWrapper) ??
    heading?.parentElement ??
    null;
  if (!wrapper) {
    return [];
  }

  const areaEls = Array.from(wrapper.querySelectorAll(selectors.trailArea));
  // If the collapsable sub-area structure changes, fall back to treating the
  // whole trails wrapper as one unnamed area so trails still surface.
  const areaSources: ParentNode[] = areaEls.length > 0 ? areaEls : [wrapper];

  const areas: WhakapapaTrailArea[] = [];
  for (const areaEl of areaSources) {
    const areaName = normalizeText(
      (areaEl as Element).querySelector(selectors.trailAreaName)?.textContent,
    );
    const trails = Array.from(areaEl.querySelectorAll(selectors.item))
      .map((el) => parseTrailItem(el, selectors))
      .filter((trail) => trail.name.length > 0);

    if (trails.length > 0) {
      areas.push({ name: areaName, trails });
    }
  }

  return areas;
}

export async function fetchWhakapapaCurlData(
  options: WhakapapaFetchOptions = {},
): Promise<WhakapapaCurlData> {
  const sourceUrl = resolveSourceUrl(options.sourceUrl);
  const selectors = options.selectors ?? WHAKAPAPA_DEFAULT_SELECTORS;

  const upstream = await fetch(sourceUrl, {
    method: "GET",
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "AlpineClubBookingsNZ/1.0 (+whakapapa-report)",
    },
    cache: "no-store",
  });

  const html = await upstream.text();
  if (!upstream.ok || html.trim().length === 0) {
    throw new Error(
      `Whakapapa report fetch failed (status ${upstream.status}).`,
    );
  }

  const dom = new JSDOM(html);
  const { document } = dom.window;

  const roadStatus: WhakapapaRoadStatus = {
    name: normalizeText(
      document.querySelector(selectors.roadAreaTitle)?.textContent?.split(":")[0],
    ),
    status: normalizeText(
      document.querySelector(selectors.roadStatus)?.textContent,
    ),
    wheelRequirements: normalizeText(
      document.querySelector(selectors.roadWheelRequirements)?.textContent,
    ),
    roadContent: normalizeText(
      document.querySelector(selectors.roadContent)?.textContent,
    ),
  };

  const facilities: WhakapapaFacilityItem[] = [];
  const foodAndDrink: WhakapapaFacilityItem[] = [];
  const lifts: WhakapapaFacilityItem[] = [];

  // The report groups status items into Facilities, Food & Drink, and Lifts.
  // Anchor on each group's titled heading (stable id, falling back to heading
  // text) then read the sibling items container from the enclosing wrapper.
  // Iterating headings (not wrappers) keeps a single hit per group even when
  // the hash-agnostic wrapper selector matches nested wrappers.
  const headings = Array.from(
    document.querySelectorAll(selectors.sectionHeading),
  );
  for (const heading of headings) {
    const headingId = heading.id ?? "";
    const headingLabel = normalizeLabel(normalizeText(heading.textContent));

    let bucket: WhakapapaFacilityItem[] | null = null;
    if (headingId === "facilities" || headingLabel === "facilities") {
      bucket = facilities;
    } else if (headingId === "food-drink" || headingLabel === "food & drink") {
      bucket = foodAndDrink;
    } else if (headingId === "lifts" || headingLabel === "lifts") {
      bucket = lifts;
    }
    if (!bucket) {
      continue;
    }

    const wrapper =
      heading.closest(selectors.sectionWrapper) ?? heading.parentElement;
    const itemsContainer = wrapper?.querySelector(selectors.sectionItems);
    if (!itemsContainer) {
      continue;
    }

    bucket.push(...parseFacilityItems(itemsContainer, selectors));
  }

  const conditionNodes = Array.from(
    document.querySelectorAll(selectors.conditionRow),
  );
  const conditions: WhakapapaCondition[] = conditionNodes
    .map((node) => ({
      name: normalizeText(
        node.querySelector(selectors.conditionTitle)?.textContent,
      ),
      temperature: normalizeText(
        node.querySelector(selectors.conditionTemperature)?.textContent,
      ),
      wind: findMetricValue(node, "Wind"),
      snowBase: findMetricValue(node, "Snow Base"),
      snowfall24h: findMetricValue(node, "24 hr Snowfall"),
      snowfall7d: findMetricValue(node, "7 day Snowfall"),
    }))
    .filter((item) => item.name.length > 0);

  const trails = parseTrailAreas(document, selectors);

  const curlData = emptyWhakapapaCurlData();
  curlData.updated = new Date().toISOString();
  curlData.roadStatus = roadStatus;
  curlData.facilities = facilities;
  curlData.foodAndDrink = foodAndDrink;
  curlData.lifts = lifts;
  curlData.conditions = conditions;
  curlData.trails = trails;

  return curlData;
}
