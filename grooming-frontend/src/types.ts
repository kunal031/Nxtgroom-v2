/** Shared domain types mirroring the API's serialized documents. */

export type Role = 'SUPER_ADMIN' | 'ADMIN' | 'BOA';

/** Roles with organisation-wide reach. */
export const ELEVATED_ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN'];

export const ALL_ROLES: readonly Role[] = ['SUPER_ADMIN', 'ADMIN', 'BOA'];

export function isElevatedRole(role: Role | null | undefined): boolean {
  return role === 'SUPER_ADMIN' || role === 'ADMIN';
}

export interface AdminUser {
  _id: string;
  name: string;
  email: string;
  role: Role;
  created_at?: string | null;
  disabled_at?: string | null;
}

export type AttendanceStatus =
  | 'compliant'
  | 'non_compliant'
  /** Analysed, but the photograph showed nothing to judge. Neither of the above. */
  | 'unassessed'
  /**
   * Recorded, but face recognition could not say who it is. Nothing was
   * analysed and nothing is queued: it waits for an administrator to attach an
   * instructor. Distinct from pending, which means analysis is still running.
   */
  | 'unidentified'
  | 'error'
  | 'pending';

export type ImageQuality = 'ADEQUATE' | 'RETAKE_RECOMMENDED';

export interface College {
  _id: string;
  name: string;
  location: string;
}

export interface Boa {
  _id: string;
  employee_id: string;
  name: string;
  college_id: string;
  college_name?: string | null;
  email?: string | null;
  created_at?: string;
}

export interface DailyFeedback {
  date?: string;
  status?: string;
  overall_status?: string;
}

export interface Instructor {
  _id: string;
  uuid?: string;
  /** Optional: instructors synced from BigQuery are keyed by instructor_user_id. */
  employee_id?: string;
  name: string;
  role: string;
  gender: string;
  college_id: string;
  college_name?: string | null;
  email?: string | null;
  /**
   * Whether an address exists. A BOA is not shown the address itself, so
   * without this the interface cannot tell "has none" from "may not see it".
   */
  has_email?: boolean;
  phone_no?: string | null;
  created_at?: string;
  daily_feedbacks?: DailyFeedback[];
  /**
   * How many reference faces are enrolled for this instructor. Zero or absent
   * means recognition cannot identify them, so every check-in reaches the
   * unidentified queue until a photo is added.
   */
  face_count?: number;
  face_indexed_at?: string | null;
  /** Fields owned by the BigQuery roster; absent on manually created rows. */
  instructor_user_id?: string | null;
  instructor_role?: string | null;
  institute_name?: string | null;
  instructor_category?: string | null;
  source?: string | null;
  synced_at?: string | null;
}

export interface AttendanceRecord {
  _id: string;
  instructor_id: string;
  instructor_name?: string;
  instructor_role?: string;
  college_name?: string;
  date?: string;
  check_in_time?: string;
  check_out_time?: string | null;
  location_coordinates?: string | null;
  /** Reported accuracy of the fix in metres; distinguishes GPS from an IP estimate. */
  location_accuracy_m?: number | null;
  /** Reverse-geocoded once at check-in and stored, not looked up per view. */
  location_address?: string | null;
  location_address_full?: string | null;
  /** Where the check-out happened, captured separately from the check-in fix. */
  check_out_coordinates?: string | null;
  check_out_location_accuracy_m?: number | null;
  /** Its own reverse-geocoded name: the two halves can be different places. */
  check_out_location_address?: string | null;
  /**
   * Set to "not_checked_out" by the midnight job when a day ended with the
   * check-in still open. Descriptive only: the record stays closeable, so a
   * session that ran past midnight can still be closed afterwards.
   */
  checkout_status?: string | null;
  /** The check-out's own verdict. The fields above hold the check-in's. */
  checkout_compliance_status?: string | null;
  checkout_remarks?: string | null;
  /** queued or processing while a job is outstanding; cleared when it ends. */
  evaluation_queue_status?: string | null;
  checkout_evaluation_queue_status?: string | null;
  /** FORMAL | SAREE | KURTI_WITH_DUPATTA | UNKNOWN, set by the AI analysis. */
  attire_type?: string | null;
  /** The instructor's public report token, for linking to their own report. */
  report_token?: string | null;
  /** R2 object keys. Presence is what enables the view-photo buttons. */
  check_in_photo_key?: string | null;
  check_out_photo_key?: string | null;
  status?: string;
  remarks?: string | null;
}

export interface CheckItem {
  /** Stable identity for the checkpoint. Internal: never rendered. */
  code?: string;
  checkpoint_name: string;
  observation: string;
  status: 'PASS' | 'FAIL' | 'N/A';
  reason: string;
}

export type Visibility = 'VISIBLE' | 'PARTIAL' | 'NOT_VISIBLE';

/** Which parts of the body the photograph showed. Explains the N/A rows. */
export interface VisibleRegions {
  face: Visibility;
  upper_body: Visibility;
  lower_body: Visibility;
  footwear: Visibility;
  id_card: Visibility;
  hands: Visibility;
}

export type AttireType = 'FORMAL' | 'SAREE' | 'KURTI_WITH_DUPATTA' | 'UNKNOWN';

/** Counted from the week's records, never from a single photograph. */
export interface WeeklyRotation {
  saree_days: number;
  kurti_days: number;
  unknown_days: number;
  required_saree_days: number;
  required_kurti_days: number;
  status: 'IN_PROGRESS' | 'PASS' | 'FAIL' | 'INSUFFICIENT_DATA';
}

export interface Evaluation {
  overall_status?: string;
  ai_summary?: string;
  image_quality?: ImageQuality;
  attire_type?: AttireType;
  visible_regions?: VisibleRegions | null;
  /** Set when no assessment was attempted, so the report can say why. */
  unassessed_reason?: string | null;
  /** Derived from the failing checkpoints by the backend, in report order. */
  improvement_tips?: string[];
  general_idcard_check?: CheckItem[];
  grooming_check?: CheckItem[];
  attire_check?: CheckItem[];
  accessories_check?: CheckItem[];
  footwear_check?: CheckItem[];
}

export interface CurrentUser {
  email: string;
  role: Role;
  college_id: string | null;
  /** Whether this account may delete a whole attendance record. */
  can_delete_records?: boolean;
  /** Whether it may remove a check-out on its own, leaving the check-in. */
  can_delete_checkout?: boolean;
  /** Workspace-wide: whether the Re-analyse control is shown on a report. */
  reanalyse_enabled?: boolean;
  /**
   * Whether this account may name an unidentified check-in, and discard one.
   * Off for a BOA until granted, since naming decides whose attendance a
   * record becomes and enrolls that photograph as a face for them.
   */
  can_identify?: boolean;
}

/** One account's capabilities, and where each answer comes from. */
export interface UserPermissions {
  user_id?: string;
  email?: string;
  role?: Role;
  can_delete_records: boolean;
  /** ROLE for admins, USER for a personal override, WORKSPACE for the default. */
  source: 'ROLE' | 'USER' | 'WORKSPACE';
  workspace_default: boolean;
}

export interface AccessSettings {
  boa_can_delete_records: boolean;
  boa_can_delete_checkout: boolean;
  /**
   * Whether BOAs may name an unidentified check-in. Deliberately not implied by
   * the delete permissions: discarding a photograph and deciding whose
   * attendance record it becomes are different powers.
   */
  boa_can_identify: boolean;
}

export type IdentificationMode = 'FACE_ONLY' | 'SELECTOR';

/** One college's identification mode, with the enrolment behind it. */
export interface CollegeIdentification {
  college_id: string;
  college_name: string | null;
  mode: IdentificationMode;
  /** COLLEGE when set for this college, DEFAULT when following the global one. */
  source: 'COLLEGE' | 'DEFAULT';
  instructors: number;
  enrolled: number;
  enrolled_percent: number;
  /** Advisory: face-only with too few enrolled faces. Never changes the mode. */
  low_enrolment: boolean;
}

export interface IdentificationSettings {
  default_mode: IdentificationMode;
  modes: IdentificationMode[];
  low_enrolment_percent: number;
  colleges: CollegeIdentification[];
}

export interface NotificationSettings {
  checkin_email_enabled: boolean;
  checkout_email_enabled: boolean;
  weekly_email_enabled: boolean;
  only_when_non_compliant: boolean;
  /** Whether the Re-analyse control is offered on a record's report. */
  reanalyse_enabled: boolean;
}

/** Options accepted by the shared fetch helpers. */
export interface ApiRequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Set false for endpoints that must be called without a bearer token. */
  auth?: boolean;
  timeoutMs?: number;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  role: Role;
  expires_in: number;
}

export interface PaginatedOptions extends ApiRequestOptions {
  pageSize?: number;
  maxItems?: number;
  /** Optional per-page GET cache; also deduplicates concurrent pagination. */
  cacheMs?: number;
}
