// Door frames in the 3D viewer. Frames reach OVERLAP into their opening so no frame face is
// coplanar with a wall reveal (coplanar faces z-fight). Window frames line the opening instead.

const DOOR_JAMB = 5;
const OVERLAP = 0.5;

/** Jambs and header around a door opening spanning `left`..`right` along the wall path (cm).
 * Depth is wall thickness + 3: 0.5 cm proud of the baseboard on each face. */
export function doorFrameBoxes(left: number, right: number, doorHeight: number, wallThickness: number) {
  const width = DOOR_JAMB + OVERLAP, depth = wallThickness + 3;
  return [
    { center: left - DOOR_JAMB / 2 + OVERLAP / 2, width, bottom: 0, height: doorHeight, depth },
    { center: right + DOOR_JAMB / 2 - OVERLAP / 2, width, bottom: 0, height: doorHeight, depth },
    { center: (left + right) / 2, width: right - left + DOOR_JAMB * 2, bottom: doorHeight - OVERLAP,
      height: DOOR_JAMB + OVERLAP, depth },
  ];
}
