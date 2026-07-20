import { useState } from 'react';
import { Menu, User, Mail, Settings2, ClipboardCheck } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { LogDrawer } from '@/components/LogDrawer';
import { ProxyTab } from '@/tabs/ProxyTab';
import { ProfilesTab } from '@/tabs/ProfilesTab';
import { MailTab } from '@/tabs/MailTab';
import { ProjectTab } from '@/tabs/ProjectTab';
import { WorkTab } from '@/tabs/WorkTab';

// macOS: chừa lề trái cho traffic lights (hiddenInset). Nhận diện qua UA — chỉ
// ảnh hưởng lề cosmetic nên an toàn cả khi chạy trong trình duyệt lúc dev.
const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent);

export default function App() {
  const [tab, setTab] = useState('proxies');
  const [runSignal, setRunSignal] = useState(0);

  return (
    <Tabs value={tab} onValueChange={setTab} className="flex min-h-screen flex-col pb-12">
      {/* Title bar tùy biến: vùng kéo cửa sổ, tích hợp tên app + tabs (native feel) */}
      <header
        className="drag sticky top-0 z-30 flex h-[52px] items-center gap-3 overflow-x-auto border-b bg-white/90 backdrop-blur"
        style={{ paddingLeft: isMac ? 84 : 16, paddingRight: 16 }}
      >
        <span className="shrink-0 text-sm font-bold tracking-tight">TeamHatDe-Auto</span>
        <TabsList className="no-drag shrink-0">
          <TabsTrigger value="proxies"><Menu className="h-4 w-4" /> Quản lý proxy</TabsTrigger>
          <TabsTrigger value="profiles"><User className="h-4 w-4" /> Hồ sơ</TabsTrigger>
          <TabsTrigger value="mail"><Mail className="h-4 w-4" /> Mail</TabsTrigger>
          <TabsTrigger value="project"><Settings2 className="h-4 w-4" /> Project</TabsTrigger>
          <TabsTrigger value="work"><ClipboardCheck className="h-4 w-4" /> Công việc</TabsTrigger>
        </TabsList>
      </header>

      <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-5">
        <TabsContent value="proxies" className="mt-0"><ProxyTab /></TabsContent>
        <TabsContent value="profiles" className="mt-0"><ProfilesTab runSignal={runSignal} /></TabsContent>
        <TabsContent value="mail" className="mt-0"><MailTab /></TabsContent>
        <TabsContent value="project" className="mt-0"><ProjectTab /></TabsContent>
        <TabsContent value="work" className="mt-0"><WorkTab /></TabsContent>
      </main>

      <LogDrawer onActivity={() => setRunSignal((n) => n + 1)} />
    </Tabs>
  );
}
