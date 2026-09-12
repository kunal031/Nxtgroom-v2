import { lazy, Suspense, useState, useEffect, useCallback } from 'react';
import Sidebar from './components/Sidebar';
import BottomNav from './components/BottomNav';
import Login from './components/Login';
import ResetPassword from './components/ResetPassword';
import BrandedLoader from './components/BrandedLoader';
import {
  currentTabFromLocation,
  publicReportFromLocation,
  pushTabPath,
  recordIdFromLocation,
  replaceTabPath,
  RESET_PASSWORD_PATH,
  type PublicReportRoute,
} from './routes';
import { ChangePasswordModal, ProfileModal } from './components/AccountModals';
import ForgotPasswordDialog from './components/ForgotPasswordDialog';
import {
  apiFetch,
  apiJson,
  apiFetchAllPages,
  clearSession,
  getSessionRole,
  getSessionToken,
  primeCache,
  readStale,
  saveSession,
  SESSION_EXPIRED_EVENT,
} from './api';
import { isElevatedRole, type AttendanceRecord, type CurrentUser, type Instructor, type Role } from './types';

const EvaluateCard = lazy(() => import('./components/EvaluateCard'));
const InstructorDetail = lazy(() => import('./components/InstructorDetail'));
const PublicReportPage = lazy(() => import('./components/PublicReportPage'));
const DailyAttendanceTable = lazy(() => import('./components/DailyAttendanceTable'));
const UserManagement = lazy(() => import('./components/UserManagement'));
const SettingsPage = lazy(() => import('./components/SettingsPage'));
const InstructorManagement = lazy(() => import('./components/InstructorManagement'));
const UnidentifiedQueue = lazy(() => import('./components/UnidentifiedQueue'));
const KioskAttendance = lazy(() => import('./components/KioskAttendance'));

interface SessionState {
  token: string | null;
  role: Role | null;
  email: string | null;
  collegeId: string | null;
  validated: boolean;
  /** Decided by the server; the UI only uses it to hide what it would refuse. */
  canDeleteRecords?: boolean;
  canReanalyse?: boolean;
  /** Whether this account may name an unidentified check-in, and discard one. */
  canIdentify?: boolean;
  /** Whether this tablet's college identifies the instructor from the photo. */
  faceIdentification?: boolean;
  canDeleteCheckout?: boolean;
}

type AccountModal = 'profile' | 'password' | 'forgot' | null;

const ADMIN_TABS = new Set(['boa-management', 'settings', 'instructor-management']);
/**
 * Gated on a capability rather than a role, so a URL typed by hand is refused
 * the same way the navigation hides it.
 */
const IDENTIFY_TABS = new Set(['unidentified']);
const INSTRUCTORS_PATH = '/api/v2/instructors?include_feedback=false';

function initialSession(): SessionState {
  try {
    localStorage.removeItem('nxtwave_token');
    localStorage.removeItem('nxtwave_role');
  } catch { /* Legacy storage may be blocked by browser policy. */ }
  const token = getSessionToken();
  return { token, role: token ? getSessionRole() : null, email: null, collegeId: null, validated: !token };
}

/**
 * Reads a password link token from the URL. The app is served as a single
 * page, so /reset-password?token=... arrives here rather than at a router.
 */
function initialResetToken(): string | null {
  try {
    if (typeof window === 'undefined') return null;
    if (window.location.pathname !== RESET_PASSWORD_PATH) return null;
    const token = new URLSearchParams(window.location.search).get('token');
    return token && token.length <= 512 ? token : null;
  } catch {
    return null;
  }
}

export default function App() {
  // Resolved once: the report route is decided by the URL alone and never
  // changes without a full navigation.
  const [publicReport] = useState<PublicReportRoute | null>(publicReportFromLocation);
  const [session, setSession] = useState(initialSession);
  const [resetToken, setResetToken] = useState<string | null>(initialResetToken);
  // Seed from the URL so a refresh or a shared link opens the right screen.
  const [activeTab, setActiveTab] = useState<string>(currentTabFromLocation);
  const [instructors, setInstructors] = useState<Instructor[]>(() => {
    // Render the attendance list from the last session's data on first paint.
    const cached = readStale<Instructor[]>(INSTRUCTORS_PATH);
    return Array.isArray(cached) ? cached : [];
  });
  const [selectedAttendanceRecord, setSelectedAttendanceRecord] = useState<AttendanceRecord | null>(null);
  const [loadError, setLoadError] = useState('');
  const [sessionCheckError, setSessionCheckError] = useState('');
  const [sessionCheckAttempt, setSessionCheckAttempt] = useState(0);
  const [accountModal, setAccountModal] = useState<AccountModal>(null);

  const handleLogin = (token: string, role: Role) => {
    // validated: false so /me runs. Marking a fresh sign-in as validated
    // skipped it entirely, which left email, college and — once permissions
    // arrived — the delete capability unset until the next full page load.
    setSession({ token, role, email: null, collegeId: null, validated: false });
    setSessionCheckError('');
    setActiveTab('overview');
    replaceTabPath('overview');
  };

  const handleLogout = useCallback(() => {
    void apiJson('/api/v2/auth/logout', { method: 'POST', auth: false }).catch(() => {});
    clearSession();
    setSession({ token: null, role: null, email: null, collegeId: null, validated: true });
    setInstructors([]);
    setSelectedAttendanceRecord(null);
    setActiveTab('overview');
    // Clear any deep link so the next sign-in does not land on a stale screen.
    replaceTabPath('overview');
  }, []);

  useEffect(() => {
    window.addEventListener(SESSION_EXPIRED_EVENT, handleLogout);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, handleLogout);
  }, [handleLogout]);

  useEffect(() => {
    if (!session.token || session.validated) return undefined;
    const controller = new AbortController();
    const validateSession = async () => {
      setSessionCheckError('');
      try {
        const currentUser = await apiFetch<CurrentUser>('/api/v2/auth/me', { signal: controller.signal });
        if (!['SUPER_ADMIN', 'ADMIN', 'BOA'].includes(currentUser?.role)) {
          throw new Error('The server returned an invalid user role.');
        }
        saveSession(session.token as string, currentUser.role);
        setSession({ token: session.token, role: currentUser.role, email: currentUser.email || null, collegeId: currentUser.college_id || null, validated: true, canDeleteRecords: Boolean(currentUser.can_delete_records), canDeleteCheckout: Boolean(currentUser.can_delete_checkout), canReanalyse: Boolean(currentUser.reanalyse_enabled), canIdentify: Boolean(currentUser.can_identify), faceIdentification: Boolean(currentUser.face_identification) });
      } catch (error) {
        if (!controller.signal.aborted && (error as { status?: number })?.status !== 401) setSessionCheckError(error instanceof Error ? error.message : String(error));
      }
    };
    validateSession();
    return () => controller.abort();
  }, [session.token, session.validated, sessionCheckAttempt]);

  const fetchInstructors = useCallback(async ({ signal }: { signal?: AbortSignal } = {}) => {
    if (!session.token || !session.validated) return;
    try {
      const data = await apiFetchAllPages<Instructor>(INSTRUCTORS_PATH, {
        pageSize: 1_000,
        cacheMs: 15_000,
        signal,
      });
      if (signal?.aborted) return;
      // Cache the assembled list so the next load paints without waiting.
      if (Array.isArray(data)) primeCache(INSTRUCTORS_PATH, data);
      setInstructors(Array.isArray(data) ? data : []);
      setLoadError('');
    } catch (error) {
      if (!signal?.aborted && (error as { status?: number })?.status !== 401) setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [session.token, session.validated]);

  useEffect(() => {
    if (!session.token || !session.validated) return undefined;
    const controller = new AbortController();
    fetchInstructors({ signal: controller.signal });
    return () => controller.abort();
  }, [session.token, session.validated, fetchInstructors]);

  /**
   * Moves to a tab and puts its URL in the address bar. The permission and
   * prerequisite redirects below decide the real destination first, so the URL
   * always reflects what is actually rendered.
   */
  const navigate = useCallback((tab: string, { replace = false } = {}) => {
    let target = tab;
    if (ADMIN_TABS.has(tab) && !isElevatedRole(session.role)) target = 'overview';
    else if (IDENTIFY_TABS.has(tab) && !session.canIdentify) target = 'overview';
    // The detail view renders one selected record, so it cannot be opened
    // cold from a URL; send those visits back to the list.
    else if (tab === 'instructor-detail' && !selectedAttendanceRecord) target = 'daily-records';

    setActiveTab(target);
    if (replace || target !== tab) replaceTabPath(target);
    else pushTabPath(target);
  }, [session.role, session.canIdentify, selectedAttendanceRecord]);

  /**
   * Restores the record named in the URL. Opening the detail view from the
   * list hands the record over in memory, but a refresh or a pasted link has
   * only the id, and the page previously rendered its empty state.
   */
  useEffect(() => {
    if (publicReport || resetToken) return undefined;
    if (!session.token || !session.validated) return undefined;
    const recordId = recordIdFromLocation();
    if (!recordId || selectedAttendanceRecord) return undefined;

    const controller = new AbortController();
    apiFetch<AttendanceRecord>(`/api/v2/attendance/${encodeURIComponent(recordId)}`, {
      signal: controller.signal,
    })
      .then((record) => {
        if (!controller.signal.aborted) setSelectedAttendanceRecord(record);
      })
      .catch(() => {
        // A deleted or out-of-scope record falls back to the list rather than
        // leaving the user on a page that can never fill in.
        if (controller.signal.aborted) return;
        setActiveTab('daily-records');
        replaceTabPath('daily-records');
      });
    return () => controller.abort();
  }, [session.token, session.validated, selectedAttendanceRecord, publicReport, resetToken]);

  // Keep the rendered tab in step with Back and Forward.
  useEffect(() => {
    if (publicReport || resetToken) return undefined;
    const onPopState = () => {
      const tab = currentTabFromLocation();
      setActiveTab(
        (ADMIN_TABS.has(tab) && !isElevatedRole(session.role))
          || (IDENTIFY_TABS.has(tab) && !session.canIdentify)
          ? 'overview'
          : tab,
      );
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [session.role, session.canIdentify, publicReport, resetToken]);

  // Normalise the entry URL once the session is known: "/" becomes
  // "/attendance", and a deep link the role cannot open is rewritten rather
  // than left pointing at a screen that is not being shown.
  useEffect(() => {
    // A report or password link is not a tab. Without this guard the effect
    // resolved those paths to Attendance and rewrote the address bar, so the
    // report rendered under the wrong URL and a refresh lost it entirely.
    if (publicReport || resetToken) return;
    if (!session.validated || !session.token) return;
    const tab = currentTabFromLocation();
    const allowed = (ADMIN_TABS.has(tab) && !isElevatedRole(session.role))
      || (IDENTIFY_TABS.has(tab) && !session.canIdentify)
      ? 'overview'
      : tab;
    setActiveTab(allowed);
    // Carry the record id through, or normalising the entry URL would strip
    // it and the detail page would lose the record it was asked for.
    replaceTabPath(allowed, recordIdFromLocation() || undefined);
  }, [session.validated, session.token, session.role, session.canIdentify, publicReport, resetToken]);

  // Checked before everything else, including the session validation gate: the
  // recipient has no account, and an administrator opening the link from their
  // own browser must see the report rather than the dashboard.
  if (publicReport) {
    return (
      <Suspense fallback={<BrandedLoader label="Loading report" />}>
        <PublicReportPage
          token={publicReport.token}
          kind={publicReport.kind}
          date={publicReport.date}
          // Without this the page falls back to its check-in default, so an
          // emailed check-out link rendered the morning's report under a
          // check-out URL. The half is parsed from the path; pass it on.
          half={publicReport.half}
        />
      </Suspense>
    );
  }

  // Checked before the auth gate: the link arrives by email and may be opened
  // in a browser that still holds an old session, which must not hide the form.
  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          // Drop the token from the URL so a refresh or a shared link does not
          // reopen a form whose token is now spent.
          window.history.replaceState(null, '', '/');
          setResetToken(null);
          handleLogout();
        }}
      />
    );
  }

  if (!session.token) {
    return <Login onLogin={handleLogin} />;
  }

  if (!session.validated) {
    // A failure still needs its explanation and the two recovery actions; only
    // the ordinary wait becomes the branded splash.
    if (sessionCheckError) {
      return (
        <main className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
          <div className="rounded-md border border-slate-200 bg-white p-8 text-center shadow-sm max-w-md">
            <h1 className="text-lg font-extrabold text-slate-800">Could not verify your session</h1>
            <p role="alert" className="mt-2 text-sm text-rose-600">{sessionCheckError}</p>
            <div className="mt-5 flex justify-center gap-3">
              <button type="button" onClick={handleLogout} className="rounded-md bg-slate-100 px-4 py-2 text-sm font-bold text-slate-600">Sign out</button>
              <button type="button" onClick={() => setSessionCheckAttempt((value) => value + 1)} className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-bold text-white">Retry</button>
            </div>
          </div>
        </main>
      );
    }
    return <BrandedLoader label="Verifying your session" />;
  }

  return (
    <div className="flex h-[100dvh] bg-[#f8f9fc] font-sans text-gray-800 overflow-hidden relative w-full">
      {/* Desktop keeps the full sidebar; below lg it is hidden entirely in
          favour of the app-style bottom navigation bar. */}
      <Sidebar
        activeTab={activeTab}
        navigate={navigate}
        role={session.role}
        email={session.email}
        canIdentify={session.canIdentify}
        onLogout={handleLogout}
        onOpenProfile={() => setAccountModal('profile')}
        onOpenChangePassword={() => setAccountModal('password')}
      />

      {/* A column, so the bar below is a row of the layout rather than
          something painted over it. main takes what is left after the bar has
          taken its height, which is what keeps the page from ever occupying
          the same pixels — reserving padding instead only adds scrolling room
          at the end, and the content still passes under the bar on its way
          there.

          min-h-0 is what makes that work: without it a flex child refuses to
          shrink below its content and the column grows past the viewport. */}
      <div className="flex flex-1 flex-col min-w-0 min-h-0">
      {/* The shell is exactly the visible viewport — 100dvh, not 100vh, which
          on phones counts the retracting address bar and makes the document
          taller than the screen. Only this element scrolls; overscroll-contain
          stops a list reaching its end from dragging the page behind it. */}
      <main className="flex-1 min-h-0 overflow-auto overscroll-contain p-4 md:p-6 pb-6 flex flex-col w-full">
        {loadError && (
          <div role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm font-medium text-rose-700">
            {loadError}
          </div>
        )}

        <div className="flex flex-col xl:flex-row gap-6 items-start flex-1 min-h-0 w-full">
          <Suspense fallback={<div className="w-full"><BrandedLoader label="Loading screen" /></div>}>
          {/* A face-only college has no selector and no buttons: the camera is
              the whole screen. Everywhere else keeps the card, which is still
              how a college mid-enrolment records attendance. */}
          {activeTab === 'overview' && session.faceIdentification && (
            <div className="w-full h-full">
              <KioskAttendance />
            </div>
          )}

          {activeTab === 'overview' && !session.faceIdentification && (
            <div className="w-full h-full flex justify-center items-start pt-10">
              <div className="w-full max-w-2xl shrink-0">
                <EvaluateCard
                  instructors={instructors}
                  fetchInstructors={fetchInstructors}
                  faceIdentification={session.faceIdentification}
                  onInstructorGenderSaved={(instructorId, gender) => {
                    setInstructors((current) => current.map((instructor) => (
                      instructor._id === instructorId ? { ...instructor, gender } : instructor
                    )));
                  }}
                />
              </div>
            </div>
          )}

          {activeTab === 'daily-records' && (
            <div className="w-full h-full">
              <DailyAttendanceTable
                canBulkDelete={isElevatedRole(session.role)}
                onRowClick={(record) => {
                  // Set the record first: navigate() refuses the detail tab
                  // when nothing is selected and would bounce back to the list.
                  setSelectedAttendanceRecord(record);
                  pushTabPath('instructor-detail', String(record._id));
                  setActiveTab('instructor-detail');
                }}
              />
            </div>
          )}

          {activeTab === 'instructor-detail' && (
            <div className="w-full h-full">
              <InstructorDetail
                record={selectedAttendanceRecord}
                canDelete={session.canDeleteRecords}
                canDeleteCheckout={session.canDeleteCheckout}
                canReanalyse={session.canReanalyse}
                onDeleted={() => setSelectedAttendanceRecord(null)}
                onBack={() => navigate('daily-records')}
              />
            </div>
          )}

          {activeTab === 'boa-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><UserManagement currentRole={session.role} currentEmail={session.email} /></div>
          )}

          {activeTab === 'settings' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><SettingsPage /></div>
          )}

          {/* Gated on the capability, not the role: a BOA granted it is often
              the only person who can recognise a face from their own campus. */}
          {activeTab === 'unidentified' && session.canIdentify && (
            <div className="w-full h-full"><UnidentifiedQueue /></div>
          )}

          {activeTab === 'instructor-management' && isElevatedRole(session.role) && (
            <div className="w-full h-full"><InstructorManagement /></div>
          )}
          </Suspense>
        </div>
      </main>

      <BottomNav
        activeTab={activeTab}
        navigate={navigate}
        role={session.role}
        email={session.email}
        canIdentify={session.canIdentify}
        onLogout={handleLogout}
        onOpenProfile={() => setAccountModal('profile')}
        onOpenChangePassword={() => setAccountModal('password')}
      />
      </div>

      {accountModal === 'profile' && (
        <ProfileModal
          email={session.email}
          role={session.role}
          collegeId={session.collegeId}
          onClose={() => setAccountModal(null)}
        />
      )}

      {accountModal === 'password' && (
        <ChangePasswordModal
          onClose={() => setAccountModal(null)}
          onPasswordChanged={() => {
            setAccountModal(null);
            handleLogout();
          }}
          onForgotPassword={() => setAccountModal('forgot')}
        />
      )}

      {accountModal === 'forgot' && (
        <ForgotPasswordDialog
          open
          initialEmail={session.email || ''}
          onClose={() => setAccountModal(null)}
        />
      )}
    </div>
  );
}
