import { useCallback, useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import { apiFetch } from '../api';
import CollegeEnrolmentList from './CollegeEnrolmentList';
import { useToast } from './useToast';
import type { IdentificationSettings } from '../types';

const IDENTIFICATION_PATH = '/api/v2/settings/identification';

/**
 * How many instructors at each college can be recognised from their photograph.
 *
 * A list rather than a set of controls: recognition is how every college
 * identifies an instructor, so there is nothing to choose here. What matters is
 * how far each campus has got with collecting reference photographs, which is
 * worked through a college at a time — open one to enrol the instructors who
 * still have none.
 */
export default function IdentificationSettingsSection() {
  const [settings, setSettings] = useState<IdentificationSettings | null>(null);
  const [loading, setLoading] = useState(true);
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
      {/* Search only. The heading repeated the tab that led here, and the
          default-mode control has gone with the mode column below it. */}
      <div className="p-3 border-b border-slate-100">
        <div className="relative">
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

      {/* Three columns fit a phone without scrolling once the mode buttons are
          gone, so the table drops the minimum width that used to force it. */}
      <div className="overflow-x-auto overscroll-x-contain">
        <table className="w-full text-left border-collapse table-fixed">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
              {/* Fixed widths so a long college name truncates on one line
                  rather than wrapping and making its row twice the height of
                  every other. */}
              <th className="px-3 py-2.5 w-[56%]">College</th>
              <th className="px-3 py-2.5 w-[22%]">Instructors</th>
              <th className="px-3 py-2.5 w-[22%]">Photos</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleColleges.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-6 text-center text-slate-400 font-medium">
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
              // college.
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
                  <td className="px-3 py-2.5 font-bold text-slate-800 truncate" title={college.college_name || ''}>
                    {college.college_name || '--'}
                  </td>
                  <td className="px-3 py-2.5 text-sm font-medium text-slate-600 whitespace-nowrap">
                    {college.instructors}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    <span className="text-sm font-bold text-slate-700">
                      {college.enrolled}/{college.instructors}
                    </span>
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
