import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attendancePath,
  attendanceSessionDateLabel,
  checkoutDateTimeLabel,
  filterAttendanceRecords,
  localDateValue,
  uniqueRecordValues,
  rangeForPreset,
  attendanceRangePath,
  isCompleteRange,
} from '../src/attendanceFilters.ts';

const records = [
  { instructor_name: 'Asha', instructor_role: 'Lead Instructor', college_name: 'Campus B', location_coordinates: '17.1,78.2', remarks: 'Compliant' },
  { instructor_name: 'Ravi', instructor_role: 'Trainee', college_name: 'Campus A', location_coordinates: '18.2,79.3', remarks: 'Review needed' },
];

test('builds a date-keyed attendance endpoint and local date value', () => {
  assert.equal(attendancePath('2026-08-14'), '/api/v2/attendance/today?date=2026-08-14');
  assert.equal(attendancePath(''), '/api/v2/attendance/today');
  assert.equal(localDateValue(new Date(2026, 7, 4)), '2026-08-04');
});

test('cross-midnight sessions show the checkout on its actual calendar date', () => {
  const checkIn = '2026-08-20T18:03:42.000Z';
  const checkOut = '2026-08-20T19:02:53.000Z';
  assert.equal(attendanceSessionDateLabel(checkIn, checkOut), '20 Aug 2026 – 21 Aug 2026');
  assert.equal(checkoutDateTimeLabel(checkIn, checkOut), '21 Aug 2026, 12:32 am (+1 day)');
});

test('same-day sessions keep the compact checkout time', () => {
  const checkIn = '2026-08-20T03:00:00.000Z';
  const checkOut = '2026-08-20T11:00:00.000Z';
  assert.equal(attendanceSessionDateLabel(checkIn, checkOut), '20 Aug 2026');
  assert.equal(checkoutDateTimeLabel(checkIn, checkOut), '04:30 pm');
});

test('filters attendance by role, college, and searchable visible fields', () => {
  assert.deepEqual(filterAttendanceRecords(records, { role: 'Trainee' }), [records[1]]);
  assert.deepEqual(filterAttendanceRecords(records, { college: 'Campus B' }), [records[0]]);
  assert.deepEqual(filterAttendanceRecords(records, { search: '79.3' }), [records[1]]);
  assert.deepEqual(filterAttendanceRecords(records, { search: 'campus a', role: 'Trainee' }), [records[1]]);
});

test('filter options are unique, sorted, and retain a selected historical value', () => {
  assert.deepEqual(uniqueRecordValues(records, 'college_name'), ['Campus A', 'Campus B']);
  assert.deepEqual(uniqueRecordValues([], 'college_name', 'Campus Z'), ['Campus Z']);
});

test('presets cover the days people mean by them', () => {
  const today = '2026-08-18';
  assert.deepEqual(rangeForPreset('today', today), { from: today, to: today });
  // Seven days including today, not the seven before it: a filter that hid
  // the current day would hide the check-ins most people are looking for.
  assert.deepEqual(rangeForPreset('last_week', today), { from: '2026-08-12', to: today });
  assert.deepEqual(rangeForPreset('last_month', today), { from: '2026-07-20', to: today });
  // Both ends open, so the server leaves the date filter off entirely rather
  // than inventing an earliest date records would have to sit after.
  assert.deepEqual(rangeForPreset('all_time', today), { from: '', to: '' });
});

test('presets step across month and year boundaries by calendar date', () => {
  assert.deepEqual(rangeForPreset('last_week', '2026-01-03'), { from: '2025-12-28', to: '2026-01-03' });
  assert.deepEqual(rangeForPreset('last_month', '2026-03-05'), { from: '2026-02-04', to: '2026-03-05' });
  // 2028 is a leap year, so the window has to include 29 February.
  assert.deepEqual(rangeForPreset('last_week', '2028-03-02'), { from: '2028-02-25', to: '2028-03-02' });
});

test('a single day still uses the endpoint the page always used', () => {
  // Keeps the common case producing exactly the request it did before, so
  // nothing about existing behaviour depends on the new range parameters.
  assert.equal(attendanceRangePath({ from: '2026-08-18', to: '2026-08-18' }), '/api/v2/attendance/today?date=2026-08-18');
});

test('a range asks for both bounds, and all time asks for neither', () => {
  assert.equal(
    attendanceRangePath({ from: '2026-08-01', to: '2026-08-18' }),
    '/api/v2/attendance/today?from=2026-08-01&to=2026-08-18'
  );
  assert.equal(attendanceRangePath({ from: '', to: '' }), '/api/v2/attendance/today?from=&to=');
  // One open end is a legitimate range, not a broken one.
  assert.equal(attendanceRangePath({ from: '2026-08-01', to: '' }), '/api/v2/attendance/today?from=2026-08-01');
});

test('a half-filled custom range is not queried', () => {
  // Sending it would return every record from that date onwards, which is not
  // what someone half way through picking two dates asked for.
  assert.equal(isCompleteRange({ from: '2026-08-01', to: '' }, 'custom'), false);
  assert.equal(isCompleteRange({ from: '', to: '2026-08-01' }, 'custom'), false);
  assert.equal(isCompleteRange({ from: '2026-08-20', to: '2026-08-10' }, 'custom'), false);
  assert.equal(isCompleteRange({ from: '2026-08-10', to: '2026-08-20' }, 'custom'), true);
  assert.equal(isCompleteRange({ from: '2026-08-10', to: '2026-08-10' }, 'custom'), true);
  // All time is complete precisely because it has no bounds.
  assert.equal(isCompleteRange({ from: '', to: '' }, 'all_time'), true);
});

test('a day nobody closed reads differently from one still running', () => {
  // Both have no check-out time. Showing a dash for each made a record
  // abandoned weeks ago look like a session still in progress.
  const checkIn = '2026-09-11T03:30:00Z';
  assert.equal(checkoutDateTimeLabel(checkIn, null), '--');
  assert.equal(checkoutDateTimeLabel(checkIn, null, 'not_checked_out'), 'Not checked out');
});

test('a real check-out time wins over a leftover mark', () => {
  // The midnight mark is descriptive, not a lock: a session that ran past
  // midnight is marked and then closed, and the time is what happened.
  const checkIn = '2026-09-11T03:30:00Z';
  const marked = checkoutDateTimeLabel(checkIn, '2026-09-11T12:30:00Z', 'not_checked_out');
  assert.equal(marked, checkoutDateTimeLabel(checkIn, '2026-09-11T12:30:00Z'));
  assert.ok(!marked.includes('Not checked out'));
});

test('callers that know nothing about the status are unaffected', () => {
  // The argument was added last so every existing call site keeps compiling and
  // keeps its previous answer.
  assert.equal(checkoutDateTimeLabel('2026-09-11T03:30:00Z', null), '--');
  assert.equal(checkoutDateTimeLabel(null, null), '--');
});
