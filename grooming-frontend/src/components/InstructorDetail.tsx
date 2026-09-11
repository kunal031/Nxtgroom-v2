import { useEffect, useState } from 'react';
import { ArrowLeft, Clock, Calendar, CheckCircle2, XCircle, TriangleAlert, CircleAlert, LogIn, LogOut, RefreshCw, Trash2 } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import ConfirmDialog from './ConfirmDialog';
import PhotoViewer from './PhotoViewer';
import AttendancePhotoCircle from './AttendancePhotoCircle';
import { useToast } from './useToast';
import { normalizeAttendanceStatus } from '../status';
import { formatAttendanceDate, formatAttendanceTime } from '../attendanceFilters';
import GroomingReport from './GroomingReport';
import LocationPanel from './LocationPanel';
import type { AttendanceRecord, Evaluation } from '../types';
import {
  aiRemarksForHalf,
  beginReportLoad,
  evaluationForHalf,
  reportPanelStateForHalf,
  type ReportHalf,
  type ReportPanelStates,
} from '../reportSelection';

interface ReportStatusPayload {
  attendance_id: string;
  status: string;
  compliance_status: string | null;
  remarks: string | null;
  queue_status: string | null;
  settled: boolean;
}

function reportQuery(half: ReportHalf): string {
  return half === 'checkout' ? '?kind=checkout' : '';
}

async function fetchStoredEvaluation(
  attendanceId: string,
  half: ReportHalf,
  signal: AbortSignal,
): Promise<Evaluation | null> {
  try {
    return await apiFetch<Evaluation | null>(
      `/api/v2/attendance/${encodeURIComponent(attendanceId)}/evaluation${reportQuery(half)}`,
      { signal },
    );
  } catch (requestError) {
    // Older API deployments returned 404 while an evaluation was absent.
    if ((requestError as { status?: number })?.status === 404) return null;
    throw requestError;
  }
}

function applyReportStatus(
  record: AttendanceRecord | null,
  attendanceId: string,
  half: ReportHalf,
  status: ReportStatusPayload,
): AttendanceRecord | null {
  if (!record || String(record._id) !== attendanceId) return record;
  if (half === 'checkout') {
    return {
      ...record,
      checkout_compliance_status: status.compliance_status || status.status,
      checkout_remarks: status.remarks,
      checkout_evaluation_queue_status: status.queue_status,
    };
  }
  return {
    ...record,
    status: status.status,
    remarks: status.remarks,
    evaluation_queue_status: status.queue_status,
  };
}

interface InstructorDetailProps {
  record: AttendanceRecord | null;
  onBack: () => void;
  /** Hidden entirely when the signed-in user may not delete the record. */
  canDelete?: boolean;
  /** Removing a check-out alone is a lesser permission, granted separately. */
  canDeleteCheckout?: boolean;
  /** Workspace-wide switch for offering re-analysis on a report. */
  canReanalyse?: boolean;
  /** Called after the record is gone, so the list behind can drop it. */
  onDeleted?: (attendanceId: string) => void;
}

function StatusBadge({ status }: { status?: string }) {
  switch (normalizeAttendanceStatus(status)) {
    case 'compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-emerald-50 text-emerald-600 border border-emerald-200"><CheckCircle2 size={16} aria-hidden="true" /> Compliant</span>;
    case 'non_compliant':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-rose-50 text-rose-600 border border-rose-200"><XCircle size={16} aria-hidden="true" /> Non-compliant</span>;
    case 'unassessed':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-amber-50 text-amber-700 border border-amber-200"><CircleAlert size={16} aria-hidden="true" /> Not assessed</span>;
    case 'unidentified':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-orange-50 text-orange-700 border border-orange-200"><CircleAlert size={16} aria-hidden="true" /> Unidentified</span>;
    case 'error':
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-slate-100 text-slate-600 border border-slate-200"><TriangleAlert size={16} aria-hidden="true" /> Analysis error</span>;
    default:
      return <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-sm font-bold bg-amber-50 text-amber-600 border border-amber-200"><Clock size={16} aria-hidden="true" /> Pending AI</span>;
  }
}

export default function InstructorDetail({ record, onBack, canDelete, canDeleteCheckout, canReanalyse = false, onDeleted }: InstructorDetailProps) {
  const [freshRecord, setFreshRecord] = useState<AttendanceRecord | null>(record);
  const [reportStates, setReportStates] = useState<ReportPanelStates>({});
  const [photoKind, setPhotoKind] = useState<'checkin' | 'checkout' | null>(null);
  // Check-in opens first: it is the half that carries the appearance report,
  // and on most records the only half that has happened yet.
  const [tab, setTab] = useState<'checkin' | 'checkout'>('checkin');
  // Which delete is being confirmed. The two remove different things, so they
  // cannot share one dialog.
  const [confirmDelete, setConfirmDelete] = useState<'record' | 'checkout' | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [reanalysing, setReanalysing] = useState(false);
  const [queuedHalf, setQueuedHalf] = useState<ReportHalf | null>(null);
  const toast = useToast();
  const displayRecord = freshRecord || record;
  const attendanceId = record ? String(record._id) : null;
  // Each half keeps its own snapshot. A snapshot belonging to another record
  // is ignored, so navigating between records can never leak stale details.
  const reportState = reportPanelStateForHalf(reportStates, attendanceId, tab);
  const evaluation = evaluationForHalf(reportState, attendanceId, tab);
  const loading = !reportState || reportState.loading;
  const error = reportState?.error || '';

  useEffect(() => {
    setFreshRecord(record);
  }, [record]);

  // Distinguishes "still working on it" from "there is nothing". The queue
  // status is written when the job is created and cleared when it completes.
  const queueStatus = tab === 'checkout'
    ? displayRecord?.checkout_evaluation_queue_status
    : displayRecord?.evaluation_queue_status;
  // "failed" is a terminal state, not a slow one. Treating it as running left
  // the page showing "analysing" indefinitely for work that had already given
  // up, which is the least useful thing it could say.
  const analysisFailed = queueStatus === 'failed';
  const analysisRunning = !analysisFailed && !evaluation
    && (queuedHalf === tab
      || reportState?.settled === false
      || queueStatus === 'queued'
      || queueStatus === 'processing');
  const shouldPoll = queuedHalf === tab || reportState?.settled === false;
  // Only worth offering when the photograph it would read is still there.
  const halfHasPhoto = Boolean(tab === 'checkout' ? displayRecord?.check_out_photo_key : displayRecord?.check_in_photo_key);
  // Two independent conditions: the workspace has to allow re-analysis at all,
  // and this half must still have the photograph it would read.
  const reanalyseOffered = canReanalyse && halfHasPhoto;

  const handleReanalyse = async () => {
    if (!record) return;
    setReanalysing(true);
    try {
      const query = reportQuery(tab);
      await apiJson(
        `/api/v2/attendance/${encodeURIComponent(String(record._id))}/reanalyse${query}`,
        { method: 'POST', timeoutMs: tab === 'checkout' ? 150_000 : undefined },
      );
      if (tab === 'checkout') {
        const updated = await apiFetch<Evaluation>(
          `/api/v2/attendance/${encodeURIComponent(String(record._id))}/evaluation?kind=checkout`,
        );
        setReportStates((current) => ({
          ...current,
          checkout: {
            attendanceId: String(record._id),
            half: 'checkout',
            evaluation: updated || null,
            loading: false,
            error: '',
            settled: true,
          },
        }));
        setQueuedHalf(null);
        toast.success('Analysis completed', { detail: 'The checkout report has been updated.' });
      } else {
        toast.success('Analysis queued', { detail: 'The report appears here once it finishes.' });
        // Shows the spinner immediately rather than waiting for the next poll.
        setQueuedHalf('checkin');
      }
    } catch (error) {
      toast.error(tab === 'checkout' ? 'Could not complete the analysis' : 'Could not queue the analysis', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setReanalysing(false);
    }
  };

  const handleDelete = async () => {
    if (!record) return;
    setDeleting(true);
    try {
      await apiJson(`/api/v2/attendance/${encodeURIComponent(String(record._id))}`, {
        method: 'DELETE',
      });
      toast.success('Attendance record deleted', {
        detail: `${record.instructor_name || 'The record'} and its photos have been removed.`,
      });
      setConfirmDelete(null);
      // Back to the list, which no longer contains this record: staying here
      // would leave the page describing something that no longer exists.
      onDeleted?.(String(record._id));
      onBack();
    } catch (deleteError) {
      toast.error('Could not delete the record', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      setDeleting(false);
    }
  };

  /**
   * Removes only the check-out. The check-in and its report stay, and the
   * instructor goes back to being checked in, so this is not a smaller version
   * of deleting the record — it is a different act.
   */
  const handleDeleteCheckout = async () => {
    if (!record) return;
    setDeleting(true);
    try {
      await apiJson(`/api/v2/attendance/${encodeURIComponent(String(record._id))}/check-out`, {
        method: 'DELETE',
      });
      toast.success('Check-out deleted', {
        detail: 'The check-in and its report are unchanged.',
      });
      setConfirmDelete(null);
      onDeleted?.(String(record._id));
      onBack();
    } catch (deleteError) {
      toast.error('Could not delete the check-out', {
        detail: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
      setDeleting(false);
    }
  };

  // Load only when the attendance id or selected half actually changes. A
  // replacement record object from a parent refresh must not restart this
  // request or clear a report that has already rendered.
  useEffect(() => {
    if (!attendanceId) return undefined;
    const controller = new AbortController();
    setReportStates((current) => beginReportLoad(current, attendanceId, tab));

    const load = async () => {
      try {
        const [status, storedEvaluation] = await Promise.all([
          apiFetch<ReportStatusPayload>(
            `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status${reportQuery(tab)}`,
            { signal: controller.signal },
          ),
          fetchStoredEvaluation(attendanceId, tab, controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setFreshRecord((current) => applyReportStatus(current, attendanceId, tab, status));
        setReportStates((current) => ({
          ...current,
          [tab]: {
            attendanceId,
            half: tab,
            evaluation: storedEvaluation,
            loading: false,
            error: '',
            settled: status.settled,
          },
        }));
        if (status.settled) {
          setQueuedHalf((current) => (current === tab ? null : current));
        }
      } catch (requestError) {
        if (controller.signal.aborted) return;
        const status = (requestError as { status?: number })?.status;
        if (status === 401) return;
        setReportStates((current) => {
          const cached = reportPanelStateForHalf(current, attendanceId, tab);
          // A failed background refresh is not allowed to replace a report
          // the user can already read with a transient error panel.
          if (cached && !cached.loading) return current;
          return {
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: null,
              loading: false,
              error: requestError instanceof Error ? requestError.message : String(requestError),
              settled: null,
            },
          };
        });
      }
    };

    void load();
    return () => controller.abort();
  }, [attendanceId, tab]);

  // Once the initial request says analysis is outstanding, poll only the
  // lightweight status endpoint. The full evaluation is fetched exactly once
  // after the job settles, and polling never touches the visible loader.
  useEffect(() => {
    if (!attendanceId || !shouldPoll) return undefined;
    const controller = new AbortController();
    let timer: ReturnType<typeof window.setTimeout> | undefined;

    const poll = async () => {
      try {
        const status = await apiFetch<ReportStatusPayload>(
          `/api/v2/attendance/${encodeURIComponent(attendanceId)}/status${reportQuery(tab)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        setFreshRecord((current) => applyReportStatus(current, attendanceId, tab, status));

        if (status.settled) {
          const storedEvaluation = await fetchStoredEvaluation(attendanceId, tab, controller.signal);
          if (controller.signal.aborted) return;
          setReportStates((current) => ({
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: storedEvaluation,
              loading: false,
              error: '',
              settled: true,
            },
          }));
          setQueuedHalf((current) => (current === tab ? null : current));
          return;
        }

        setReportStates((current) => {
          const existing = reportPanelStateForHalf(current, attendanceId, tab);
          return {
            ...current,
            [tab]: {
              attendanceId,
              half: tab,
              evaluation: existing?.evaluation || null,
              loading: false,
              error: '',
              settled: false,
            },
          };
        });
      } catch {
        // A transient polling failure should neither blank the report nor stop
        // later attempts. Authentication expiry is handled centrally.
      }

      if (!controller.signal.aborted) timer = window.setTimeout(poll, 3000);
    };

    timer = window.setTimeout(poll, 3000);
    return () => {
      controller.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [attendanceId, shouldPoll, tab]);

  if (!record) {
    return (
      <div className="rounded-md border border-slate-200 bg-white p-8 text-center">
        <p className="text-sm text-slate-500">Choose a completed attendance record to view its report.</p>
        <button type="button" onClick={onBack} className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Back to records</button>
      </div>
    );
  }

  return (
    <section className="w-full flex flex-col h-full animate-in fade-in slide-in-from-right-4 duration-300" aria-labelledby="instructor-detail-title">
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 mb-6 shrink-0">
        <button type="button" aria-label="Back to daily records" onClick={onBack} className="p-2 bg-white border border-slate-200 rounded-md hover:bg-slate-50 text-slate-600 transition-colors shadow-sm">
          <ArrowLeft size={20} aria-hidden="true" />
        </button>
        <h2 id="instructor-detail-title" className="text-xl sm:text-2xl font-extrabold text-slate-800">Instructor Detail View</h2>

        {/* Acts on the record as a whole, so it sits with the title rather
            than inside the profile card, which describes the person. */}
        {/* One button per half, because they remove different things. The
            check-out button appears only on its own tab and only when there is
            a check-out to remove. */}
        <div className="ml-auto flex items-center gap-2">
          {tab === 'checkout' && canDeleteCheckout && record.check_out_time && (
            <button
              type="button"
              onClick={() => setConfirmDelete('checkout')}
              title="Delete only the check-out"
              className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs font-bold text-amber-700 transition-colors hover:bg-amber-100"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="hidden sm:inline">Delete check-out</span>
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              onClick={() => setConfirmDelete('record')}
              title="Delete the whole attendance record"
              className="inline-flex items-center gap-1.5 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-bold text-rose-700 transition-colors hover:bg-rose-100"
            >
              <Trash2 size={14} aria-hidden="true" />
              <span className="hidden sm:inline">
                {tab === 'checkin' ? 'Delete check-in' : 'Delete record'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* One record, two halves. Switching swaps the photo, the time and the
          location together, so what is on screen always describes the same
          moment rather than mixing the two. */}
      <div role="tablist" aria-label="Attendance report" className="mb-4 flex shrink-0 gap-1 rounded-md border border-slate-200 bg-white p-1 sm:w-fit">
        {([
          { key: 'checkin', label: 'Check-in report', Icon: LogIn },
          { key: 'checkout', label: 'Check-out report', Icon: LogOut },
        ] as const).map(({ key, label, Icon }) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-2 text-xs sm:text-sm font-bold transition-colors sm:flex-none ${
              tab === key
                ? 'bg-indigo-600 text-white shadow-sm'
                : 'text-slate-600 hover:bg-slate-50'
            }`}
          >
            <Icon size={15} aria-hidden="true" />
            {label}
          </button>
        ))}
      </div>

      {/* Nothing about a check-out that has not happened is worth laying out.
          Splitting it across a status badge from the other half, an empty
          time, an empty location and an empty summary made the page look
          broken rather than pending, so it says the one true thing instead. */}
      {tab === 'checkout' && !record.check_out_time ? (
        <div className="flex flex-1 min-h-0 items-start justify-center overflow-y-auto lg:items-center">
          <div className="w-full max-w-lg rounded-md border border-dashed border-slate-300 bg-white p-6 sm:p-10 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-amber-50 text-amber-500">
              <LogOut size={26} aria-hidden="true" />
            </div>
            <h3 className="text-base sm:text-lg font-extrabold text-slate-800">No check-out recorded</h3>
            <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-slate-500">
              {record.instructor_name || 'This instructor'} checked in at {formatAttendanceTime(record.check_in_time)} on{' '}
              {formatAttendanceDate(record.date)} and has not checked out. Please follow up with them.
            </p>
            <p className="mt-4 text-xs font-medium text-slate-400">
              The check-out time, location and photo appear here once they do.
            </p>
            <button
              type="button"
              onClick={() => setTab('checkin')}
              className="mt-5 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-100"
            >
              <LogIn size={15} aria-hidden="true" />
              View the check-in report
            </button>
          </div>
        </div>
      ) : (
      <div className="flex flex-col lg:flex-row gap-6 flex-1 min-h-0 lg:overflow-hidden">
        {/* pr-2 only once the column can scroll on its own; below lg the page
            scrolls as one and an inner scrollbar would trap the content. */}
        <div className="w-full lg:w-1/3 flex flex-col gap-4 sm:gap-6 lg:overflow-y-auto lg:pb-6 lg:pr-2">
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-8 flex flex-col items-center text-center shrink-0">
            <AttendancePhotoCircle
              attendanceId={String(record._id)}
              kind={tab}
              hasPhoto={Boolean(tab === 'checkin' ? record.check_in_photo_key : record.check_out_photo_key)}
              label={tab === 'checkin' ? 'Check-in' : 'Check-out'}
              onOpen={() => setPhotoKind(tab)}
            />
            <h3 className="mt-4 text-xl sm:text-2xl font-extrabold text-slate-800">{record.instructor_name}</h3>
            <p className="text-xs sm:text-sm font-bold text-slate-400 uppercase tracking-widest mt-1.5 mb-4 sm:mb-5">{record.instructor_role}</p>
            {/* Each tab shows its own verdict. This read the check-in's on
                both, so a check-out could be labelled with the morning's
                result — or with "Not assessed" when only the check-in was. */}
            <StatusBadge
              status={tab === 'checkout'
                ? (evaluation?.overall_status
                  || displayRecord?.checkout_compliance_status
                  || (displayRecord?.check_out_photo_key ? 'pending' : undefined))
                : (evaluation?.overall_status || displayRecord?.status)}
            />
            {tab === 'checkout' && !record.check_out_photo_key && (
              <p className="mt-4 text-xs font-medium text-slate-400">No photo was taken at check-out.</p>
            )}
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 space-y-5 shrink-0">
            <h4 className="text-sm font-bold text-slate-800 border-b border-slate-100 pb-3">Session Details</h4>
            <div className="flex items-start gap-4"><div className="bg-slate-50 p-2 rounded-md text-slate-400"><Calendar size={18} aria-hidden="true" /></div><div><p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">Date</p><p className="text-sm font-semibold text-slate-700">{formatAttendanceDate(tab === 'checkout' ? record.check_out_time : (record.check_in_time || record.date))}</p></div></div>
            {/* Only this tab's half. Showing the other one's time here put an
                empty check-out row on a report about the check-in. */}
            <div className="flex items-start gap-4">
              <div className="bg-indigo-50 text-indigo-600 p-2 rounded-md"><Clock size={18} aria-hidden="true" /></div>
              <div>
                <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                  {tab === 'checkin' ? 'Check-in time' : 'Check-out time'}
                </p>
                <p className="text-sm font-semibold text-slate-800">
                  {formatAttendanceTime(tab === 'checkin' ? record.check_in_time : record.check_out_time)}
                </p>
              </div>
            </div>
            <div>
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">
                {tab === 'checkin' ? 'Check-in location' : 'Check-out location'}
              </p>
              {tab === 'checkout' && !record.check_out_coordinates ? (
                <p className="rounded-md border border-dashed border-slate-200 bg-slate-50 p-3 text-xs font-medium text-slate-400">
                  No location was captured at check-out.
                </p>
              ) : (
                <LocationPanel
                  coordinates={tab === 'checkin' ? record.location_coordinates : record.check_out_coordinates}
                  address={tab === 'checkin' ? record.location_address : record.check_out_location_address}
                  accuracyMetres={tab === 'checkin' ? record.location_accuracy_m : displayRecord?.check_out_location_accuracy_m}
                />
              )}
            </div>
          </div>

          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-6 shrink-0">
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 mb-4">
              <h4 className="text-sm font-bold text-slate-800">AI Remarks Summary</h4>
              {/* Plain text and icon rather than a filled button: this sits
                  beside a heading and re-reads the half currently on screen,
                  so it should not compete with the report itself. */}
              {reanalyseOffered && (
                <button
                  type="button"
                  onClick={() => void handleReanalyse()}
                  disabled={reanalysing}
                  aria-label={`Re-analyse the ${tab === 'checkout' ? 'check-out' : 'check-in'} photo`}
                  className="inline-flex shrink-0 items-center gap-1.5 text-xs font-bold text-indigo-600 transition-colors hover:text-indigo-800 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RefreshCw size={13} className={reanalysing ? 'animate-spin' : ''} aria-hidden="true" />
                  {reanalysing ? (tab === 'checkout' ? 'Analysing…' : 'Queueing…') : 'Re-analyse'}
                </button>
              )}
            </div>
            <p className="text-sm text-slate-600 leading-relaxed bg-slate-50 p-4 rounded-md border border-slate-100">
              {aiRemarksForHalf(tab, displayRecord, evaluation) || 'No remarks available.'}
            </p>
            <p className="mt-3 text-xs text-slate-400">AI output is assistive and should be reviewed by an authorized person before adverse action.</p>
          </div>
        </div>

        <div className="w-full lg:w-2/3 bg-white rounded-md shadow-sm border border-slate-200 p-5 sm:p-8 lg:overflow-y-auto flex flex-col mb-4 lg:mb-6">
          <h3 className="text-base sm:text-lg font-extrabold text-slate-800 mb-4 sm:mb-6 border-b border-slate-100 pb-3 sm:pb-4">
            Detailed Appearance Report
          </h3>
          {/* Both halves are assessed the same way, so both render the same
              report. The check-out one only exists when a photo was taken. */}
          {loading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-slate-400 gap-4" role="status"><div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" /><p className="text-sm font-medium">Fetching detailed evaluation…</p></div>
          ) : error ? (
            <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">{error}</div>
          ) : !evaluation ? (
            /* Three different situations, which all used to read as one red
               error: nothing was submitted to analyse, the analysis is still
               running, or it finished without producing a report. */
            <div className="flex-1 flex flex-col items-center justify-center text-slate-500 font-medium bg-slate-50 rounded-md border border-dashed border-slate-200 p-8 text-center gap-2">
              {tab === 'checkout' && !record.check_out_photo_key ? (
                <>
                  <XCircle size={32} className="text-slate-300" aria-hidden="true" />
                  <p>No photo was taken at check-out, so there was nothing to assess.</p>
                </>
              ) : analysisRunning ? (
                <>
                  <div className="w-8 h-8 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin" aria-hidden="true" />
                  <p>Analysing the photo. This usually takes a few seconds.</p>
                  <p className="text-xs font-normal text-slate-400">
                    The report appears here once it finishes.
                  </p>
                </>
              ) : (
                <>
                  <XCircle size={32} className="text-slate-300" aria-hidden="true" />
                  <p>
                    {analysisFailed
                      ? `The analysis of this ${tab === 'checkout' ? 'check-out' : 'check-in'} photo did not complete.`
                      : `No appearance report was produced for this ${tab === 'checkout' ? 'check-out' : 'check-in'}.`}
                  </p>
                  {/* The photograph is still in storage, so the analysis can
                      simply be run again. Without this a record left without a
                      report could only be fixed by checking in afresh. */}
                  {reanalyseOffered && (
                    <button
                      type="button"
                      onClick={() => void handleReanalyse()}
                      disabled={reanalysing}
                      className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-bold text-indigo-700 transition-colors hover:bg-indigo-100 disabled:opacity-50"
                    >
                      <RefreshCw size={15} className={reanalysing ? 'animate-spin' : ''} aria-hidden="true" />
                      {reanalysing ? (tab === 'checkout' ? 'Analysing…' : 'Queueing…') : 'Analyse this photo'}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="flex-1 pb-4">
              {/* The verdict stands whatever the photo was like. This only
                  asks for a better one next time, so the checkpoints that
                  could not be seen can be. */}
              {evaluation.image_quality === 'RETAKE_RECOMMENDED' && (
                <div role="note" className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-4 text-amber-900">
                  <div className="flex items-start gap-3">
                    <CircleAlert size={20} className="mt-0.5 shrink-0" aria-hidden="true" />
                    <div>
                      <h4 className="text-sm font-extrabold">Retake recommended</h4>
                      <p className="mt-1 text-sm leading-relaxed">
                        The framing, lighting or resolution prevented some checkpoints from being
                        assessed. A clearer full-body photo next time will cover them.
                      </p>
                    </div>
                  </div>
                </div>
              )}
              <GroomingReport evaluation={evaluation} />
            </div>
          )}
        </div>
      </div>
      )}

      {photoKind && record && (
        <PhotoViewer
          attendanceId={String(record._id)}
          kind={photoKind}
          title={record.instructor_name || 'Attendance photo'}
          subtitle={`${photoKind === 'checkin' ? 'Check-in' : 'Check-out'} · ${formatAttendanceDate(photoKind === 'checkout' ? record.check_out_time : (record.check_in_time || record.date))}`}
          onClose={() => setPhotoKind(null)}
        />
      )}

      <ConfirmDialog
        open={confirmDelete === 'record'}
        destructive
        busy={deleting}
        title="Delete this attendance record?"
        message={`This removes the check-in for ${record?.instructor_name || 'this instructor'} on ${formatAttendanceDate(record?.date)}.`}
        detail="A record cannot exist without its check-in, so the check-out, both appearance reports and both photographs go with it. This cannot be undone."
        confirmLabel="Delete record"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(null)}
      />

      <ConfirmDialog
        open={confirmDelete === 'checkout'}
        destructive
        busy={deleting}
        title="Delete this check-out?"
        message={`This removes the check-out for ${record?.instructor_name || 'this instructor'} on ${formatAttendanceDate(record?.check_out_time || record?.date)}.`}
        detail="Its time, photograph and appearance report are deleted. The check-in and its report are untouched, and the instructor will be checked in again."
        confirmLabel="Delete check-out"
        onConfirm={handleDeleteCheckout}
        onCancel={() => setConfirmDelete(null)}
      />
    </section>
  );
}
