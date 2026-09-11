import { z } from "zod";

export const collegeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(160),
});

export const boaSchema = z.object({
  employee_id: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  // Omitted means "invite them to choose their own"; the route then emails a
  // one-time link instead of storing a password nobody selected.
  password: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
  college_id: z.string().trim().min(1).max(100),
});

export const boaUpdateSchema = z.object({
  employee_id: z.string().trim().min(1).max(50),
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
  college_id: z.string().trim().min(1).max(100),
});

export const instructorSchema = z.object({
  // Optional: instructors synced from BigQuery are keyed by instructor_user_id
  // and many carry no employee id at all.
  employee_id: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().trim().max(50).optional()
  ),
  name: z.string().trim().min(2).max(120),
  role: z.string().trim().min(1).max(80),
  // Mirrors role onto the field the tables display. Synced instructors are
  // shown by instructor_role, so an edit that only set role would appear to
  // do nothing. A later sync restores the BigQuery value, which is correct:
  // the warehouse is authoritative for people it knows about.
  instructor_role: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().trim().max(80).optional()
  ),
  gender: z.string().trim().transform((value) => value.toUpperCase()).pipe(z.enum(["MALE", "FEMALE"])),
  college_id: z.string().trim().min(1).max(100),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  phone_no: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().trim().max(30).regex(/^[+()\-\s\d]*$/, "Invalid phone number").optional()
  ),
});

/**
 * Gender on its own, for the inline editor in the instructor table.
 *
 * Separate from instructorSchema because that requires a college and email,
 * which synced instructors do not have — demanding them here would make the
 * field uneditable for exactly the people whose gender is missing.
 */
export const instructorGenderSchema = z.object({
  gender: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.enum(["MALE", "FEMALE"])),
});

export const checkoutSchema = z.object({
  // Optional because a face-only college sends no id: the photograph decides
  // whose session is being closed. The route still requires one in selector
  // mode, so relaxing it here does not let an unidentified check-out through.
  instructor_id: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().trim().min(1).max(100).optional()
  ),
  location_coordinates: z.string().trim().max(100).optional().refine(
    (value) => !value || Boolean(parseCoordinates(value)),
    "location_coordinates must be valid latitude,longitude"
  ),
  location_accuracy_m: z.preprocess(
    (value) => value === "" || value == null ? undefined : Number(value),
    z.number().finite().min(0).max(100_000).optional()
  ),
});

export function parseCoordinates(value) {
  if (value == null || value === "") return null;
  const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const latitude = Number(match[1]);
  const longitude = Number(match[2]);
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;
  return `${latitude},${longitude}`;
}

export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(422).json({
        detail: result.error.issues.map((issue) => ({
          loc: ["body", ...issue.path],
          msg: issue.message,
          type: issue.code,
        })),
      });
    }
    req.validatedBody = result.data;
    return next();
  };
}

export const adminSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  // Optional for the same reason as boaSchema: a blank password means the new
  // administrator receives an invitation link instead.
  password: z.preprocess(
    (value) => (value === "" || value == null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
});

export const adminUpdateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  // Blank means "leave the existing credential alone".
  password: z.preprocess(
    (value) => (value === "" || value === null ? undefined : value),
    z.string().min(12).max(128).optional()
  ),
});

export const setPasswordSchema = z.object({
  new_password: z.string().min(12).max(128),
});
