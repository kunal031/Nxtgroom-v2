import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Loader2, MapPin, UserRoundSearch } from 'lucide-react';
import { apiFetch, ApiError } from '../api';
import CameraCapture from './CameraCapture';
import { describeAccuracy, formatCoordinates, getCachedFix, subscribeToLocation, type Fix } from '../lib/location';

/**
 * How long a result stays on screen.
 *
 * Long enough to read a name at arm's length, short enough that it is gone
 * before the next person has finished stepping into frame. The camera keeps
 * running underneath either way, so this only governs the message.
 */
const RESULT_VISIBLE_MS = 2_000;

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

interface KioskAttendanceProps {
  /**
   * Leaves the camera. The screen is the camera, so closing it has to go
   * somewhere rather than leaving an empty frame: Daily Records is where a BOA
   * looks next, and it releases the stream on the way out.
   */
  onExit: () => void;
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
export default function KioskAttendance({ onExit }: KioskAttendanceProps) {
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
      {/* One short line, so the picture gets the rest of the screen. The
          instructions that used to sit here are already on the camera itself,
          where somebody standing in front of it is actually looking: the guide
          outline shows where to stand, and the guidance line says what to fix
          when the camera has not fired. Repeating them above the frame only
          pushed the frame down. */}
      <div className="mb-2 shrink-0 flex items-center justify-between gap-4">
        <h2 className="text-lg font-extrabold text-slate-800">Attendance</h2>
        <p className="text-xs font-medium text-slate-500 flex items-center gap-1.5 shrink-0">
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
        {/* Inline, so the sidebar stays visible and usable: this screen is a
            panel in the app rather than something covering it. Leaving is
            navigation like any other, which is why there is no close button —
            onExit remains for the fullscreen callers of this component. */}
        <CameraCapture
          facing={facing}
          autoCapture
          inline
          onFlip={() => setFacing((current) => (current === 'user' ? 'environment' : 'user'))}
          onCapture={(file) => void submit(file)}
          onClose={onExit}
        />

        {/* The photograph has been taken and the person is being recognised,
            which takes a couple of seconds against Rekognition. Centred and
            green so that somebody standing at the tablet can see at a glance
            that they were captured and the machine is working — a small dark
            pill in a corner read as an incidental status line and left people
            wondering whether anything had happened at all.

            Hidden while a result is showing: with the camera live the next
            capture can start before the previous name has faded, and the
            answer somebody is reading matters more than the next request. */}
        {submitting && !result && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-emerald-600/90"
            role="status"
          >
            <Loader2 size={44} className="animate-spin text-white" aria-hidden="true" />
            <p className="text-xl font-extrabold text-white">Identifying…</p>
          </div>
        )}

        {/* The answer, over a camera that never stopped: the next instructor
            can step up while this is still on screen rather than waiting out a
            blanked frame. Centred and large for the same reason as above — it
            is the only confirmation anybody gets, and it is read at arm's
            length by somebody who pressed nothing. */}
        {result && (
          <div
            className={`absolute inset-0 flex flex-col items-center justify-center gap-2 px-6 text-center ${toneStyles[result.tone]}`}
            role="status"
            aria-live="assertive"
          >
            <ToneIcon size={44} className="shrink-0" aria-hidden="true" />
            <p className="text-2xl font-extrabold leading-tight">{result.title}</p>
            {result.detail && (
              <p className="text-sm font-medium opacity-90 max-w-md line-clamp-3">{result.detail}</p>
            )}
            {!result.recorded && (
              <p className="text-[10px] font-bold uppercase tracking-wider opacity-75">
                Nothing was recorded
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
