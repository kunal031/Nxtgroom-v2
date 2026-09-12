/**
 * What one photograph at the tablet should do.
 *
 * The kiosk has no buttons: somebody stands in front of the camera and the
 * system works out whether this is their arrival or their departure. That
 * decision is made here, apart from the route, because it is the whole
 * behaviour of the screen and it must be provable without a camera, a database
 * or a clock.
 *
 * Every branch is a state the day can already be in, so nothing new is being
 * invented — the rules are the ones check-in and check-out already apply, read
 * in one place rather than chosen by whoever pressed a button.
 */

export const KIOSK_ACTIONS = Object.freeze({
  CHECK_IN: "CHECK_IN",
  CHECK_OUT: "CHECK_OUT",
  /** Recognised, but their day is already closed. Nothing to record. */
  ALREADY_DONE: "ALREADY_DONE",
  /** Recognised and checked in, but too soon to close the day. */
  TOO_EARLY: "TOO_EARLY",
  /** Nobody matched. A check-in is still recorded; a departure cannot be. */
  UNIDENTIFIED: "UNIDENTIFIED",
});

/**
 * Decides the action from the day's record.
 *
 * `availability` is checkoutAvailability's verdict for that record, so the
 * timing rules — noon for a morning arrival, ten minutes for an afternoon one —
 * are applied in exactly one place rather than restated here.
 *
 * An unrecognised face still checks in. That is the asymmetry the whole design
 * rests on: a check-in creates a record that an administrator can name later,
 * while a check-out must close one specific existing session and cannot be
 * guessed at.
 */
export function decideKioskAction({ matched, availability }) {
  if (!matched) return KIOSK_ACTIONS.UNIDENTIFIED;
  switch (availability) {
    case "not_checked_in_today":
      return KIOSK_ACTIONS.CHECK_IN;
    case "available":
      return KIOSK_ACTIONS.CHECK_OUT;
    case "too_early":
      return KIOSK_ACTIONS.TOO_EARLY;
    case "already_checked_out_today":
      return KIOSK_ACTIONS.ALREADY_DONE;
    default:
      // An unknown verdict must not silently become a check-in, which would
      // write a second record for a day that already has one.
      return KIOSK_ACTIONS.ALREADY_DONE;
  }
}

/**
 * What the tablet says, for each outcome.
 *
 * The popup is the only confirmation anybody gets: there is no button press to
 * review and no screen to read afterwards. So each message names the person and
 * says what was recorded, and a refusal says why rather than only that it
 * failed.
 */
export function describeKioskAction(action, { instructorName, opensAtLabel, minutesRemaining } = {}) {
  const name = instructorName || "Instructor";
  switch (action) {
    case KIOSK_ACTIONS.CHECK_IN:
      return { title: `${name} checked in`, tone: "success" };
    case KIOSK_ACTIONS.CHECK_OUT:
      return { title: `${name} checked out`, tone: "success" };
    case KIOSK_ACTIONS.TOO_EARLY:
      return {
        title: `${name} is already checked in`,
        detail: opensAtLabel
          ? `Check-out opens at ${opensAtLabel}.`
          : minutesRemaining
            ? `Check-out opens in about ${minutesRemaining} minute${minutesRemaining === 1 ? "" : "s"}.`
            : "It is too early to check out.",
        tone: "info",
      };
    case KIOSK_ACTIONS.ALREADY_DONE:
      return {
        title: `${name} has already checked out today`,
        detail: "Nothing was recorded.",
        tone: "info",
      };
    case KIOSK_ACTIONS.UNIDENTIFIED:
      return {
        title: "Not recognised",
        detail: "The check-in was recorded for an administrator to name. To check out, try again or ask an administrator to update your reference photo.",
        tone: "warning",
      };
    default:
      return { title: "Nothing recorded", tone: "info" };
  }
}

/** Whether this outcome wrote anything, for the counters and the screen. */
export function kioskActionRecorded(action) {
  return action === KIOSK_ACTIONS.CHECK_IN
    || action === KIOSK_ACTIONS.CHECK_OUT
    || action === KIOSK_ACTIONS.UNIDENTIFIED;
}
