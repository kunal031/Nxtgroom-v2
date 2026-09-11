import { useCallback, useEffect, useRef, useState } from 'react';
import { Camera, Trash2, Upload, UserCircle2 } from 'lucide-react';
import { apiFetch } from '../api';
import { preparePhoto } from '../lib/imageCapture';
import { validatePhoto, validateSourcePhoto } from '../imageValidation';
import { useToast } from './useToast';

/**
 * The reference face photograph one instructor is recognised against.
 *
 * Recognition compares a check-in photo to what is enrolled here, so a poor
 * reference does not fail loudly — it produces confident matches against the
 * wrong person for as long as it stays enrolled. The server refuses a photo
 * with no face, with several faces, or too blurry to use; this component's job
 * is to carry that refusal back in words an admin can act on, rather than as a
 * status code.
 */

export interface ReferencePhotoState {
  has_reference: boolean;
  face_count: number;
  face_indexed_at: string | null;
  photo_url: string | null;
}

interface ReferencePhotoFieldProps {
  /** Absent while creating: there is no instructor to attach a photo to yet. */
  instructorId?: string | null;
  /**
   * Create mode holds the chosen file until the instructor exists, then uploads
   * it. Edit mode uploads immediately, because the record is already there.
   */
  mode: 'create' | 'edit';
  /** Create mode only: hands the chosen file up so the form can upload it. */
  onFileSelected?: (file: File | null) => void;
  /** Create mode only: a photo is required before the instructor can be saved. */
  required?: boolean;
}

const MODE_ADD = 'add';
const MODE_REPLACE = 'replace';

export default function ReferencePhotoField({
  instructorId,
  mode,
  onFileSelected,
  required = false,
}: ReferencePhotoFieldProps) {
  const [state, setState] = useState<ReferencePhotoState | null>(null);
  const [loading, setLoading] = useState(mode === 'edit');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notConfigured, setNotConfigured] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [pendingName, setPendingName] = useState('');
  const fileInput = useRef<HTMLInputElement | null>(null);
  const toast = useToast();

  // Revoked on replacement and unmount: an object URL held for the life of the
  // dialog leaks the decoded image for every photo the admin previews.
  useEffect(() => () => {
    if (localPreview) URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const loadState = useCallback(async (signal?: AbortSignal) => {
    if (mode !== 'edit' || !instructorId) return;
    try {
      const data = await apiFetch<ReferencePhotoState>(
        `/api/v2/instructors/${encodeURIComponent(instructorId)}/face`,
        { signal },
      );
      if (signal?.aborted) return;
      setState(data);
      setNotConfigured(false);
      setError('');
    } catch (requestError) {
      if (signal?.aborted) return;
      const status = (requestError as { status?: number })?.status;
      // 401 is owned by the central session handler, and 503 means the AWS
      // collection has not been created yet — neither is this screen's error.
      if (status === 401) return;
      if (status === 503) {
        setNotConfigured(true);
        return;
      }
      setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [instructorId, mode]);

  useEffect(() => {
    const controller = new AbortController();
    void loadState(controller.signal);
    return () => controller.abort();
  }, [loadState]);

  /**
   * Validates and downscales before anything is sent.
   *
   * Same two-stage order the attendance capture uses: the raw camera file is
   * checked leniently, then the downscaled result is checked against the limit
   * the server actually enforces. Checking the 8 MB rule on the original would
   * reject an ordinary 12MP photo that becomes a few hundred KB once resized.
   */
  const prepare = async (file: File): Promise<File | null> => {
    const sourceProblem = validateSourcePhoto(file);
    if (sourceProblem) {
      setError(sourceProblem);
      return null;
    }
    // preparePhoto returns the downscaled file alongside its dimensions, so the
    // File itself has to be unwrapped before validating or uploading it.
    const { file: prepared } = await preparePhoto(file);
    const problem = validatePhoto(prepared);
    if (problem) {
      setError(problem);
      return null;
    }
    return prepared;
  };

  const showLocalPreview = (file: File) => {
    setLocalPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
    setPendingName(file.name);
  };

  const upload = async (file: File, uploadMode: typeof MODE_ADD | typeof MODE_REPLACE) => {
    if (!instructorId) return;
    setBusy(true);
    setError('');
    try {
      const prepared = await prepare(file);
      if (!prepared) return;

      const form = new FormData();
      form.append('photo', prepared, prepared.name || 'reference.jpg');
      form.append('mode', uploadMode);
      // FormData is passed through untouched so the browser sets its own
      // multipart boundary; apiJson would stringify it into "[object Object]".
      const result = await apiFetch<{ face_count?: number; retired_faces?: number }>(
        `/api/v2/instructors/${encodeURIComponent(instructorId)}/face`,
        { method: 'POST', body: form, timeoutMs: 60_000 },
      );
      toast.success(
        uploadMode === MODE_REPLACE ? 'Reference photo replaced' : 'Reference photo added',
        {
          detail: result?.face_count
            ? `${result.face_count} face${result.face_count === 1 ? '' : 's'} enrolled`
            : undefined,
        },
      );
      showLocalPreview(prepared);
      await loadState();
    } catch (requestError) {
      const status = (requestError as { status?: number })?.status;
      if (status === 401) return;
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      if (status === 503) setNotConfigured(true);
      setError(message);
      toast.error('Could not save the reference photo', { detail: message });
    } finally {
      setBusy(false);
    }
  };

  const handleChosenFile = async (file: File | null) => {
    if (fileInput.current) fileInput.current.value = '';
    if (!file) return;
    setError('');

    // Create mode cannot upload yet: the instructor does not exist, so there is
    // nothing to attach a face to. The file is held and the form sends it once
    // the record has an id.
    if (mode === 'create') {
      const prepared = await prepare(file);
      if (!prepared) {
        onFileSelected?.(null);
        return;
      }
      showLocalPreview(prepared);
      onFileSelected?.(prepared);
      return;
    }

    // Reached only from the Add buttons. Replace has its own path, so adding is
    // correct whether or not a face is already enrolled: the server keeps the
    // existing ones and drops the oldest only at the cap.
    await upload(file, MODE_ADD);
  };

  const handleReplace = () => {
    const input = fileInput.current;
    if (!input) return;
    input.dataset.mode = MODE_REPLACE;
    input.click();
  };

  const handleAdd = () => {
    const input = fileInput.current;
    if (!input) return;
    input.dataset.mode = MODE_ADD;
    input.click();
  };

  const handleRemove = async () => {
    if (!instructorId) return;
    setBusy(true);
    setError('');
    try {
      await apiFetch(`/api/v2/instructors/${encodeURIComponent(instructorId)}/face`, {
        method: 'DELETE',
      });
      toast.success('Reference photo removed');
      setLocalPreview((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      setPendingName('');
      await loadState();
    } catch (requestError) {
      const status = (requestError as { status?: number })?.status;
      if (status === 401) return;
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not remove the reference photo', { detail: message });
    } finally {
      setBusy(false);
    }
  };

  const previewUrl = localPreview || state?.photo_url || null;
  const enrolled = mode === 'create' ? Boolean(localPreview) : Boolean(state?.has_reference);

  return (
    <div className="rounded-md border border-slate-200 bg-slate-50/50 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider">
            Reference Photo
            {required && mode === 'create' && <span className="text-rose-500 ml-1">*</span>}
          </label>
          <p className="text-xs text-slate-500 mt-1">
            Used to recognise this instructor at check-in. Use a clear, front-facing photo of one person.
          </p>
        </div>
        {enrolled && state?.face_count ? (
          <span className="shrink-0 inline-flex px-2 py-1 bg-emerald-50 text-emerald-700 font-bold text-[11px] rounded-md border border-emerald-100 whitespace-nowrap">
            {state.face_count} enrolled
          </span>
        ) : null}
      </div>

      {notConfigured ? (
        <p className="text-xs font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md p-2.5">
          Face recognition is not set up on the server yet, so photos cannot be enrolled.
          The instructor can still be saved.
        </p>
      ) : (
        <div className="flex items-center gap-4">
          <div className="shrink-0 h-20 w-20 rounded-md border border-slate-200 bg-white overflow-hidden flex items-center justify-center">
            {loading ? (
              <span className="text-[10px] text-slate-400 font-medium">Loading…</span>
            ) : previewUrl ? (
              <img src={previewUrl} alt="Reference face" className="h-full w-full object-cover" />
            ) : (
              <UserCircle2 size={32} className="text-slate-300" aria-hidden="true" />
            )}
          </div>

          <div className="flex-1 min-w-0">
            {pendingName && (
              <p className="text-xs text-slate-500 truncate mb-2" title={pendingName}>{pendingName}</p>
            )}
            {!enrolled && !loading && (
              <p className="text-xs font-medium text-amber-700 mb-2">
                No reference photo yet. This instructor will not be recognised automatically.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  const chosenMode = fileInput.current?.dataset.mode === MODE_REPLACE
                    ? MODE_REPLACE
                    : MODE_ADD;
                  if (mode === 'edit' && file && chosenMode === MODE_REPLACE) {
                    void upload(file, MODE_REPLACE);
                    if (fileInput.current) fileInput.current.value = '';
                    return;
                  }
                  void handleChosenFile(file);
                }}
              />

              {enrolled && mode === 'edit' ? (
                <>
                  {/* Add keeps the existing faces, so recognition improves with
                      each correction instead of resetting to one photograph. */}
                  <button
                    type="button"
                    onClick={handleAdd}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                  >
                    <Camera size={14} aria-hidden="true" />
                    Add another
                  </button>
                  <button
                    type="button"
                    onClick={handleReplace}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 transition-colors disabled:opacity-50"
                  >
                    <Upload size={14} aria-hidden="true" />
                    Replace
                  </button>
                  <button
                    type="button"
                    onClick={handleRemove}
                    disabled={busy}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-rose-700 bg-rose-50 border border-rose-100 hover:bg-rose-100 transition-colors disabled:opacity-50"
                  >
                    <Trash2 size={14} aria-hidden="true" />
                    Remove
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={handleAdd}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-xs font-bold text-indigo-700 bg-indigo-50 border border-indigo-100 hover:bg-indigo-100 transition-colors disabled:opacity-50"
                >
                  <Upload size={14} aria-hidden="true" />
                  {busy ? 'Uploading…' : localPreview ? 'Choose a different photo' : 'Upload photo'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-2.5">
          {error}
        </p>
      )}
    </div>
  );
}
