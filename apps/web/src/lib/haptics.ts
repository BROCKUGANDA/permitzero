/**
 * Touch feedback is a confirmation, not decoration. A short tick on a
 * navigation change says "the view changed"; a double pulse on an approval
 * says "a durable decision was recorded"; a long buzz on a rejection says
 * "this stops the request". On devices without a vibration motor every call
 * is a no-op, so callers never have to branch on support.
 *
 * Haptics are skipped when the user has asked for reduced motion: for a lot
 * of people that preference is about unwanted physical sensation as much as
 * visual movement.
 */

export type HapticCue = 'tick' | 'select' | 'confirm' | 'reject' | 'alert';

const PATTERNS: Record<HapticCue, number | number[]> = {
  tick: 8,
  select: 14,
  confirm: [18, 40, 26],
  reject: [45, 50, 45, 50, 90],
  alert: [30, 60, 30],
};

export function haptic(cue: HapticCue): void {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return;
  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch {
    // A missing matchMedia is not a reason to drop feedback.
  }
  const vibrate = navigator.vibrate?.bind(navigator);
  if (!vibrate) return;
  try {
    vibrate(PATTERNS[cue]);
  } catch {
    // Some browsers expose vibrate but throw when it is called outside a
    // user gesture. Feedback must never break the action it accompanies.
  }
}
