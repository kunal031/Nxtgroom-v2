import { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import { Toggle } from './SettingsPage';
import { useToast } from './useToast';
import type { AccessSettings } from '../types';

const ACCESS_PATH = '/api/v2/settings/access';

/**
 * Who, besides administrators, may delete an attendance record.
 *
 * Kept apart from the notification preferences above: those decide what gets
 * emailed, this decides who can destroy a record and its photographs. Off
 * until somebody turns it on, and individual accounts can still be granted or
 * refused it under Users regardless of what is set here.
 */
export default function AccessSettingsSection() {
  const [settings, setSettings] = useState<AccessSettings>({ boa_can_delete_records: false, boa_can_delete_checkout: false, boa_can_identify: false });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let disposed = false;
    apiFetch<AccessSettings>(ACCESS_PATH)
      .then((data) => {
        if (!disposed && data) setSettings(data);
      })
      .catch(() => {
        // A failed read leaves the safe default showing rather than an empty
        // control that looks switched off but was never loaded.
        if (!disposed) toast.error('Could not load permission settings');
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => { disposed = true; };
  }, [toast]);

  const update = async (key: keyof AccessSettings, value: boolean) => {
    const previous = settings;
    setSettings({ ...settings, [key]: value });
    setSaving(true);
    try {
      const saved = await apiJson<AccessSettings>(ACCESS_PATH, {
        method: 'PUT',
        body: { [key]: value },
      });
      setSettings(saved);
      toast.success(
        value ? 'Permission granted to BOAs' : 'Permission withdrawn from BOAs',
        { detail: 'Accounts with their own setting under Users are unaffected.' },
      );
    } catch (error) {
      setSettings(previous);
      toast.error('Could not save the permission', {
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section aria-labelledby="access-settings" className="mt-8">
      <h3 id="access-settings" className="flex items-center gap-2 text-sm font-bold text-slate-800 mb-3">
        <ShieldCheck size={16} className="text-indigo-600" aria-hidden="true" />
        Permissions
      </h3>
      <div className="bg-white border border-slate-200 rounded-md">
        <div className="flex items-start justify-between gap-6 p-4">
          <div className="min-w-0">
            <label htmlFor="boa_can_delete_records" className="block text-sm font-semibold text-slate-800">
              Let BOAs delete a whole attendance record
            </label>
            <p className="text-sm text-slate-500 mt-0.5">
              A record cannot exist without its check-in, so this removes the check-in, the check-out,
              both appearance reports and both photographs. It cannot be undone.
            </p>
          </div>
          <Toggle
            id="boa_can_delete_records"
            checked={settings.boa_can_delete_records}
            disabled={loading || saving}
            onChange={(value) => void update('boa_can_delete_records', value)}
          />
        </div>
        <div className="flex items-start justify-between gap-6 border-t border-slate-100 p-4">
          <div className="min-w-0">
            <label htmlFor="boa_can_delete_checkout" className="block text-sm font-semibold text-slate-800">
              Let BOAs delete a check-out on its own
            </label>
            <p className="text-sm text-slate-500 mt-0.5">
              Removes the check-out time, its photograph and its report, leaving the check-in and the
              morning&rsquo;s report standing. Anyone allowed to delete the whole record can already do
              this.
            </p>
          </div>
          <Toggle
            id="boa_can_delete_checkout"
            checked={settings.boa_can_delete_checkout || settings.boa_can_delete_records}
            disabled={loading || saving || settings.boa_can_delete_records}
            onChange={(value) => void update('boa_can_delete_checkout', value)}
          />
        </div>
        {/* Independent of the delete permissions above, and not implied by
            them: a BOA is often the only person who can recognise a face from
            their own campus, yet need never be able to destroy a record. */}
        <div className="flex items-start justify-between gap-6 border-t border-slate-100 p-4">
          <div className="min-w-0">
            <label htmlFor="boa_can_identify" className="block text-sm font-semibold text-slate-800">
              Let BOAs name an unidentified check-in
            </label>
            <p className="text-sm text-slate-500 mt-0.5">
              Shows the Unidentified queue, where a check-in whose face was not recognised is
              assigned to an instructor. Naming one records it as that instructor&rsquo;s attendance
              and enrols the photograph so they are recognised next time. It also allows discarding
              a photograph that shows no instructor.
            </p>
          </div>
          <Toggle
            id="boa_can_identify"
            checked={settings.boa_can_identify}
            disabled={loading || saving}
            onChange={(value) => void update('boa_can_identify', value)}
          />
        </div>
      </div>
    </section>
  );
}
