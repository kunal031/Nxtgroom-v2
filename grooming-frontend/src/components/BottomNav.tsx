import { useEffect, useRef, useState } from 'react';
import {
  LayoutGrid,
  History,
  UserCog,
  UserRoundSearch,
  Users,
  Settings,
  User,
  KeyRound,
  LogOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { isElevatedRole, type Role } from '../types.ts';

interface NavItem {
  tab: string;
  label: string;
  icon: LucideIcon;
  adminOnly?: boolean;
  /**
   * Gated on the identify permission instead of on role. A BOA granted it is
   * usually the only person who can recognise a face from their own campus, so
   * role alone would hide the queue from exactly the right people.
   */
  identifyOnly?: boolean;
}

/**
 * Primary destinations shown in the bar. Anything beyond these lives in the
 * "More" sheet so the bar never scrolls or crowds on small screens.
 */
const PRIMARY_ITEMS: NavItem[] = [
  { tab: 'overview', label: 'Attendance', icon: LayoutGrid },
  { tab: 'daily-records', label: 'Records', icon: History },
  { tab: 'instructor-management', label: 'Instructors', icon: UserCog, adminOnly: true },
];

const OVERFLOW_ITEMS: NavItem[] = [
  // Gated on the identify permission rather than on role, so a BOA who has been
  // granted it still reaches the queue.
  { tab: 'unidentified', label: 'Unidentified', icon: UserRoundSearch, identifyOnly: true },
  { tab: 'boa-management', label: 'Users', icon: Users, adminOnly: true },
  { tab: 'settings', label: 'Settings', icon: Settings, adminOnly: true },
];

interface BottomNavProps {
  activeTab: string;
  navigate: (tab: string) => void;
  role: Role | null;
  email: string | null;
  /** Whether to offer the unidentified queue; see Sidebar for why it is its own flag. */
  canIdentify?: boolean;
  onLogout: () => void;
  onOpenProfile: () => void;
  onOpenChangePassword: () => void;
}

function roleLabel(role: Role | null): string {
  if (role === 'SUPER_ADMIN') return 'Super Admin';
  if (role === 'ADMIN') return 'Admin';
  if (role === 'BOA') return 'BOA';
  return 'Signed in';
}

export default function BottomNav({
  activeTab,
  navigate,
  role,
  email,
  canIdentify = false,
  onLogout,
  onOpenProfile,
  onOpenChangePassword,
}: BottomNavProps) {
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const sheetRef = useRef<HTMLDivElement | null>(null);

  const visible = (items: NavItem[]) =>
    items.filter((item) => {
      if (item.adminOnly && !isElevatedRole(role)) return false;
      if (item.identifyOnly && !canIdentify) return false;
      return true;
    });

  const primary = visible(PRIMARY_ITEMS);
  const overflow = visible(OVERFLOW_ITEMS);

  // Escape closes the sheet, matching the sidebar's account menu behaviour.
  useEffect(() => {
    if (!isSheetOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSheetOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isSheetOpen]);

  const go = (tab: string) => {
    setIsSheetOpen(false);
    navigate(tab);
  };

  const runAction = (action: () => void) => {
    setIsSheetOpen(false);
    action();
  };

  const overflowActive = overflow.some((item) => item.tab === activeTab);
  const displayEmail = email || 'Account';
  const initial = (displayEmail[0] || 'A').toUpperCase();

  const itemClass = (isActive: boolean) =>
    `flex flex-1 flex-col items-center justify-center gap-1 py-2 min-h-[var(--bottom-nav-height)] transition-colors ${
      isActive ? 'text-indigo-600' : 'text-slate-500'
    }`;

  return (
    <>
      {isSheetOpen && (
        <>
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 bg-slate-900/40 z-[45] lg:hidden"
            onClick={() => setIsSheetOpen(false)}
          />
          <div
            ref={sheetRef}
            role="menu"
            aria-label="More navigation options"
            /* Sits directly above the bar; pb accounts for the bar height plus
               the iOS home indicator inset. */
            className="fixed bottom-0 inset-x-0 z-[46] lg:hidden bg-white border-t border-slate-200 rounded-t-xl pb-[calc(env(safe-area-inset-bottom)+var(--bottom-nav-height)+0.25rem)] shadow-[0_-4px_24px_rgba(0,0,0,0.08)]"
          >
            <div className="flex items-center gap-3 px-4 py-4 border-b border-slate-100">
              <span
                aria-hidden="true"
                className="w-10 h-10 shrink-0 rounded-md bg-indigo-600 text-white flex items-center justify-center text-sm font-bold"
              >
                {initial}
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-slate-800 truncate">{displayEmail}</span>
                <span className="block text-xs font-medium text-slate-500">{roleLabel(role)}</span>
              </span>
            </div>

            {overflow.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.tab}
                  type="button"
                  role="menuitem"
                  onClick={() => go(item.tab)}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium border-b border-slate-100 transition-colors ${
                    activeTab === item.tab ? 'text-indigo-700 bg-indigo-50' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <Icon size={18} aria-hidden="true" />
                  {item.label}
                </button>
              );
            })}

            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onOpenProfile)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50 border-b border-slate-100 transition-colors"
            >
              <User size={18} aria-hidden="true" />
              Profile
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onOpenChangePassword)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-slate-700 hover:bg-slate-50 border-b border-slate-100 transition-colors"
            >
              <KeyRound size={18} aria-hidden="true" />
              Change Password
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => runAction(onLogout)}
              className="w-full flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-rose-600 hover:bg-rose-50 transition-colors"
            >
              <LogOut size={18} aria-hidden="true" />
              Logout
            </button>
          </div>
        </>
      )}

      <nav
        aria-label="Primary"
        className="shrink-0 lg:hidden bg-white border-t border-slate-300 flex items-stretch pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(15,23,42,0.10)]"
      >
        {primary.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.tab;
          return (
            <button
              key={item.tab}
              type="button"
              onClick={() => go(item.tab)}
              aria-current={isActive ? 'page' : undefined}
              className={itemClass(isActive)}
            >
              <Icon size={20} aria-hidden="true" />
              <span className="text-[11px] font-semibold leading-none">{item.label}</span>
            </button>
          );
        })}

        <button
          type="button"
          onClick={() => setIsSheetOpen((open) => !open)}
          aria-haspopup="menu"
          aria-expanded={isSheetOpen}
          aria-label="Open account and more options"
          className={itemClass(isSheetOpen || overflowActive)}
        >
          <span
            aria-hidden="true"
            className={`flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold ${
              isSheetOpen || overflowActive ? 'bg-indigo-600 text-white' : 'bg-slate-200 text-slate-600'
            }`}
          >
            {initial}
          </span>
          <span className="text-[11px] font-semibold leading-none">Profile</span>
        </button>
      </nav>
    </>
  );
}
