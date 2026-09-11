import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Search, Upload, UserCircle2 } from 'lucide-react';
import { apiFetch, apiFetchAllPages, invalidateCache } from '../api';
import { preparePhoto } from '../lib/imageCapture';
import { validatePhoto, validateSourcePhoto } from '../imageValidation';
import { useToast } from './useToast';
import type { Instructor } from '../types';

const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';

type EnrolmentFilter = 'all' | 'needs_photo' | 'enrolled';

interface CollegeEnrolmentListProps {
  collegeId: string;
  collegeName: string;
  onBack: () => void;
  /** Lets the college table refresh its counts once photos have been added. */
  onEnrolmentChanged: () => void;
}

/**
 * One college's instructors, for working through reference photos.
 *
 * Enrolment is the slowest part of switching a college to face recognition, and
 * doing it from the instructor list means hunting for the right people among
 * every college's roster. Here the list is already the campus an administrator
 * is looking at.
 *
 * Unenrolled instructors sort first and stay first while the filter is on
 * "needs photo", so the work to do rises to the top and the list visibly
 * shortens as it is done.
 */
export default function CollegeEnrolmentList({
  collegeId,
  collegeName,
  onBack,
  onEnrolmentChanged,
}: CollegeEnrolmentListProps) {
  const [instructors, setInstructors] = useState<Instructor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<EnrolmentFilter>('needs_photo');
  const [busyId, setBusyId] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const toast = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      // The roster endpoint does not filter by college, so the list is fetched
      // whole and narrowed here. It is the same request the instructor screen
      // makes, so it is usually already cached.
      const roster = await apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, {
        pageSize: 1_000,
        cacheMs: 15_000,
        signal,
      });
      if (signal?.aborted) return;
      setInstructors(Array.isArray(roster) ? roster : []);
      setError('');
    } catch (requestError) {
      if (signal?.aborted) return;
      if ((requestError as { status?: number })?.status === 401) return;
      // A cancelled request is not a failure worth showing.
      //
      // Cached GETs share one in-flight promise between callers, and effects run
      // twice in development. The first mount's cleanup aborts the request the
      // second mount is also awaiting, so the rejection arrives while this
      // call's own signal is still live and the guard above misses it. The
      // screen then showed "The request timed out or was cancelled" over an
      // empty table, for a list that had simply never been fetched.
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      if (/timed out or was cancelled/i.test(message)) {
        // Retry once without a signal: the shared promise that failed has been
        // cleared, so this fetches cleanly rather than leaving the table empty.
        try {
          const retried = await apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, { pageSize: 1_000 });
          if (signal?.aborted) return;
          setInstructors(Array.isArray(retried) ? retried : []);
          setError('');
          return;
        } catch {
          if (signal?.aborted) return;
        }
      }
      setError(message);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const collegeInstructors = useMemo(
    () => instructors.filter((row) => String(row.college_id) === String(collegeId)),
    [instructors, collegeId],
  );

  const enrolledCount = collegeInstructors.filter((row) => (row.face_count ?? 0) > 0).length;

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    return collegeInstructors
      .filter((row) => {
        const enrolled = (row.face_count ?? 0) > 0;
        if (filter === 'needs_photo' && enrolled) return false;
        if (filter === 'enrolled' && !enrolled) return false;
        if (!term) return true;
        return [row.name, row.email, row.instructor_role, row.role]
          .some((value) => String(value ?? '').toLowerCase().includes(term));
      })
      // Unenrolled first: the work to do belongs at the top. Within each group,
      // alphabetical, so a name can still be found by scanning.
      .sort((left, right) => {
        const leftEnrolled = (left.face_count ?? 0) > 0 ? 1 : 0;
        const rightEnrolled = (right.face_count ?? 0) > 0 ? 1 : 0;
        if (leftEnrolled !== rightEnrolled) return leftEnrolled - rightEnrolled;
        return String(left.name || '').localeCompare(String(right.name || ''));
      });
  }, [collegeInstructors, filter, search]);

  const upload = async (instructor: Instructor, file: File) => {
    setBusyId(instructor._id);
    setError('');
    try {
      const sourceProblem = validateSourcePhoto(file);
      if (sourceProblem) {
        setError(sourceProblem);
        return;
      }
      // preparePhoto returns the downscaled file alongside its dimensions.
      const { file: prepared } = await preparePhoto(file);
      const problem = validatePhoto(prepared);
      if (problem) {
        setError(problem);
        return;
      }

      const form = new FormData();
      form.append('photo', prepared, prepared.name || 'reference.jpg');
      // Always add: an administrator working through a college is enrolling
      // people for the first time, and replacing would silently discard a face
      // somebody had already corrected.
      form.append('mode', 'add');
      const result = await apiFetch<{ face_count?: number }>(
        `/api/v2/instructors/${encodeURIComponent(instructor._id)}/face`,
        { method: 'POST', body: form, timeoutMs: 60_000 },
      );

      invalidateCache(INSTRUCTORS_PATH);
      setInstructors((current) => current.map((row) => (
        row._id === instructor._id
          ? { ...row, face_count: result?.face_count ?? 1 }
          : row
      )));
      onEnrolmentChanged();
      toast.success('Reference photo added', { detail: instructor.name });
    } catch (requestError) {
      if ((requestError as { status?: number })?.status === 401) return;
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(`${instructor.name}: ${message}`);
      toast.error('Could not add the reference photo', { detail: message });
    } finally {
      setBusyId(null);
    }
  };

  const filterButton = (value: EnrolmentFilter, label: string, count: number) => (
    <button
      type="button"
      onClick={() => setFilter(value)}
      aria-pressed={filter === value}
      className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors ${
        filter === value
          ? 'bg-indigo-600 text-white border-indigo-600'
          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
      }`}
    >
      {label} ({count})
    </button>
  );

  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-100">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-500 hover:text-slate-800 transition-colors mb-3"
        >
          <ArrowLeft size={14} aria-hidden="true" />
          All colleges
        </button>
        <h3 className="text-base font-extrabold text-slate-800">{collegeName}</h3>
        <p className="text-sm text-slate-500 mt-1">
          {enrolledCount} of {collegeInstructors.length} instructors have a reference photo.
          Recognition can only identify the ones that do.
        </p>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          {filterButton('needs_photo', 'Needs photo', collegeInstructors.length - enrolledCount)}
          {filterButton('enrolled', 'Enrolled', enrolledCount)}
          {filterButton('all', 'All', collegeInstructors.length)}
          <div className="relative flex-1 min-w-[12rem]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search this college…"
              className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>
        </div>

        {error && (
          <p role="alert" className="mt-3 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2.5">
            {error}
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
              <th className="p-4">Instructor</th>
              <th className="p-4">Reference photo</th>
              <th className="p-4 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={3} className="p-8 text-center text-slate-400 font-medium">Loading instructors…</td></tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-slate-400 font-medium">
                  {filter === 'needs_photo' && collegeInstructors.length > 0
                    ? 'Every instructor at this college has a reference photo.'
                    : 'No instructors found.'}
                </td>
              </tr>
            ) : (
              visible.map((instructor) => {
                const enrolled = (instructor.face_count ?? 0) > 0;
                const busy = busyId === instructor._id;
                return (
                  <tr key={instructor._id} className="hover:bg-slate-50 transition-colors">
                    <td className="p-4">
                      <span className="font-bold text-slate-800">{instructor.name}</span>
                      <span className="block text-[11px] text-slate-400 font-medium mt-0.5">
                        {instructor.instructor_role || instructor.role || '--'}
                      </span>
                    </td>
                    <td className="p-4">
                      {enrolled ? (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-emerald-50 text-emerald-700 font-bold text-[11px] rounded-md border border-emerald-100">
                          <Check size={12} aria-hidden="true" />
                          {instructor.face_count} enrolled
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-amber-50 text-amber-700 font-bold text-[11px] rounded-md border border-amber-100">
                          <UserCircle2 size={12} aria-hidden="true" />
                          No photo
                        </span>
                      )}
                    </td>
                    <td className="p-4 text-right">
                      <input
                        ref={(element) => { fileInputs.current[instructor._id] = element; }}
                        type="file"
                        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                        className="hidden"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          event.target.value = '';
                          if (file) void upload(instructor, file);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => fileInputs.current[instructor._id]?.click()}
                        disabled={busy || busyId !== null}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                      >
                        <Upload size={14} aria-hidden="true" />
                        {busy ? 'Uploading…' : enrolled ? 'Add another' : 'Upload photo'}
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
