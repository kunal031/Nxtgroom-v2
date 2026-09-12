import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Mail, Plus, Trash2, Users } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import ConfirmDialog from './ConfirmDialog';
import { useToast } from './useToast';
import { Toggle } from './SettingsPage';

const RP_PATH = '/api/v2/settings/rp-recipients';
const EVENTS_PATH = '/api/v2/settings/rp-recipients/events';

interface RecipientEvents {
  checkin_enabled: boolean;
  checkout_enabled: boolean;
}

/**
 * Which halves the partners are copied on.
 *
 * Two switches rather than one, because they are genuinely different asks:
 * somebody may want the morning's failures without a second message every
 * evening. Both default to on, so an existing setup keeps behaving as it did.
 */
function EventToggles() {
  const [events, setEvents] = useState<RecipientEvents>({ checkin_enabled: true, checkout_enabled: true });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    apiFetch<RecipientEvents>(EVENTS_PATH)
      .then((data) => { if (!disposed && data) setEvents(data); })
      .catch(() => { if (!disposed) toast.error('Could not load reporting partner settings'); })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [toast]);

  const update = async (key: keyof RecipientEvents, value: boolean) => {
    const previous = events;
    setEvents({ ...events, [key]: value });
    setSaving(true);
    try {
      setEvents(await apiJson<RecipientEvents>(EVENTS_PATH, { method: 'PUT', body: { [key]: value } }));
      toast.success(
        value
          ? `Partners will be copied on ${key === 'checkin_enabled' ? 'check-in' : 'check-out'} reports`
          : `Partners will no longer be copied on ${key === 'checkin_enabled' ? 'check-in' : 'check-out'} reports`,
      );
    } catch (error) {
      setEvents(previous);
      toast.error('Could not save the setting', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const rows: { key: keyof RecipientEvents; label: string; hint: string }[] = [
    { key: 'checkin_enabled', label: 'Copy partners on check-in reports', hint: 'Sent when a check-in photo does not meet the standards.' },
    { key: 'checkout_enabled', label: 'Copy partners on check-out reports', hint: 'Sent when a check-out photo does not meet the standards.' },
  ];

  return (
    <div className="mb-5 rounded-md border border-slate-200 bg-white divide-y divide-slate-100">
      {rows.map((row) => (
        <div key={row.key} className="flex items-start justify-between gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor={row.key} className="block text-sm font-semibold text-slate-800">{row.label}</label>
            <p className="mt-0.5 text-sm text-slate-500">{row.hint}</p>
          </div>
          <Toggle
            id={row.key}
            checked={events[row.key]}
            disabled={loading || saving}
            onChange={(value: boolean) => void update(row.key, value)}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Reporting Partners: the addresses copied on an instructor's appearance
 * alert. Administrators and BOAs are never sent these, so this list is the
 * only way anyone other than the instructor sees a failed result by email.
 */
export default function ReportRecipients() {
  const [emails, setEmails] = useState<string[]>([]);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [confirmTarget, setConfirmTarget] = useState<string | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ emails: string[] }>(RP_PATH);
      setEmails(Array.isArray(data?.emails) ? data.emails : []);
      setError('');
    } catch (requestError) {
      if ((requestError as { status?: number })?.status !== 401) {
        setError(requestError instanceof Error ? requestError.message : String(requestError));
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleAdd = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!value) return;

    setSubmitting(true);
    setError('');
    try {
      // The server returns the full list, so local state comes from the
      // response rather than a refetch.
      const data = await apiJson<{ emails: string[] }>(RP_PATH, {
        method: 'POST',
        body: { email: value },
      });
      setEmails(Array.isArray(data?.emails) ? data.emails : []);
      setEmail('');
      toast.success('Reporting partner added', { detail: value });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not add recipient', { detail: message });
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemove = async (value: string) => {
    setRemoving(value);
    setError('');
    try {
      const data = await apiFetch<{ emails: string[] }>(
        `${RP_PATH}/${encodeURIComponent(value)}`,
        { method: 'DELETE' },
      );
      setEmails(Array.isArray(data?.emails) ? data.emails : []);
      toast.success('Reporting partner removed', { detail: value });
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : String(requestError);
      setError(message);
      toast.error('Could not remove recipient', { detail: message });
    } finally {
      setRemoving(null);
      setConfirmTarget(null);
    }
  };

  return (
    <section className="max-w-3xl" aria-labelledby="rp-title">
      <div className="mb-5">
        <h3 id="rp-title" className="text-lg font-extrabold text-slate-800 flex items-center gap-2">
          <Users size={20} className="text-indigo-600" aria-hidden="true" />
          Reporting Partners
        </h3>
        <p className="mt-1 text-sm text-slate-500">
          These addresses are copied when an instructor's appearance report is non-compliant.
          The instructor is always emailed their own report; these settings control who else is.
        </p>
        {/* Stated plainly: it is the only way anyone but the instructor is told. */}
        <p className="mt-1 text-xs text-slate-400">
          Administrators, super admins and BOAs are never emailed these reports. Only the
          instructor and the partners listed here.
        </p>
      </div>

      <EventToggles />

      <form onSubmit={handleAdd} className="mb-5 flex flex-wrap items-start gap-2">
        <div className="relative basis-full sm:basis-auto sm:min-w-[16rem] flex-1">
          <Mail size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" aria-hidden="true" />
          <input
            type="email"
            required
            maxLength={254}
            autoComplete="off"
            aria-label="Reporting partner email address"
            placeholder="partner@nxtwave.co.in"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            disabled={submitting}
            className="w-full rounded-md border border-slate-200 bg-white py-2.5 pl-9 pr-3 text-sm outline-none transition-all focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={submitting || !email.trim()}
          className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-md shadow-indigo-200 transition-colors hover:bg-indigo-700 disabled:opacity-60"
        >
          <Plus size={16} aria-hidden="true" />
          {submitting ? 'Adding…' : 'Add'}
        </button>
      </form>

      {error && (
        <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-slate-200 bg-white">
        {loading ? (
          <p className="p-8 text-center text-sm font-medium text-slate-400">Loading recipients…</p>
        ) : emails.length === 0 ? (
          <p className="p-8 text-center text-sm font-medium text-slate-400">
            No reporting partners yet. Alerts currently go only to the instructor.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {emails.map((value) => (
              <li key={value} className="flex items-center justify-between gap-4 p-4">
                <span className="flex min-w-0 items-center gap-2">
                  <Mail size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="truncate text-sm font-medium text-slate-700">{value}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setConfirmTarget(value)}
                  disabled={removing === value}
                  aria-label={`Remove ${value}`}
                  title={`Remove ${value}`}
                  className="shrink-0 rounded-md border border-rose-100 bg-rose-50 p-2 text-rose-700 transition-colors hover:bg-rose-100 focus:outline-none focus:ring-2 focus:ring-rose-500 disabled:opacity-50"
                >
                  <Trash2 size={15} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {emails.length > 0 && (
        <p className="mt-2 text-xs text-slate-400">
          {emails.length} reporting {emails.length === 1 ? 'partner' : 'partners'}.
        </p>
      )}

      <ConfirmDialog
        open={Boolean(confirmTarget)}
        destructive
        busy={Boolean(removing)}
        title="Remove reporting partner"
        message={`Stop sending appearance alerts to ${confirmTarget ?? 'this address'}?`}
        detail="They will no longer be copied on non-compliant or review-required results."
        confirmLabel="Remove"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => confirmTarget && handleRemove(confirmTarget)}
      />
    </section>
  );
}
