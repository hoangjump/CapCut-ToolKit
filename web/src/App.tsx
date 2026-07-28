import { useState } from 'react';
import { Menu, User, Mail, Settings2, ClipboardCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { LogDrawer } from '@/components/LogDrawer';
import { ProxyTab } from '@/tabs/ProxyTab';
import { ProfilesTab } from '@/tabs/ProfilesTab';
import { MailTab } from '@/tabs/MailTab';
import { ProjectTab } from '@/tabs/ProjectTab';
import { WorkTab } from '@/tabs/WorkTab';
import { PaymentViewer } from '@/PaymentViewer';

// macOS: chừa lề trái cho traffic lights (hiddenInset). Nhận diện qua UA — chỉ
// ảnh hưởng lề cosmetic nên an toàn cả khi chạy trong trình duyệt lúc dev.
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

const navigation = [
  { id: 'proxies', label: 'Proxy', description: 'Kho proxy và IP xoay', icon: Menu },
  { id: 'profiles', label: 'Hồ sơ', description: 'Camoufox và phiên chạy', icon: User },
  { id: 'mail', label: 'Mail', description: 'Kho mail và nhà cung cấp', icon: Mail },
  { id: 'project', label: 'Chạy tự động', description: 'Project và flow tự động', icon: Settings2 },
  { id: 'work', label: 'Công việc', description: 'Nhân viên, lương và thanh toán', icon: ClipboardCheck },
] as const;

type NavigationId = (typeof navigation)[number]['id'];

export default function App() {
  const paymentToken = /^\/pay\/([^/]+)\/?$/.exec(window.location.pathname)?.[1];
  if (paymentToken) return <PaymentViewer token={decodeURIComponent(paymentToken)} />;

  const [tab, setTab] = useState<NavigationId>('proxies');
  const [runSignal, setRunSignal] = useState(0);
  const activePage = navigation.find((item) => item.id === tab) ?? navigation[0];

  return (
    <div className="flex min-h-screen flex-col bg-background pb-11">
      {/* Title bar riêng để Electron vẫn kéo cửa sổ được trên Windows/macOS. */}
      <header
        className="drag sticky top-0 z-30 flex h-10 shrink-0 items-center border-b bg-background"
        style={{ paddingLeft: isMac ? 84 : 18, paddingRight: 18 }}
      >
        <span className="text-[13px] font-semibold tracking-tight">TeamHatDe-Capcut-Auto</span>
        <span className="ml-2 text-xs text-muted-foreground">Trung tâm vận hành</span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <aside className="shrink-0 border-b bg-sidebar md:w-56 md:border-b-0 md:border-r">
          <nav className="no-drag flex gap-1 overflow-x-auto p-2 md:flex-col md:p-3" aria-label="Điều hướng chính">
            {navigation.map((item) => {
              const Icon = item.icon;
              const active = tab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTab(item.id)}
                  className={cn(
                    'group flex min-w-max items-center gap-3 rounded-md px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-w-0',
                    active ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                  )}
                >
                  <Icon className={cn('h-4 w-4', active && 'text-primary')} />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{item.label}</span>
                    <span className="hidden truncate text-[11px] text-muted-foreground md:block">{item.description}</span>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="min-w-0 flex-1 overflow-x-hidden">
          <div className="mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 lg:px-8">
            <div className="mb-5 border-b pb-4">
              <h1 className="text-xl font-semibold tracking-tight">{activePage.label}</h1>
              <p className="mt-1 text-sm text-muted-foreground">{activePage.description}</p>
            </div>

            {tab === 'proxies' && <ProxyTab />}
            {tab === 'profiles' && <ProfilesTab runSignal={runSignal} />}
            {tab === 'mail' && <MailTab />}
            {tab === 'project' && <ProjectTab />}
            {tab === 'work' && <WorkTab />}
          </div>
        </main>
      </div>

      <LogDrawer onActivity={() => setRunSignal((n) => n + 1)} />
    </div>
  );
}
