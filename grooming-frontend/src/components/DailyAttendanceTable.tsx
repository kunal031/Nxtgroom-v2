import { useEffect, useMemo, useRef, useState } from 'react';
import { History, Search, MapPin, CheckCircle2, CircleAlert, XCircle, Clock, TriangleAlert, FileText, Image as ImageIcon, LogOut, Trash2, UserRoundSearch } from 'lucide-react';
import { apiFetchAllPages, apiJson } from '../api';
import PhotoViewer from './PhotoViewer';
import DateRangeFilter from './DateRangeFilter';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';
import {
  attendanceSessionDateLabel,
  attendanceRangePath,
  checkoutDateTimeLabel,
  formatAttendanceTime,
  rangeForPreset,
  type DatePreset,
  type DateRange,
  filterAttendanceRecords,
  localDateValue,
  uniqueRecordValues,
} from '../attendanceFilters';
import { publicDayReportPath } from '../routes';
import { canOpenRecord, formatCoordinates, normalizeAttendanceStatus } from '../status';
import type { AttendanceRecord } from '../types';

interface DailyAttendanceTableProps {
  onRowClick: (record: AttendanceRecord) => void;
  canBulkDelete?: boolean;
}

interface BulkDeleteResult {
  message: string;
  deleted_ids: string[];
  failed: Array<{ attendance_id: string; detail: string }>;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={12} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={12} aria-hidden="true" /> Non-compliant</span>;
    case 'unassessed':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-700 border border-amber-200" title="The photograph did not show enough to judge"><CircleAlert size={12} aria-hidden="true" /> Not assessed</span>;
    case 'unidentified':
      // Not "pending": nothing is running and nothing will, until somebody
      // attaches an instructor. Saying pending would promise a result that
      // never arrives.
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-orange-50 text-orange-700 border border-orange-200" title="Face recognition could not identify this person. An administrator needs to attach the right instructor."><UserRoundSearch size={12} aria-hidden="true" /> Unidentified</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-slate-100 text-slate-600 border border-slate-200"><TriangleAlert size={12} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold whitespace-nowrap bg-amber-50 text-amber-600 border border-amber-200"><Clock size={12} aria-hidden="true" /> Pending AI</span>;
  }
}

/** Formal / Saree / Kurti, classified by the AI independently of pass or fail. */
function AttireTag({ attire }: { attire?: string | null }) {
  const labels: Record<string, { text: string; style: string }> = {
    FORMAL: { text: 'Formal', style: 'bg-sky-50 text-sky-700 border-sky-200' },
    SAREE: { text: 'Saree', style: 'bg-fuchsia-50 text-fuchsia-700 border-fuchsia-200' },
    KURTI_WITH_DUPATTA: { text: 'Kurti + Dupatta', style: 'bg-violet-50 text-violet-700 border-violet-200' },
  };
  const match = attire ? labels[attire] : undefined;
  // UNKNOWN and missing both render as a dash: an unclassified photo must not
  // be presented as though it were one of the three.
  if (!match) return <span className="text-xs text-slate-300">--</span>;
  return (
    <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-bold whitespace-nowrap ${match.style}`}>
      {match.text}
    </span>
  );
}

export default function DailyAttendanceTable({ onRowClick, canBulkDelete = false }: DailyAttendanceTableProps) {
  const today = useMemo(() => localDateValue(), []);
  const toast = useToast();
  const [records, setRecords] = useState<AttendanceRecord[]>([]);
  const [photoTarget, setPhotoTarget] = useState<
    { record: AttendanceRecord; kind: 'checkin' | 'checkout' } | null
  >(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [preset, setPreset] = useState<DatePreset>('today');
  const [range, setRange] = useState<DateRange>(() => rangeForPreset('today'));
  const [roleFilter, setRoleFilter] = useState('');
  const [collegeFilter, setCollegeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const selectAllRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeController: AbortController | null = null;
    let syncCursor: string | null = null;
    let currentRows: AttendanceRecord[] = [];
    const endpoint = attendanceRangePath(range);
    setRecords([]);
    setLoading(true);

    // Poll quickly during analysis and slowly while idle. After the first
    // complete range load, every poll asks only for rows updated since the
    // previous request, so an all-time view does not re-download every page.
    const schedule = (hasPendingWork: boolean) => {
      clearTimeout(timer);
      if (!disposed && document.visibilityState === 'visible') {
        timer = setTimeout(() => run(false), hasPendingWork ? 3_000 : 30_000);
      }
    };

    const run = async (showLoading: boolean) => {
      if (disposed || activeController) return;
      if (document.visibilityState !== 'visible') {
        if (showLoading) setLoading(false);
        return;
      }
      const controller = new AbortController();
      const requestStartedAt = new Date().toISOString();
      activeController = controller;
      if (showLoading) setLoading(true);
      let pendingWork = false;
      try {
        const deltaEndpoint = syncCursor
          ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}updated_since=${encodeURIComponent(syncCursor)}`
          : endpoint;
        const data = await apiFetchAllPages<AttendanceRecord>(deltaEndpoint, {
          pageSize: 1_000,
          signal: controller.signal,
        });
        const rows = Array.isArray(data) ? data : [];
        if (syncCursor) {
          const merged = new Map(currentRows.map((row) => [String(row._id), row]));
          for (const row of rows) merged.set(String(row._id), row);
          currentRows = [...merged.values()].sort((left, right) => (
            new Date(right.check_in_time || right.date || 0).getTime()
            - new Date(left.check_in_time || left.date || 0).getTime()
          ));
        } else {
          currentRows = rows;
        }
        syncCursor = requestStartedAt;
        pendingWork = currentRows.some(
          (row) => normalizeAttendanceStatus(row.status) === 'pending'
            || ['queued', 'processing', 'outbox_pending'].includes(String(row.checkout_evaluation_queue_status || ''))
        );
        if (!disposed) {
          setRecords(currentRows);
          setError('');
        }
      } catch (requestError) {
        if (!disposed && !controller.signal.aborted && (requestError as { status?: number })?.status !== 401) {
          setError(requestError instanceof Error ? requestError.message : String(requestError));
        }
      } finally {
        if (!disposed && showLoading) setLoading(false);
        activeController = null;
        schedule(pendingWork);
      }
    };

    const handleVisibilityChange = () => {
      clearTimeout(timer);
      if (document.visibilityState === 'hidden') {
        activeController?.abort();
      } else if (!activeController) {
        run(true);
      }
    };

    run(true);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      disposed = true;
      clearTimeout(timer);
      activeController?.abort();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [range, reloadVersion]);

  const roles = useMemo(
    () => uniqueRecordValues(records, 'instructor_role', roleFilter),
    [records, roleFilter],
  );
  const colleges = useMemo(
    () => uniqueRecordValues(records, 'college_name', collegeFilter),
    [records, collegeFilter],
  );
  const filteredRecords = useMemo(
    () => filterAttendanceRecords(records, {
      search,
      role: roleFilter,
      college: collegeFilter,
    }),
    [records, search, roleFilter, collegeFilter],
  );
  const visibleIds = useMemo(
    () => filteredRecords.map((record) => String(record._id)),
    [filteredRecords],
  );
  const selectedVisibleCount = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisibleCount === visibleIds.length;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedVisibleCount > 0 && !allVisibleSelected;
    }
  }, [selectedVisibleCount, allVisibleSelected]);

  const openRecord = (record: AttendanceRecord) => {
    if (canOpenRecord(record.status)) onRowClick(record);
  };

  const handleRangeChange = (nextPreset: DatePreset, nextRange: DateRange) => {
    setSelectedIds(new Set());
    setRecords([]);
    setLoading(true);
    setPreset(nextPreset);
    setRange(nextRange);
  };

  const toggleRecord = (attendanceId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(attendanceId)) next.delete(attendanceId);
      else next.add(attendanceId);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const deleteSelectedRecords = async () => {
    const attendanceIds = [...selectedIds];
    if (!attendanceIds.length) return;
    setDeleting(true);
    try {
      const result = await apiJson<BulkDeleteResult>('/api/v2/attendance/bulk-delete', {
        method: 'POST',
        body: { attendance_ids: attendanceIds },
        timeoutMs: 120_000,
      });
      const deletedCount = result.deleted_ids?.length || 0;
      const failedCount = result.failed?.length || 0;
      setSelectedIds(new Set());
      setConfirmBulkDelete(false);
      setReloadVersion((current) => current + 1);
      if (deletedCount) {
        toast.success(`${deletedCount} attendance record${deletedCount === 1 ? '' : 's'} deleted`);
      }
      if (failedCount) {
        toast.error(`${failedCount} record${failedCount === 1 ? '' : 's'} could not be deleted`, {
          detail: 'Refresh and retry those records.',
        });
      }
    } catch (deleteError) {
      toast.error('Could not delete the selected records', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="daily-records-title" aria-busy={loading}>
      {/* One band: the title on the left, the filters on the right. The
          subtitle is gone and the heading no longer wraps, so the filters stay
          on the same line instead of pushing the table down a row. Labels live
          in aria-label, since the controls read clearly without visible ones. */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2 id="daily-records-title" className="flex shrink-0 items-center gap-2 text-xl font-bold text-slate-800">
          <History size={22} className="text-indigo-600" aria-hidden="true" />
          Daily Attendance Records
        </h2>

        <div className="flex flex-1 flex-wrap items-center justify-end gap-2">
          {canBulkDelete && selectedIds.size > 0 && (
            <button
              type="button"
              onClick={() => setConfirmBulkDelete(true)}
              className="flex h-9 items-center gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 text-sm font-semibold text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
            >
              <Trash2 size={16} aria-hidden="true" />
              Delete selected ({selectedIds.size})
            </button>
          )}
          <span className="relative flex-1 min-w-[10rem] sm:flex-none">
            <Search size={16} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search attendance records"
              maxLength={120}
              placeholder="Search name, institute, remarks…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full sm:w-56 rounded-md border border-slate-300 bg-white py-0 pl-8 pr-3 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
            />
          </span>
          <DateRangeFilter
            preset={preset}
            range={range}
            today={today}
            onChange={handleRangeChange}
          />
          <select
            aria-label="Filter by institute"
            value={collegeFilter}
            onChange={(event) => setCollegeFilter(event.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="">All institutes</option>
            {colleges.map((college) => <option key={college} value={college}>{college}</option>)}
          </select>
          <select
            aria-label="Filter by instructor role"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value)}
            className="h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm font-medium text-slate-700 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
          >
            <option value="">All roles</option>
            {roles.map((role) => <option key={role} value={role}>{role}</option>)}
          </select>
        </div>
      </div>

      {error && <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">{error}</div>}

      <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden flex-1 flex flex-col">
        <div className="overflow-x-auto flex-1">
          {/*
            table-fixed with explicit widths, because auto layout was sizing
            columns from their content and wrapping "Vikram Balai" and
            "Aug 17, 2026" onto two and three lines. Every column now gets a
            width that fits one line, and the table scrolls horizontally rather
            than compressing to fit.
          */}
          {/*
            An explicit total width, not w-max. w-max sizes the table to its
            content, which let the Remark column grow to fit a paragraph and
            scroll the row far off screen instead of truncating at 320px.
            1610px is the sum of the column widths below.
          */}
          <table className={`text-left border-collapse table-fixed max-w-none ${canBulkDelete ? 'w-[1828px]' : 'w-[1780px]'}`}>
            <thead className="sticky top-0 bg-slate-50 z-10 shadow-sm">
              <tr className="border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                {canBulkDelete && (
                  <th className="w-12 p-4">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allVisibleSelected}
                      disabled={!visibleIds.length}
                      onChange={toggleAllVisible}
                      aria-label="Select all visible attendance records"
                      className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                  </th>
                )}
                <th className="p-4 w-[200px]">Instructor Name</th>
                <th className="p-4 w-[150px]">Role</th>
                <th className="p-4 w-[160px]">Institute</th>
                <th className="p-4 w-[130px]">Date</th>
                <th className="p-4 w-[110px]">Check-In</th>
                <th className="p-4 w-[110px]">Check-Out</th>
                <th className="p-4 w-[190px]">Coordinates</th>
                <th className="p-4 w-[150px]">Status</th>
                <th className="p-4 w-[170px]">Attire</th>
                <th className="p-4 w-[90px]">Photo</th>
                <th className="p-4 w-[100px]">Report</th>
                <th className="p-4 w-[320px]">Remark</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {loading && records.length === 0 ? (
                <tr><td colSpan={canBulkDelete ? 13 : 12} className="p-8 text-center text-slate-400">Loading attendance records…</td></tr>
              ) : records.length === 0 ? (
                <tr><td colSpan={canBulkDelete ? 13 : 12} className="p-8 text-center text-slate-400">No attendance records found for the selected dates.</td></tr>
              ) : filteredRecords.length === 0 ? (
                <tr><td colSpan={canBulkDelete ? 13 : 12} className="p-8 text-center text-slate-400">No records match the selected filters.</td></tr>
              ) : filteredRecords.map((record) => {
                const canOpen = canOpenRecord(record.status);
                const attendanceId = String(record._id);
                const selected = selectedIds.has(attendanceId);
                return (
                  <tr
                    key={record._id}
                    onClick={() => openRecord(record)}
                    onKeyDown={(event) => {
                      if (canOpen && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        openRecord(record);
                      }
                    }}
                    tabIndex={canOpen ? 0 : undefined}
                    aria-label={canOpen ? `Open evaluation for ${record.instructor_name}` : undefined}
                    className={`transition-colors ${selected ? 'bg-indigo-50/70' : ''} ${canOpen ? 'hover:bg-slate-50 cursor-pointer focus:outline-none focus:ring-2 focus:ring-inset focus:ring-indigo-500' : 'opacity-80'}`}
                  >
                    {canBulkDelete && (
                      <td className="w-12 p-4" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() => toggleRecord(attendanceId)}
                          aria-label={`Select attendance record for ${record.instructor_name || 'instructor'}`}
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                        />
                      </td>
                    )}
                    {/* truncate on every text cell: one line, an ellipsis when
                        it overflows, and the full value in the tooltip. */}
                    <td className="p-4 font-bold text-slate-800 truncate" title={record.instructor_name || ''}>{record.instructor_name}</td>
                    <td className="p-4 text-sm font-medium text-slate-500 truncate" title={record.instructor_role || ''}>{record.instructor_role || '--'}</td>
                    <td className="p-4 text-sm font-medium text-slate-600 truncate" title={record.college_name || ''}>{record.college_name || 'Unknown'}</td>
                    <td className="p-4 text-sm font-medium text-slate-600 whitespace-nowrap">
                      {attendanceSessionDateLabel(record.check_in_time, record.check_out_time, record.date)}
                    </td>
                    <td className="p-4 text-sm font-bold text-slate-700 whitespace-nowrap">{formatAttendanceTime(record.check_in_time)}</td>
                    <td className="p-4 text-sm font-bold text-slate-700 whitespace-nowrap">
                      {checkoutDateTimeLabel(record.check_in_time, record.check_out_time, record.checkout_status)}
                    </td>
                    <td className="p-4 text-sm text-slate-500 truncate">
                      {record.location_coordinates ? (
                        <span className="flex items-center gap-1.5 text-indigo-600 font-medium whitespace-nowrap" title="Latitude, longitude">
                          <MapPin size={14} className="shrink-0" aria-hidden="true" /> {formatCoordinates(record.location_coordinates)}
                        </span>
                      ) : '--'}
                    </td>
                    <td className="p-4 whitespace-nowrap"><StatusBadge status={record.status} /></td>
                    <td className="p-4 whitespace-nowrap"><AttireTag attire={record.attire_type} /></td>
                    <td className="p-4">
                      {/* stopPropagation: the row itself opens the evaluation
                          detail, and viewing a photo should not also do that. */}
                      <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        {record.check_in_photo_key ? (
                          <button
                            type="button"
                            title="View check-in photo"
                            aria-label={`View check-in photo for ${record.instructor_name}`}
                            onClick={() => setPhotoTarget({ record, kind: 'checkin' })}
                            className="rounded-md border border-indigo-100 bg-indigo-50 p-1.5 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                          >
                            <ImageIcon size={15} aria-hidden="true" />
                          </button>
                        ) : (
                          <span className="text-xs text-slate-300">--</span>
                        )}
                        {record.check_out_photo_key && (
                          <button
                            type="button"
                            title="View check-out photo"
                            aria-label={`View check-out photo for ${record.instructor_name}`}
                            onClick={() => setPhotoTarget({ record, kind: 'checkout' })}
                            className="rounded-md border border-rose-100 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
                          >
                            <LogOut size={15} aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="p-4">
                      {/* The public report an instructor is emailed, one link
                          per half. New tab, and the click is kept off the row
                          so it does not also open the internal detail view. */}
                      <div className="flex items-center gap-1.5 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                        {record.report_token ? (
                          <>
                            <a
                              href={publicDayReportPath(record.report_token, localDateValue(new Date(record.date || record.check_in_time || Date.now())), 'checkin')}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open the check-in report"
                              aria-label={`Open the check-in report for ${record.instructor_name}`}
                              className="inline-flex rounded-md border border-indigo-100 bg-indigo-50 p-1.5 text-indigo-700 hover:bg-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                            >
                              <FileText size={15} aria-hidden="true" />
                            </a>
                            {record.check_out_time ? (
                              <a
                                href={publicDayReportPath(record.report_token, localDateValue(new Date(record.date || record.check_in_time || Date.now())), 'checkout')}
                                target="_blank"
                                rel="noopener noreferrer"
                                title="Open the check-out report"
                                aria-label={`Open the check-out report for ${record.instructor_name}`}
                                className="inline-flex rounded-md border border-rose-100 bg-rose-50 p-1.5 text-rose-700 hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500"
                              >
                                <FileText size={15} aria-hidden="true" />
                              </a>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-xs text-slate-300">--</span>
                        )}
                      </div>
                    </td>
                    <td className="p-4 text-sm text-slate-500 truncate" title={record.remarks || ''}>{record.remarks || '--'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {photoTarget && (
        <PhotoViewer
          attendanceId={String(photoTarget.record._id)}
          kind={photoTarget.kind}
          title={photoTarget.record.instructor_name || 'Instructor'}
          subtitle={formatAttendanceTime(
            photoTarget.kind === 'checkin'
              ? photoTarget.record.check_in_time
              : photoTarget.record.check_out_time,
          )}
          onClose={() => setPhotoTarget(null)}
        />
      )}

      <ConfirmDialog
        open={confirmBulkDelete}
        title="Delete selected attendance records?"
        message={`This permanently deletes ${selectedIds.size} selected attendance record${selectedIds.size === 1 ? '' : 's'}.`}
        detail="Their check-ins, check-outs, appearance reports and stored photographs will be removed. This cannot be undone."
        confirmLabel="Delete selected"
        destructive
        busy={deleting}
        onConfirm={() => void deleteSelectedRecords()}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </section>
  );
}
