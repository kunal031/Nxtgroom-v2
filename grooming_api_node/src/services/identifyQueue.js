/**
 * Resolving check-ins whose face was not recognised.
 *
 * The decisions here are kept as pure functions because each of them can lose or
 * misfile somebody's attendance: naming a record decides whose day it becomes,
 * and discarding one throws away the only evidence that a person arrived. They
 * are therefore provable without a database.
 */

/** How close a later recognised check-in has to be to look like the same arrival. */
export const RETRY_WINDOW_MS = 30 * 60_000;

export const IDENTIFY_OUTCOMES = Object.freeze({
  OK: "OK",
  NOT_FOUND: "NOT_FOUND",
  ALREADY_IDENTIFIED: "ALREADY_IDENTIFIED",
  INSTRUCTOR_NOT_FOUND: "INSTRUCTOR_NOT_FOUND",
  INSTRUCTOR_ALREADY_CHECKED_IN: "INSTRUCTOR_ALREADY_CHECKED_IN",
  NO_GENDER: "NO_GENDER",
});

/**
 * Why a photograph could not be matched, in words an operator can act on.
 *
 * The stored outcome is a provider reason. Shown raw it tells somebody nothing
 * about what to do, and the queue is triaged by whoever reads it.
 */
export const FAILURE_EXPLANATIONS = Object.freeze({
  NO_MATCH: "No enrolled instructor resembled this face.",
  BELOW_THRESHOLD: "The closest enrolled instructor was not a confident enough match.",
  NO_FACE: "No face could be found in the photograph.",
  MULTIPLE_FACES: "More than one face was in the photograph.",
  POOR_QUALITY: "The face was too blurry or too dark to match.",
  PROVIDER_ERROR: "The recognition service could not be reached at the time.",
  NOT_CONFIGURED: "Face recognition was not configured when this photo was taken.",
});

export function explainFailure(outcome) {
  return FAILURE_EXPLANATIONS[outcome] || "The instructor could not be identified from this photograph.";
}

/**
 * A later recognised check-in that probably belongs to this same arrival.
 *
 * Offered as a suggestion, never applied. The unidentified photograph failed to
 * match, so nothing actually links it to the recognised record — only the
 * college, the day and a few minutes. Discarding somebody's attendance on that
 * basis would be a guess, so the decision stays with the person who can compare
 * the two photographs.
 *
 * Candidates are ranked by how soon after the failure they arrived, because a
 * retake follows a failure closely; an unrelated check-in twenty minutes later
 * is the weaker explanation even though both fall inside the window.
 */
export function findRetryCandidates(unidentified, sameDayRecords, { windowMs = RETRY_WINDOW_MS } = {}) {
  const failedAt = new Date(unidentified?.check_in_time || 0).getTime();
  if (!Number.isFinite(failedAt) || failedAt === 0) return [];

  return (sameDayRecords || [])
    .filter((record) => {
      if (!record || String(record._id) === String(unidentified._id)) return false;
      // Only a record that names somebody can explain an unidentified one.
      if (typeof record.instructor_id !== "string" || !record.instructor_id) return false;
      // Same college, or both unscoped: a recognised check-in at another campus
      // is not a retake of this one.
      const sameCollege = String(record.college_id || "") === String(unidentified.college_id || "");
      if (!sameCollege) return false;
      const at = new Date(record.check_in_time || 0).getTime();
      if (!Number.isFinite(at)) return false;
      // Strictly after: a check-in that happened first cannot be the retry of a
      // failure that had not occurred yet.
      return at > failedAt && at - failedAt <= windowMs;
    })
    .map((record) => ({
      attendance_id: String(record._id),
      instructor_id: String(record.instructor_id),
      instructor_name: record.instructor_name || null,
      check_in_time: record.check_in_time,
      minutes_later: Math.round((new Date(record.check_in_time).getTime() - failedAt) / 60_000),
    }))
    .sort((left, right) => left.minutes_later - right.minutes_later);
}

/**
 * Whether this record can be named, and what the caller should be told.
 *
 * ALREADY_IDENTIFIED is its own outcome rather than a generic conflict because
 * two administrators working the same queue is ordinary, and the second one
 * needs to know the work was already done rather than that something failed.
 *
 * INSTRUCTOR_ALREADY_CHECKED_IN does not refuse on its own. The caller decides:
 * that instructor having a record already is usually a retry the queue has not
 * caught up with, and the useful response is to say so rather than to insist.
 */
export function assessIdentification({ record, instructor, existingRecordToday }) {
  if (!record) return { outcome: IDENTIFY_OUTCOMES.NOT_FOUND };
  if (record.status !== "unidentified" || typeof record.instructor_id === "string") {
    return {
      outcome: IDENTIFY_OUTCOMES.ALREADY_IDENTIFIED,
      instructor_id: record.instructor_id || null,
      instructor_name: record.instructor_name || null,
    };
  }
  if (!instructor) return { outcome: IDENTIFY_OUTCOMES.INSTRUCTOR_NOT_FOUND };

  if (existingRecordToday) {
    return {
      outcome: IDENTIFY_OUTCOMES.INSTRUCTOR_ALREADY_CHECKED_IN,
      existing_attendance_id: String(existingRecordToday._id),
      existing_check_in_time: existingRecordToday.check_in_time,
      // Whether that record was recognised tells the administrator whether this
      // is the retry case or two genuinely separate arrivals.
      existing_was_recognised: existingRecordToday?.identification?.outcome === "MATCHED",
    };
  }

  // Gender chooses the dress code, so without it an analysis returns an
  // unassessed report. The record is still nameable: the attendance is the
  // point, and the analysis can follow once somebody sets the gender.
  if (!instructor.gender) {
    return { outcome: IDENTIFY_OUTCOMES.NO_GENDER, instructor_id: String(instructor._id) };
  }
  return { outcome: IDENTIFY_OUTCOMES.OK, instructor_id: String(instructor._id) };
}

/**
 * The fields that turn an unidentified record into one instructor's check-in.
 *
 * The check-in time, photograph, coordinates and address are left exactly as
 * they were: they are what actually happened, and the only thing that was
 * missing is who it happened to. identification keeps the original failure
 * alongside the correction, so the record still says why recognition missed.
 */
export function identifiedRecordUpdate({ instructor, record, identifiedBy, now = new Date() }) {
  return {
    instructor_id: String(instructor._id),
    instructor_name: instructor.name || null,
    instructor_role: instructor.instructor_role || instructor.role || null,
    // The instructor's own college now owns the record. It was stamped with the
    // tablet's college so the queue would be visible; once the person is known,
    // their college is the correct scope for every report that reads it.
    college_id: instructor.college_id ? String(instructor.college_id) : record.college_id || null,
    status: "pending",
    remarks: "Identified by an administrator. AI analysis has not run yet.",
    identification: {
      ...(record.identification || {}),
      method: "ADMIN",
      outcome: "IDENTIFIED",
      // Retained so the queue's own history survives the correction: this is the
      // evidence that a particular instructor's face is not matching reliably.
      original_outcome: record.identification?.outcome || null,
      identified_by: identifiedBy || null,
      identified_at: now,
    },
    updated_at: now,
  };
}
