import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, MapPin, UserRoundSearch } from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import CameraCapture from './CameraCapture';
import { describeAccuracy, formatCoordinates, getCachedFix, subscribeToLocation, type Fix } from '../lib/location';

/** How long a result stays on screen before the camera is ready again. */
const RESULT_VISIBLE_MS = 4_000;

type KioskAction = 'CHECK_IN' | 'CHECK_OUT' | 'TOO_EARLY' | 'ALREADY_DONE' | 'UNIDENTIFIED';

interface KioskResponse {
  action: KioskAction;
  recorded: boolean;
  instructor_name: string | null;
  attendance_id: string | null;
  title: string;
  detail?: string;
  tone: 'success' | 'info' | 'warning';
}

interface KioskResult extends KioskResponse {
  at: number;
}

/**
 * Attendance with no buttons.
 *
 * An instructor stands in front of the tablet, the camera photographs them, and
 * the server works out whether this is their arrival or their departure. The
 * popup is the only confirmation anybody gets — nothing was pressed and no
 * screen is read afterwards — so it names the person and says what was
 * recorded, and stays long enough to be read at arm's length.
 *
 * The camera belongs to this screen rather than to the tablet: it opens when a
 * BOA opens Attendance and releases when they leave. CameraCapture already
 * drops the stream when the tab is hidden, so a backgrounded tablet does not
 * hold the camera either.
 */
export default function KioskAttendance() {
  const [result, setResult] = useState<KioskResult | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [fix, setFix] = useState<Fix | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const resultTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Followed rather than sampled once: the position is evidence of where the
  // attendance happened, and a fix from a previous location must never be sent.
  useEffect(() => subscribeToLocation(setFix), []);

  useEffect(() => () => clearTimeout(resultTimer.current), []);

  const showResult = useCallback((next: KioskResponse) => {
    setResult({ ...next, at: Date.now() });
    clearTimeout(resultTimer.current);
    // Cleared on a timer rather than on the next capture: the camera is already
    // in its cooldown, and a result that vanished the instant somebody stepped
    // away would be unreadable.
    resultTimer.current = setTimeout(() => setResult(null), RESULT_VISIBLE_MS);
  }, []);

  /**
   * Sends one captured frame and shows what it meant.
   *
   * Every outcome is a result, including the ones that record nothing: being
   * told "already checked out today" is the answer, not a failure. Only a
   * transport or server fault becomes an error.
   */
  const submit = useCallback(async (file: File) => {
    setSubmitting(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const currentFix = fix ?? getCachedFix();
      const coordinates = formatCoordinates(currentFix);
      if (coordinates) {
        form.append('location_coordinates', coordinates);
        form.append('location_accuracy_m', String(currentFix?.accuracyMetres ?? ''));
      }
      const response = await apiFetch<KioskResponse>('/api/v2/attendance/auto', {
        method: 'POST',
        body: form,
        timeoutMs: 75_000,
      });
      showResult(response);
    } catch (requestError) {
      if ((requestError as { status?: number })?.status === 401) return;
      const message = requestError instanceof ApiError
        ? requestError.message
        : 'Could not record that. Try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }, [fix, showResult]);

  const toneStyles: Record<KioskResponse['tone'], string> = {
    success: 'bg-emerald-600 text-white',
    info: 'bg-slate-800 text-white',
    warning: 'bg-amber-500 text-white',
  };

  const ToneIcon = result?.tone === 'success'
    ? CheckCircle2
    : result?.tone === 'warning'
      ? UserRoundSearch
      : CircleAlert;

  return (
    <div className="w-full h-full flex flex-col">
      <div className="mb-4 shrink-0 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-extrabold text-slate-800">Attendance</h2>
          <p className="text-sm text-slate-500 mt-1">
            Stand in the outline. The photo is taken automatically and the instructor is
            identified from it.
          </p>
        </div>
        <p className="text-xs font-medium text-slate-500 flex items-center gap-1.5">
          <MapPin size={14} className={fix ? 'text-emerald-600' : 'text-slate-400'} aria-hidden="true" />
          {fix ? `Live location (${describeAccuracy(fix)})` : 'Locating…'}
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700 shrink-0">
          {error}
        </div>
      )}

      <div className="relative flex-1 min-h-0 rounded-md overflow-hidden border border-slate-200 bg-black">
        {/* Mounted for the life of this screen: it captures, resets and is ready
            for the next person without anybody reopening it. */}
        <CameraCapture
          facing={facing}
          autoCapture
          onFlip={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
          onCapture={(file) => void submit(file)}
          onClose={() => undefined}
        />

        {submitting && (
          <div className="absolute inset-x-0 top-0 bg-slate-900/80 py-3 text-center" role="status">
            <p className="text-sm font-bold text-white">Identifying…</p>
          </div>
        )}

        {/* The only confirmation anybody gets, so it covers the frame rather
            than sitting in a corner, and names the person rather than saying
            only that something was saved. */}
        {result && (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center ${toneStyles[result.tone]}`}
            role="status"
            aria-live="assertive"
          >
            <ToneIcon size={56} aria-hidden="true" />
            <p className="text-3xl font-extrabold">{result.title}</p>
            {result.detail && (
              <p className="text-base font-medium opacity-90 max-w-md">{result.detail}</p>
            )}
            {!result.recorded && (
              <p className="text-xs font-bold uppercase tracking-wider opacity-75">
                Nothing was recorded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
