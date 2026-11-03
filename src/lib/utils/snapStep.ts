import type { TranslationKey } from '$lib/i18n';
import { formatLength, formatLengthPrecise, type ProjectSettings, type SnapStep } from '$lib/stores/settings';
import { SNAP, SNAP_FINEST } from '$lib/utils/canvasInteraction';

/**
 * The status-bar Snap button (S) chooses the step that snapping rounds to, cycling the grid size,
 * 10 cm, 5 cm, then off (no rounding at all) and back to the grid. The top-bar Snap to Grid switch
 * still turns snapping off entirely and remembers the step. The steps stay metric (25, 10 and 5 cm)
 * in either unit system, so in feet and inches the label keeps a tenth of an inch (25 cm reads
 * 9.8") instead of rounding to a whole inch the plan does not snap to.
 */
export function snapStepLabel(stepCm: number, units: ProjectSettings['units']): string {
  return units === 'imperial' ? formatLengthPrecise(stepCm, units) : formatLength(stepCm, units);
}

const CYCLE: SnapStep[] = ['grid', SNAP, SNAP_FINEST, 'off'];

/** The step S switches to: grid, 10 cm, 5 cm, off, then the grid again. */
export function nextSnapStep(step: SnapStep): SnapStep {
  return CYCLE[(CYCLE.indexOf(step) + 1) % CYCLE.length];
}

/** Settings after S: the next step, with the legacy snapToGrid flag (true only on the grid step) kept in sync. */
export function cycleSnapStep(s: ProjectSettings): ProjectSettings {
  const snapStep = nextSnapStep(s.snapStep);
  return { ...s, snapStep, snapToGrid: snapStep === 'grid' };
}

export interface SnapStatus { label: string; title: string; pressed: boolean }

/**
 * What the status-bar Snap button shows. While the top-bar Snap to Grid switch is on, it names the
 * step S picked and is pressed on the grid step; the "off" step reads "Snap off" and is not
 * pressed. While the switch is off nothing rounds to a step, so it also reads "Snap off"; its
 * title says S still picks the step used once the switch is back on.
 */
export function snapStatus(
  t: (key: TranslationKey, variables?: Record<string, string | number>) => string,
  snapping: { enabled: boolean; snapStep: SnapStep; gridSize: number },
  units: ProjectSettings['units'],
): SnapStatus {
  const grid = snapStepLabel(snapping.gridSize, units), fine = snapStepLabel(SNAP, units), finest = snapStepLabel(SNAP_FINEST, units);
  const { snapStep } = snapping;
  const step = snapStep === 'off' ? t('canvasDisplay.snapNone') : snapStep === 'grid' ? grid : snapStepLabel(snapStep, units);
  if (!snapping.enabled) return { label: t('canvasDisplay.snapOff'), title: t('canvasDisplay.snapOffHint', { grid, fine, finest, step }), pressed: false };
  return {
    label: snapStep === 'off' ? t('canvasDisplay.snapOff') : t('canvasDisplay.snap', { step }),
    title: t('canvasDisplay.snapHint', { grid, fine, finest }),
    pressed: snapStep === 'grid',
  };
}
