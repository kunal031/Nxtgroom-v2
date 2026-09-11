import type { AttendanceRecord } from './types.ts';

export const BUSINESS_TIME_ZONE = 'Asia/Kolkata';

export function localDateValue(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

export function formatAttendanceTime(value?: string | Date | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatAttendanceDate(value?: string | Date | null): string {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: BUSINESS_TIME_ZONE,
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

/** Makes a session that crosses midnight explicit without moving its check-in day. */
export function attendanceSessionDateLabel(
  checkIn?: string | Date | null,
  checkOut?: string | Date | null,
  fallbackDate?: string | Date | null,
): string {
  const start = checkIn || fallbackDate;
  if (!start) return '--';
  if (checkOut && localDateValue(new Date(start)) !== localDateValue(new Date(checkOut))) {
    return `${formatAttendanceDate(start)} – ${formatAttendanceDate(checkOut)}`;
  }
  return formatAttendanceDate(start);
}

/**
 * Shows the checkout calendar date when it differs from the check-in date.
 *
 * `checkoutStatus` distinguishes a day that ended with nobody checking out from
 * one still in progress. Both have no check-out time, and a dash for each read
 * as "not yet" for a record that was abandoned weeks ago.
 */
export function checkoutDateTimeLabel(
  checkIn?: string | Date | null,
  checkOut?: string | Date | null,
  checkoutStatus?: string | null,
): string {
  if (!checkOut) {
    return checkoutStatus === 'not_checked_out' ? 'Not checked out' : '--';
  }
  if (checkIn) {
    const checkInKey = localDateValue(new Date(checkIn));
    const checkOutKey = localDateValue(new Date(checkOut));
    if (checkInKey !== checkOutKey) {
      const [startYear, startMonth, startDay] = checkInKey.split('-').map(Number);
      const [endYear, endMonth, endDay] = checkOutKey.split('-').map(Number);
      const dayDifference = Math.round(
        (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay))
        / 86_400_000,
      );
      const differenceLabel = dayDifference > 0
        ? `+${dayDifference} ${dayDifference === 1 ? 'day' : 'days'}`
        : `${dayDifference} ${dayDifference === -1 ? 'day' : 'days'}`;
      return `${formatAttendanceDate(checkOut)}, ${formatAttendanceTime(checkOut)} (${differenceLabel})`;
    }
  }
  return formatAttendanceTime(checkOut);
}

export function attendancePath(date?: string | null): string {
  if (!date) return '/api/v2/attendance/today';
  return `/api/v2/attendance/today?${new URLSearchParams({ date }).toString()}`;
}

export type DatePreset = 'today' | 'last_week' | 'last_month' | 'all_time' | 'custom';

export interface DateRange {
  /** Inclusive. Empty means open-ended, which only "all time" uses. */
  from: string;
  /** Inclusive. */
  to: string;
}

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'last_week', label: 'Last 7 days' },
  { value: 'last_month', label: 'Last 30 days' },
  { value: 'all_time', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

/** Shifts a calendar date by whole days without crossing into UTC. */
function shiftDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/**
 * The dates a preset covers, both ends inclusive.
 *
 * "Last 7 days" includes today, so it is the six days before it plus today
 * rather than the seven before it — a filter that excluded the current day
 * would hide the check-ins someone is most likely looking for.
 */
export function rangeForPreset(preset: DatePreset, today: string = localDateValue()): DateRange {
  switch (preset) {
    case 'last_week':
      return { from: shiftDays(today, -6), to: today };
    case 'last_month':
      return { from: shiftDays(today, -29), to: today };
    case 'all_time':
      // Both ends open. The server leaves the date filter off entirely rather
      // than inventing an earliest date the records would have to sit after.
      return { from: '', to: '' };
    case 'custom':
    case 'today':
    default:
      return { from: today, to: today };
  }
}

function formatShort(value: string): string {
  if (!value) return '';
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** What the trigger reads, so the active filter is legible without opening it. */
export function describeRange(preset: DatePreset, range: DateRange): string {
  if (preset !== 'custom') {
    return DATE_PRESETS.find((option) => option.value === preset)?.label || 'Today';
  }
  if (!range.from || !range.to) return 'Custom range';
  if (range.from === range.to) return formatShort(range.from);
  return `${formatShort(range.from)} – ${formatShort(range.to)}`;
}

/** True when the range is usable, so a half-filled custom range never queries. */
export function isCompleteRange(range: DateRange, preset: DatePreset): boolean {
  if (preset === 'all_time') return true;
  if (!range.from || !range.to) return false;
  return range.from <= range.to;
}

/**
 * The endpoint for a date range.
 *
 * A single day still uses the `date` parameter the endpoint has always
 * accepted, so the common case produces the same request it did before and
 * nothing about existing behaviour changes.
 */
export function attendanceRangePath(range: DateRange): string {
  if (!range.from && !range.to) {
    return `/api/v2/attendance/today?${new URLSearchParams({ from: '', to: '' }).toString()}`;
  }
  if (range.from && range.from === range.to) return attendancePath(range.from);
  const params = new URLSearchParams();
  if (range.from) params.set('from', range.from);
  if (range.to) params.set('to', range.to);
  return `/api/v2/attendance/today?${params.toString()}`;
}

export function uniqueRecordValues<T>(
  records: T[],
  field: keyof T & string,
  selectedValue = '',
): string[] {
  const values = records.map((record) => record[field]).filter(Boolean).map(String);
  if (selectedValue) values.push(selectedValue);
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

export interface AttendanceFilters {
  search?: string;
  role?: string;
  college?: string;
}

export function filterAttendanceRecords(
  records: AttendanceRecord[],
  { search = '', role = '', college = '' }: AttendanceFilters = {},
): AttendanceRecord[] {
  const term = search.trim().toLowerCase();
  return records.filter((record) => {
    if (role && record.instructor_role !== role) return false;
    if (college && record.college_name !== college) return false;
    if (!term) return true;
    return [
      record.instructor_name,
      record.instructor_role,
      record.college_name,
      record.location_coordinates,
      record.remarks,
    ].some((value) => String(value || '').toLowerCase().includes(term));
  });
}
