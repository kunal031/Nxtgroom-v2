import { useCallback, useEffect, useState } from 'react';
import { ListChecks, RotateCcw, ScanFace, Search } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import CollegeEnrolmentList from './CollegeEnrolmentList';
import IconTooltip from './IconTooltip';
import { useToast } from './useToast';
import type { CollegeIdentification, IdentificationMode, IdentificationSettings } from '../types';

const IDENTIFICATION_PATH = '/api/v2/settings/identification';

/**
 * How each college decides who an instructor is at check-in.
 *
 * Face-only recognises the person from their photograph and shows no selector;
 * selector keeps the dropdown a BOA picks from. Set per college over a global
 * default, because reference faces are enrolled a campus at a time: one college
 * can be recognising faces while another is still collecting photographs.
 *
 * The enrolment figures sit next to each switch because they are the same
 * decision. A college set to face-only with few enrolled faces still records
 * attendance — every check-in is saved as unidentified for an admin to resolve —
 * but that is worth knowing before choosing it, not after.
 */
export default function IdentificationSettingsSection() {
  const [settings, setSettings] = useState<IdentificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  /** The college whose instructors are being enrolled, or null for the table. */
  const [openCollege, setOpenCollege] = useState<{ id: string; name: string } | null>(null);
  const [search, setSearch] = useState('');
  const toast = useToast();

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiFetch<IdentificationSettings>(IDENTIFICATION_PATH, { signal });
      if (!signal?.aborted && data) setSettings(data);
    } catch (error) {
      if (signal?.aborted) return;
      if ((error as { status?: number })?.status === 401) return;
      toast.error('Could not load identification settings');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  /**
   * Saves one change and reloads.
   *
   * Reloading rather than patching locally: changing the global default moves
   * every college that has no override of its own, so the rows other than the
   * one touched can change too, and guessing which would drift from the server.
   */
  const save = async (key: string, body: Record<string, unknown>, description: string) => {
    setSavingKey(key);
    try {
      await apiJson(IDENTIFICATION_PATH, { method: 'PUT', body });
      await load();
      toast.success(description);
    } catch (error) {
      if ((error as { status?: number })?.status === 401) return;
      const detail = error instanceof Error ? error.message : String(error);
      toast.error('Could not save identification settings', { detail });
    } finally {
      setSavingKey(null);
    }
  };

  const setDefaultMode = (mode: IdentificationMode) => save(
    'default',
    { default_mode: mode },
    mode === 'FACE_ONLY'
      ? 'Face recognition is now the default'
      : 'Instructor selector is now the default',
  );

  const setCollegeMode = (college: CollegeIdentification, mode: IdentificationMode | null) => save(
    college.college_id,
    { college_modes: { [college.college_id]: mode } },
    mode === null
      ? `${college.college_name || 'College'} follows the default again`
      : `${college.college_name || 'College'} set to ${mode === 'FACE_ONLY' ? 'face recognition' : 'selector'}`,
  );

  const modeButton = (
    active: boolean,
    label: string,
    onClick: () => void,
    disabled: boolean,
  ) => (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`px-3 py-1.5 rounded-md text-xs font-bold border transition-colors disabled:opacity-50 ${
        active
          ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
          : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
      }`}
    >
      {label}
    </button>
  );

  /**
   * One mode as an icon, for the per-college rows.
   *
   * The label moves into the tooltip so the column stays one line wide across
   * thirty-odd colleges. The active mode is filled rather than outlined, and
   * carries aria-pressed, so which one is on does not depend on colour alone.
   */
  const modeIcon = (
    Icon: LucideIcon,
    active: boolean,
    label: string,
    onClick: () => void,
    disabled: boolean,
  ) => (
    <IconTooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-pressed={active}
        aria-label={label}
        className={`w-8 h-8 rounded-md flex items-center justify-center border transition-colors disabled:cursor-default ${
          active
            ? 'bg-indigo-600 text-white border-indigo-600 shadow-sm'
            : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50'
        }`}
      >
        <Icon size={15} aria-hidden="true" />
      </button>
    </IconTooltip>
  );

  if (loading) {
    return (
      <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6">
        <p className="text-sm text-slate-400 font-medium">Loading identification settings…</p>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="bg-white rounded-md shadow-sm border border-slate-200 p-6">
        <p className="text-sm text-rose-700 font-medium">Identification settings are unavailable.</p>
      </div>
    );
  }

  if (openCollege) {
    return (
      <CollegeEnrolmentList
        collegeId={openCollege.id}
        collegeName={openCollege.name}
        onBack={() => setOpenCollege(null)}
        // Reloaded rather than patched: the percentage, the low-enrolment flag
        // and the warning above the table are all derived server-side.
        onEnrolmentChanged={() => { void load(); }}
      />
    );
  }

  const term = search.trim().toLowerCase();
  const visibleColleges = term
    ? settings.colleges.filter((college) => (
        String(college.college_name || '').toLowerCase().includes(term)
      ))
    : settings.colleges;

  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-100">
        <h3 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
          <ScanFace size={18} className="text-indigo-600" aria-hidden="true" />
          Instructor identification
        </h3>

        {/* One row on a wide screen, stacked on a narrow one. The default-mode
            control keeps its intrinsic width and the search takes what is left,
            so the two never compete for space: below the breakpoint each gets a
            full-width line of its own rather than being crushed together. */}
        <div className="mt-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-3 flex-wrap shrink-0">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider">
              Default for all colleges
            </span>
            {modeButton(
              settings.default_mode === 'FACE_ONLY',
              'Face only',
              () => setDefaultMode('FACE_ONLY'),
              savingKey !== null || settings.default_mode === 'FACE_ONLY',
            )}
            {modeButton(
              settings.default_mode === 'SELECTOR',
              'Selector',
              () => setDefaultMode('SELECTOR'),
              savingKey !== null || settings.default_mode === 'SELECTOR',
            )}
          </div>

          {/* Thirty-odd colleges is more than anybody scans to change one, and
              enrolment is worked through a campus at a time. Takes the width the
              mode control leaves, and a full line of its own once stacked. */}
          <div className="relative flex-1 sm:min-w-[12rem]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search colleges…"
              aria-label="Search colleges"
              className="w-full pl-9 pr-3 py-2 rounded-md border border-slate-200 text-sm outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-500"
            />
          </div>
        </div>
      </div>

      {/* table-fixed with percentage columns is defined as exactly the width of
          its container, so on a phone it never overflowed — it compressed four
          columns into 360px instead, and the wrapper had nothing to scroll. The
          minimum gives the percentages something real to divide, and below it
          the wrapper finally does its job. */}
      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full min-w-[36rem] text-left border-collapse table-fixed">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
              {/* Fixed widths so a long college name truncates on one line
                  rather than wrapping and making its row twice the height of
                  every other. */}
              <th className="p-4 w-[40%]">College</th>
              <th className="p-4 w-[15%]">Instructors</th>
              <th className="p-4 w-[22%]">Reference photos</th>
              <th className="p-4 w-[23%]">Mode</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleColleges.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-8 text-center text-slate-400 font-medium">
                  {/* "Nothing matched" and "nothing exists" look identical to
                      somebody who has just typed, and only one of them means
                      the search should be cleared. */}
                  {settings.colleges.length === 0
                    ? 'No colleges yet.'
                    : `No colleges match “${search.trim()}”.`}
                </td>
              </tr>
            ) : (
              // The whole row opens the college, not just its name: the name is
              // a small target, and every cell in the row is about the same
              // college. The mode buttons stop the click travelling up, so
              // changing a mode does not also navigate.
              visibleColleges.map((college) => (
                <tr
                  key={college.college_id}
                  onClick={() => setOpenCollege({
                    id: college.college_id,
                    name: college.college_name || 'College',
                  })}
                  className="hover:bg-slate-50 transition-colors cursor-pointer"
                >
                  {/* One line, ellipsis on overflow, full name in the tooltip —
                      the same treatment every other table in the app gives a
                      name column. */}
                  <td className="p-4 font-bold text-slate-800 truncate" title={college.college_name || ''}>
                    {college.college_name || '--'}
                    {college.source === 'COLLEGE' && (
                      <span className="ml-2 text-[10px] font-bold text-indigo-600 uppercase tracking-wider">
                        set
                      </span>
                    )}
                  </td>
                  <td className="p-4 text-sm font-medium text-slate-600 whitespace-nowrap">
                    {college.instructors}
                  </td>
                  <td className="p-4 whitespace-nowrap">
                    <span className="text-sm font-bold text-slate-700">
                      {college.enrolled}/{college.instructors}
                    </span>
                  </td>
                  {/* Stops a mode change from also opening the college. */}
                  <td className="p-4 whitespace-nowrap" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center gap-1.5">
                      {modeIcon(
                        ScanFace,
                        college.mode === 'FACE_ONLY',
                        'Face only — the photo identifies the instructor',
                        () => setCollegeMode(college, 'FACE_ONLY'),
                        savingKey !== null || college.mode === 'FACE_ONLY',
                      )}
                      {modeIcon(
                        ListChecks,
                        college.mode === 'SELECTOR',
                        'Selector — a BOA picks the instructor by name',
                        () => setCollegeMode(college, 'SELECTOR'),
                        savingKey !== null || college.mode === 'SELECTOR',
                      )}
                      {/* Clearing an override is distinct from choosing the
                          default's current value: it keeps following the default
                          if that default later changes. */}
                      {college.source === 'COLLEGE' && (
                        <IconTooltip label="Follow the default again">
                          <button
                            type="button"
                            onClick={() => setCollegeMode(college, null)}
                            disabled={savingKey !== null}
                            aria-label="Follow the workspace default again"
                            className="w-8 h-8 rounded-md flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
                          >
                            <RotateCcw size={15} aria-hidden="true" />
                          </button>
                        </IconTooltip>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
