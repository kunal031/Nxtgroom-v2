import { useCallback, useEffect, useState } from 'react';
import { Image as ImageIcon, MapPin, RefreshCw, Trash2, UserRoundSearch } from 'lucide-react';
import { apiFetch, apiFetchAllPages, apiJson, invalidateCache } from '../api';
import ConfirmDialog from './ConfirmDialog';
import InstructorSearchSelect from './InstructorSearchSelect';
import PhotoViewer from './PhotoViewer';
import { useToast } from './useToast';
import { formatCoordinates } from '../status';
import type { AttendanceRecord, Instructor } from '../types';

const QUEUE_PATH = '/api/v2/attendance/unidentified';
const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';

/** A later recognised check-in that may explain this unidentified one. */
interface RetryCandidate {
  attendance_id: string;
  instructor_id: string;
  instructor_name: string | null;
  check_in_time: string;
  minutes_later: number;
}

interface QueueRecord extends AttendanceRecord {
  failure_reason: string | null;
  failure_explanation: string;
  retry_candidates: RetryCandidate[];
}

interface QueueResponse {
  total: number;
  limit: number;
  offset: number;
  records: QueueRecord[];
}

/** What the admin chose to do with the photograph as a face reference. */
type FaceMode = 'add' | 'replace' | 'none';

function timeLabel(value?: string | null): string {
  if (!value) return '--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--';
  return new Intl.DateTimeFormat('en-IN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Kolkata',
  }).format(parsed);
}

/**
 * Check-ins whose face was not recognised, waiting to be named.
 *
 * Each row is somebody who turned up and was photographed, so the default action
 * is to name them rather than to discard. Discarding exists because a wall, a
 * passer-by or a test shot also reaches this queue, and clearing those is
 * ordinary work.
 *
 * The retry suggestion is shown prominently when present: most of what lands
 * here is the failed attempt immediately before a successful retake, and in that
 * case the attendance is already recorded correctly and naming this row would
 * create a duplicate.
 */
export default function UnidentifiedQueue() {
  const [records, setRecords] = useState<QueueRecord[]>([]);
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [faceModes, setFaceModes] = useState<Record<string, FaceMode>>({});
  const [analyseNow, setAnalyseNow] = useState<Record<string, boolean>>({});
  const [photoFor, setPhotoFor] = useState<QueueRecord | null>(null);
  const [discardTarget, setDiscardTarget] = useState<QueueRecord | null>(null);
  const toast = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [queue, roster] = await Promise.all([
        apiFetch<QueueResponse>(QUEUE_PATH, { signal }),
        // The picker searches the whole roster, so it is fetched once here
        // rather than per row.
        apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, { pageSize: 1_000, cacheMs: 15_000, signal }),
      ]);
      if (signal?.aborted) return;
      setRecords(Array.isArray(queue?.records) ? queue.records : []);
      setTotal(Number(queue?.total) || 0);
      setInstructors(Array.isArray(roster) ? roster : []);
      setError('');
    } catch (requestError) {
      if (signal?.aborted) return;
      const status = (requestError as { status?: number })?.status;
      if (status === 401) return;
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Names one record.
   *
   * `force` is passed only after the administrator has seen the already-checked-in
   * warning and chosen to continue, so the server's refusal is never bypassed
   * silently.
   */
  const identify = async (record: QueueRecord, { force = false } = {}) => {
    const instructorId = selection[record._id];
    if (!instructorId) {
      setError('Choose an instructor first.');
      return;
    }
    setBusyId(record._id);
    setError('');
    try {
      const result = await apiJson<{ message: string; analysis_queued: boolean; gender_missing?: boolean }>(
        `/api/v2/attendance/${encodeURIComponent(record._id)}/identify`,
        {
          method: 'POST',
          body: {
            instructor_id: instructorId,
            face_mode: faceModes[record._id] ?? 'add',
            analyse: Boolean(analyseNow[record._id]),
            ...(force ? { force: true } : {}),
          },
          timeoutMs: 60_000,
        },
      );
      // The roster's face counts and the records list both change.
      invalidateCache(INSTRUCTORS_PATH);
      invalidateCache('/api/v2/attendance');
      setRecords((current) => current.filter((row) => row._id !== record._id));
      setTotal((current) => Math.max(0, current - 1));
      toast.success(result.message, {
        detail: result.analysis_queued
          ? 'Grooming analysis queued.'
          : result.gender_missing
            ? 'No gender on record, so analysis was not offered.'
            : undefined,
      });
    } catch (requestError) {
      const status = (requestError as { status?: number })?.status;
      if (status === 401) return;
      const details = (requestError as { details?: Record<string, unknown> })?.details;
      const message = requestError instanceof Error ? requestError.message : String(requestError);

      // 409 with this outcome is the warning, not a failure: the instructor
      // already has a record today, which usually means this row is the failed
      // attempt just before their successful retake.
      if (status === 409 && details?.outcome === 'INSTRUCTOR_ALREADY_CHECKED_IN') {
        const proceed = window.confirm(`${message}\n\nRecord this check-in anyway?`);
        if (proceed) {
          setBusyId(null);
          await identify(record, { force: true });
          return;
        }
        setError(message);
        return;
      }
      setError(message);
      toast.error('Could not assign this check-in', { detail: message });
    } finally {
      setBusyId(null);
    }
  };

  const discard = async (record: QueueRecord) => {
    setBusyId(record._id);
    try {
      await apiFetch(`/api/v2/attendance/${encodeURIComponent(record._id)}/unidentified`, {
        method: 'DELETE',
      });
      setRecords((current) => current.filter((row) => row._id !== record._id));
      setTotal((current) => Math.max(0, current - 1));
      setDiscardTarget(null);
      toast.success('Unidentified check-in discarded');
    } catch (requestError) {
      if ((requestError as { status?: number })?.status === 401) return;
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not discard this check-in', { detail: message });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="w-full flex flex-col h-full animate-in fade-in duration-300">
      <div className="flex justify-between items-center mb-6 shrink-0 gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-extrabold text-slate-800 flex items-center gap-2">
            <UserRoundSearch size={24} className="text-indigo-600" aria-hidden="true" />
            Unidentified Check-ins
            {total > 0 && (
              <span className="inline-flex px-2.5 py-1 bg-orange-50 text-orange-700 font-bold text-xs rounded-md border border-orange-200">
                {total}
              </span>
            )}
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Face recognition could not identify these people. Naming one records it as their
            check-in and enrolls the photo so they are recognised next time.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading || busyId !== null}
          className="px-4 py-2.5 rounded-md font-bold text-sm flex items-center gap-2 text-slate-600 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} aria-hidden="true" />
          Refresh
        </button>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto space-y-4">
        {loading ? (
          <p className="p-8 text-center text-slate-400 font-medium">Loading queue…</p>
        ) : records.length === 0 ? (
          <div className="bg-white rounded-md shadow-sm border border-slate-200 p-10 text-center">
            <UserRoundSearch size={32} className="mx-auto text-slate-300 mb-3" aria-hidden="true" />
            <p className="font-bold text-slate-700">Nothing waiting</p>
            <p className="text-sm text-slate-500 mt-1">
              Every check-in has been matched to an instructor.
            </p>
          </div>
        ) : (
          records.map((record) => {
            const busy = busyId === record._id;
            const mode = faceModes[record._id] ?? 'add';
            const suggestion = record.retry_candidates[0];
            return (
              <div key={record._id} className="bg-white rounded-md shadow-sm border border-slate-200 p-5">
                <div className="flex flex-wrap gap-5">
                  <div className="shrink-0">
                    <button
                      type="button"
                      onClick={() => setPhotoFor(record)}
                      className="h-28 w-28 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-400 hover:bg-slate-100 transition-colors"
                      aria-label="View the check-in photo"
                    >
                      <ImageIcon size={28} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPhotoFor(record)}
                      className="mt-2 w-28 text-xs font-bold text-indigo-700 hover:underline"
                    >
                      View photo
                    </button>
                  </div>

                  <div className="flex-1 min-w-[16rem] space-y-3">
                    <div>
                      <p className="text-sm font-bold text-slate-800">{timeLabel(record.check_in_time)}</p>
                      <p className="text-xs text-slate-500 mt-0.5 flex items-center gap-1.5">
                        <MapPin size={12} className="shrink-0" aria-hidden="true" />
                        {record.location_address || formatCoordinates(record.location_coordinates)}
                      </p>
                      <p className="text-xs font-medium text-orange-700 bg-orange-50 border border-orange-200 rounded-md p-2 mt-2">
                        {record.failure_explanation}
                      </p>
                    </div>

                    {/* Shown before the picker: when a retake already recorded
                        this arrival, naming this row would create a duplicate,
                        and discarding is the correct action. */}
                    {suggestion && (
                      <div className="text-xs bg-sky-50 border border-sky-200 rounded-md p-2.5 text-sky-900">
                        <span className="font-bold">Possibly already resolved.</span>{' '}
                        {suggestion.instructor_name || 'An instructor'} was recognised and checked in{' '}
                        {suggestion.minutes_later} minute{suggestion.minutes_later === 1 ? '' : 's'} later,
                        so this is probably the failed attempt just before it.
                      </div>
                    )}

                    <div>
                      <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1.5">
                        Who is this?
                      </label>
                      <InstructorSearchSelect
                        instructors={instructors}
                        selectedId={selection[record._id] || ''}
                        onSelect={(id) => setSelection((current) => ({ ...current, [record._id]: id }))}
                        disabled={busy}
                      />
                    </div>

                    <div className="flex flex-wrap items-center gap-4">
                      <div className="flex items-center gap-2">
                        <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                          Face reference
                        </span>
                        {([
                          ['add', 'Add'],
                          ['replace', 'Replace'],
                          ['none', 'Skip'],
                        ] as [FaceMode, string][]).map(([value, label]) => (
                          <button
                            key={value}
                            type="button"
                            onClick={() => setFaceModes((current) => ({ ...current, [record._id]: value }))}
                            aria-pressed={mode === value}
                            disabled={busy}
                            className={`px-2.5 py-1 rounded-md text-xs font-bold border transition-colors disabled:opacity-50 ${
                              mode === value
                                ? 'bg-indigo-600 text-white border-indigo-600'
                                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>

                      <label className="flex items-center gap-2 text-xs font-medium text-slate-600">
                        <input
                          type="checkbox"
                          checked={Boolean(analyseNow[record._id])}
                          onChange={(event) => setAnalyseNow((current) => ({
                            ...current,
                            [record._id]: event.target.checked,
                          }))}
                          disabled={busy}
                          className="rounded border-slate-300"
                        />
                        Analyse grooming now
                      </label>
                    </div>

                    <div className="flex flex-wrap gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => void identify(record)}
                        disabled={busy || !selection[record._id]}
                        className="px-4 py-2 rounded-md font-bold text-sm text-white bg-indigo-600 hover:bg-indigo-700 transition-colors shadow-sm disabled:opacity-50"
                      >
                        {busy ? 'Saving…' : 'Assign instructor'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscardTarget(record)}
                        disabled={busy}
                        className="px-4 py-2 rounded-md font-bold text-sm text-rose-700 bg-rose-50 border border-rose-100 hover:bg-rose-100 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                      >
                        <Trash2 size={14} aria-hidden="true" />
                        Discard
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {photoFor && (
        <PhotoViewer
          attendanceId={photoFor._id}
          kind="checkin"
          title="Unidentified check-in"
          subtitle={timeLabel(photoFor.check_in_time)}
          onClose={() => setPhotoFor(null)}
        />
      )}

      <ConfirmDialog
        open={Boolean(discardTarget)}
        destructive
        busy={busyId === discardTarget?._id}
        title="Discard this check-in"
        message="Remove this photo and its record permanently?"
        detail="Do this only when the photo shows no instructor — a wall, a passer-by or a test shot. If somebody did check in, assign them instead so their attendance is kept."
        confirmLabel="Discard"
        onCancel={() => setDiscardTarget(null)}
        onConfirm={() => discardTarget && void discard(discardTarget)}
      />
    </div>
  );
}
