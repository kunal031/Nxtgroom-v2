import { useEffect, useState } from 'react';
import { Bell, Building2, Database, ScanFace, Users } from 'lucide-react';
import { apiFetch, apiJson } from '../api';
import CollegeManagement from './CollegeManagement';
import IdentificationSettingsSection from './IdentificationSettingsSection';
import InstructorSyncPanel from './InstructorSyncPanel';
import ReportRecipients from './ReportRecipients';
import AccessSettingsSection from './AccessSettingsSection';
import type { NotificationSettings } from '../types';

export interface ToggleProps {
  id: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}

const SETTINGS_PATH = '/api/v2/settings/notifications';

const TOGGLES: { key: keyof NotificationSettings; label: string; description: string }[] = [
  {
    key: 'checkin_email_enabled',
    label: 'Check-in report to instructor',
    description: 'Send the appearance report once AI analysis of a check-in photo completes.',
  },
  {
    key: 'checkout_email_enabled',
    label: 'Check-out report to instructor',
    description: 'Send the appearance report after checkout photo analysis completes.',
  },
  {
    key: 'weekly_email_enabled',
    label: 'Weekly summary to instructors',
    description: 'Send each instructor their weekly attendance and appearance summary. This is off by default.',
  },
  {
    key: 'only_when_non_compliant',
    label: 'Only email when NON-COMPLIANT',
    description: 'Suppress emails for compliant results so instructors only hear about issues.',
  },
  {
    key: 'reanalyse_enabled',
    label: 'Allow re-analysing a report',
    description: 'Show a Re-analyse control on each check-in and check-out report. Re-running costs a vision call and replaces the existing report, so this is off by default.',
  },
];

const DEFAULTS: NotificationSettings = {
  checkin_email_enabled: true,
  checkout_email_enabled: true,
  weekly_email_enabled: false,
  only_when_non_compliant: false,
  reanalyse_enabled: false,
};

export function Toggle({ id, checked, disabled, onChange }: ToggleProps) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 ${
        checked ? 'bg-indigo-600' : 'bg-slate-300'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
          checked ? 'translate-x-6' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

function NotificationSettings() {
  const [settings, setSettings] = useState<NotificationSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  useEffect(() => {
    let disposed = false;
    const load = async () => {
      try {
        const data = await apiFetch<NotificationSettings>(SETTINGS_PATH);
        if (!disposed) {
          setSettings({ ...DEFAULTS, ...(data || {}) });
          setError('');
        }
      } catch (requestError) {
        if (!disposed && (requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    load();
    return () => {
      disposed = true;
    };
  }, []);

  const updateSetting = async (key: keyof NotificationSettings, value: boolean) => {
    const previous = settings;
    const next = { ...settings, [key]: value };
    // Optimistic update keeps the switch responsive; revert if the save fails.
    setSettings(next);
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const saved = await apiJson<NotificationSettings>(SETTINGS_PATH, { method: 'PUT', body: next });
      setSettings({ ...DEFAULTS, ...(saved || next) });
      setStatus('Saved');
    } catch (requestError) {
      setSettings(previous);
      if ((requestError as { status?: number })?.status !== 401) setError(requestError instanceof Error ? requestError.message : String(requestError));
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="p-8 text-center text-slate-400 font-medium">Loading notification settings…</div>;
  }

  return (
    <div className="max-w-3xl">
      <div className="mb-5">
        <h3 className="text-base font-bold text-slate-800">Email notifications</h3>
        <p className="text-sm text-slate-500 mt-1">
          Control which appearance reports and summaries are emailed to instructors. Changes apply to future deliveries immediately.
        </p>
      </div>

      {error && (
        <div role="alert" className="mb-4 border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700 rounded-md">
          {error}
        </div>
      )}
      {status && !error && (
        <div role="status" className="mb-4 border border-emerald-200 bg-emerald-50 p-3 text-sm font-medium text-emerald-700 rounded-md">
          {status}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-md divide-y divide-slate-100">
        {TOGGLES.map((toggle) => (
          <div key={toggle.key} className="flex items-start justify-between gap-6 p-4">
            <div className="min-w-0">
              <label htmlFor={toggle.key} className="block text-sm font-semibold text-slate-800">
                {toggle.label}
              </label>
              <p className="text-sm text-slate-500 mt-0.5">{toggle.description}</p>
            </div>
            <Toggle
              id={toggle.key}
              checked={Boolean(settings[toggle.key])}
              disabled={saving}
              onChange={(value) => updateSetting(toggle.key, value)}
            />
          </div>
        ))}
      </div>

      <p className="text-xs text-slate-500 mt-4">
        The non-compliant filter applies only to check-in and check-out reports. Weekly summaries are controlled by
        their own switch.
      </p>

      <AccessSettingsSection />
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState<'notifications' | 'identification' | 'colleges' | 'sync' | 'rp'>('notifications');

  const tabClass = (value: string) =>
    `px-4 py-2.5 text-sm font-semibold border-b-2 transition-colors flex items-center gap-2 ${
      tab === value
        ? 'border-indigo-600 text-indigo-700'
        : 'border-transparent text-slate-500 hover:text-slate-800'
    }`;

  return (
    <section className="w-full flex flex-col h-full" aria-labelledby="settings-title">
      <div className="mb-5 shrink-0">
        <h2 id="settings-title" className="text-xl font-bold text-slate-800">Settings</h2>
        <p className="text-sm text-slate-500 mt-1">Manage notifications, identification, institutes, data sync and reporting partners.</p>
      </div>

      <div className="border-b border-slate-200 mb-6 shrink-0" role="tablist" aria-label="Settings sections">
        <div className="flex gap-2">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'notifications'}
            onClick={() => setTab('notifications')}
            className={tabClass('notifications')}
          >
            <Bell size={16} aria-hidden="true" />
            Notifications
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'identification'}
            onClick={() => setTab('identification')}
            className={tabClass('identification')}
          >
            <ScanFace size={16} aria-hidden="true" />
            Identification
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'colleges'}
            onClick={() => setTab('colleges')}
            className={tabClass('colleges')}
          >
            <Building2 size={16} aria-hidden="true" />
            Institutes
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'sync'}
            onClick={() => setTab('sync')}
            className={tabClass('sync')}
          >
            <Database size={16} aria-hidden="true" />
            Sync Data
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'rp'}
            onClick={() => setTab('rp')}
            className={tabClass('rp')}
          >
            <Users size={16} aria-hidden="true" />
            RP
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {tab === 'notifications' && <NotificationSettings />}
        {tab === 'identification' && <IdentificationSettingsSection />}
        {tab === 'colleges' && <CollegeManagement />}
        {tab === 'sync' && <InstructorSyncPanel />}
        {tab === 'rp' && <ReportRecipients />}
      </div>
    </section>
  );
}
