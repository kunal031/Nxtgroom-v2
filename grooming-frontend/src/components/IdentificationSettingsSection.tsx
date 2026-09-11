import { useCallback, useEffect, useState } from 'react';
import { ScanFace, TriangleAlert } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
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

  const lowEnrolmentColleges = settings.colleges.filter((college) => college.low_enrolment);

  return (
    <div className="bg-white rounded-md shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-100">
        <h3 className="text-base font-extrabold text-slate-800 flex items-center gap-2">
          <ScanFace size={18} className="text-indigo-600" aria-hidden="true" />
          Instructor identification
        </h3>
        <p className="text-sm text-slate-500 mt-1">
          Face recognition identifies the instructor from their check-in photo and shows no
          selector. A photo that cannot be matched is still recorded, and waits for an
          administrator to attach the right instructor.
        </p>

        <div className="mt-4 flex items-center gap-3 flex-wrap">
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

        {lowEnrolmentColleges.length > 0 && (
          <p className="mt-4 text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2.5 flex items-start gap-2">
            <TriangleAlert size={14} className="shrink-0 mt-0.5" aria-hidden="true" />
            <span>
              {lowEnrolmentColleges.length === 1
                ? '1 college uses face recognition'
                : `${lowEnrolmentColleges.length} colleges use face recognition`}
              {' '}with fewer than {settings.low_enrolment_percent}% of instructors enrolled.
              Check-ins there will mostly need an administrator to attach the instructor.
            </span>
          </p>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200 text-xs font-bold text-slate-500 uppercase tracking-wider">
              <th className="p-4">College</th>
              <th className="p-4">Reference photos</th>
              <th className="p-4">Identification</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {settings.colleges.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-8 text-center text-slate-400 font-medium">
                  No colleges yet.
                </td>
              </tr>
            ) : (
              settings.colleges.map((college) => (
                <tr key={college.college_id} className="hover:bg-slate-50 transition-colors">
                  <td className="p-4">
                    <span className="font-bold text-slate-800">
                      {college.college_name || '--'}
                    </span>
                    {college.source === 'DEFAULT' && (
                      <span className="block text-[11px] text-slate-400 font-medium mt-0.5">
                        Following the default
                      </span>
                    )}
                  </td>
                  <td className="p-4">
                    <span className="text-sm font-medium text-slate-700">
                      {college.enrolled}/{college.instructors}
                    </span>
                    <span className="text-xs text-slate-400 ml-1.5">
                      ({college.enrolled_percent}%)
                    </span>
                    {college.low_enrolment && (
                      <span
                        className="ml-2 inline-flex items-center gap-1 px-2 py-0.5 bg-amber-50 text-amber-700 font-bold text-[10px] rounded border border-amber-100 whitespace-nowrap"
                        title={`Fewer than ${settings.low_enrolment_percent}% of instructors have a reference photo`}
                      >
                        <TriangleAlert size={10} aria-hidden="true" />
                        Low
                      </span>
                    )}
                  </td>
                  <td className="p-4">
                    <div className="flex items-center gap-2 flex-wrap">
                      {modeButton(
                        college.mode === 'FACE_ONLY',
                        'Face only',
                        () => setCollegeMode(college, 'FACE_ONLY'),
                        savingKey !== null,
                      )}
                      {modeButton(
                        college.mode === 'SELECTOR',
                        'Selector',
                        () => setCollegeMode(college, 'SELECTOR'),
                        savingKey !== null,
                      )}
                      {/* Clearing an override is distinct from choosing the
                          default's current value: it keeps following the default
                          if that default later changes. */}
                      {college.source === 'COLLEGE' && (
                        <button
                          type="button"
                          onClick={() => setCollegeMode(college, null)}
                          disabled={savingKey !== null}
                          className="px-2.5 py-1.5 rounded-md text-xs font-bold text-slate-500 hover:text-slate-700 hover:bg-slate-100 transition-colors disabled:opacity-50"
                        >
                          Use default
                        </button>
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
