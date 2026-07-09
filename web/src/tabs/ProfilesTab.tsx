import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Play, Square, Trash2, RefreshCw, RotateCw, Plus, Mail as MailIcon } from 'lucide-react';
import {
  profileApi, proxyApi, mailApi, settingsApi as _s,
  type Profile, type AntiDetectConfig, type BrowserSettings, type ProxyRotation,
  type ProxyDto, type MailRecord, CODE_TYPES,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
void _s;

const ANTI_DEFAULT: AntiDetectConfig = {
  osProfile: 'auto', language: 'base-on-ip', webrtc: 'base-on-ip',
  geoip: true, geolocation: 'prompt', maskMediaDevices: true, blockImages: false, screen: 'real',
};
const BROWSER_DEFAULT: BrowserSettings = {
  clearCacheOnStart: true, limitWindowToViewport: true, restorePreviousSession: false,
  startupUrls: [], chromeParams: [], bookmarks: [],
};
const ROTATION_DEFAULT: ProxyRotation = { mode: 'static', pool: { tags: [], liveOnly: true }, rotateOnOpen: false, rotateOnFailure: false };
const SCREEN_OPTS = ['real', '1920x1080', '1680x1050', '1600x900', '1536x864', '1440x900', '1366x768', '1280x720'];

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (v: string) => void }) {
  return (
    <div className="inline-flex rounded-md border bg-muted p-0.5">
      {options.map(([val, lbl]) => (
        <button
          key={val}
          onClick={() => onChange(val)}
          className={cn('rounded px-3 py-1 text-sm transition-colors', value === val ? 'bg-background shadow font-medium' : 'text-muted-foreground hover:text-foreground')}
        >
          {lbl}
        </button>
      ))}
    </div>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}
function ToggleRow({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return <label className="flex items-center gap-3 py-1.5 cursor-pointer"><Switch checked={checked} onCheckedChange={onChange} /><span className="text-sm">{children}</span></label>;
}

export function ProfilesTab({ runSignal }: { runSignal: number }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const refreshRunning = useCallback(async () => {
    try { const r = await profileApi.running(); setRunning(new Set(r.running || [])); } catch {}
  }, []);
  const load = useCallback(async () => {
    try { setProfiles(await profileApi.list()); } catch (e) { toast.error((e as Error).message); }
    refreshRunning();
  }, [refreshRunning]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { refreshRunning(); }, [runSignal, refreshRunning]);

  const selected = profiles.find((p) => p.id === selectedId) || null;

  async function toggleRun(id: string, run: boolean) {
    try {
      if (run) { await profileApi.open(id); toast.success('Đã mở trình duyệt'); }
      else { await profileApi.close(id); toast.success('Đã đóng trình duyệt'); }
      refreshRunning();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function delAll() {
    if (!profiles.length) return;
    if (!confirm(`Xóa TẤT CẢ ${profiles.length} hồ sơ + toàn bộ dữ liệu session trên đĩa? Không thể hoàn tác.`)) return;
    try {
      const r = await profileApi.removeAll();
      toast.success(`Đã xóa ${r.removed} hồ sơ`);
      setSelectedId(null);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="grid grid-cols-[320px_1fr] gap-5">
      <Card className="h-fit">
        <CardHeader className="space-y-2">
          <Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Tạo hồ sơ</Button>
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm text-muted-foreground">
              <b>{profiles.length}</b> hồ sơ · <b>{profiles.filter((p) => running.has(p.id)).length}</b> đang chạy
            </div>
            {!!profiles.length && (
              <Button variant="outline" size="sm" onClick={delAll}><Trash2 className="h-3.5 w-3.5 text-destructive" /> Xóa tất cả</Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {!profiles.length && <div className="text-sm text-muted-foreground">Chưa có hồ sơ nào.</div>}
          {profiles.map((p) => {
            const isRun = running.has(p.id);
            return (
              <div
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cn('rounded-lg border p-3 cursor-pointer transition-colors', p.id === selectedId ? 'border-primary bg-accent' : 'hover:bg-accent/50')}
              >
                <div className="flex items-center gap-2 font-medium">
                  <span className={cn('h-2 w-2 rounded-full', isRun ? 'bg-green-500' : 'bg-slate-300')} />
                  {p.name}
                </div>
                <div className="mt-1.5 flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground truncate">{p.proxy?.server || 'không proxy'}</span>
                  <Button
                    size="sm" variant={isRun ? 'secondary' : 'default'}
                    onClick={(e) => { e.stopPropagation(); toggleRun(p.id, !isRun); }}
                  >
                    {isRun ? <><Square className="h-3 w-3" /> Đóng</> : <><Play className="h-3 w-3" /> Mở</>}
                  </Button>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {selected ? (
        <ProfileConfig
          key={selected.id}
          profile={selected}
          running={running.has(selected.id)}
          onToggleRun={(run) => toggleRun(selected.id, run)}
          onChanged={load}
          onDeleted={() => { setSelectedId(null); load(); }}
        />
      ) : (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Chọn một hồ sơ bên trái để cấu hình, hoặc tạo hồ sơ mới.</CardContent></Card>
      )}

      <CreateProfileDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(id) => { setSelectedId(id); load(); }} />
    </div>
  );
}

function ProfileConfig({ profile, running, onToggleRun, onChanged, onDeleted }: {
  profile: Profile; running: boolean; onToggleRun: (run: boolean) => void; onChanged: () => void; onDeleted: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [anti, setAnti] = useState<AntiDetectConfig>({ ...ANTI_DEFAULT, ...profile.antiDetect });
  const b0 = { ...BROWSER_DEFAULT, ...profile.browser };
  const [browser, setBrowser] = useState({
    clearCacheOnStart: b0.clearCacheOnStart,
    limitWindowToViewport: b0.limitWindowToViewport,
    restorePreviousSession: b0.restorePreviousSession,
    urls: (b0.startupUrls || []).join(' '),
    params: (b0.chromeParams || []).join('\n'),
    bookmarks: (b0.bookmarks || []).map((bm) => `${bm.name}|${bm.url}`).join('\n'),
  });
  const [rot, setRot] = useState<ProxyRotation>({ ...ROTATION_DEFAULT, ...profile.proxyRotation, pool: { ...ROTATION_DEFAULT.pool, ...profile.proxyRotation?.pool } });
  const [poolTags, setPoolTags] = useState((profile.proxyRotation?.pool?.tags || []).join(', '));
  const [curProxy, setCurProxy] = useState(profile.proxy?.server || 'chưa gán');
  const [saved, setSaved] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const firstRun = useRef(true);

  // Mail OTP
  const [mails, setMails] = useState<MailRecord[]>([]);
  const [otpMail, setOtpMail] = useState('');
  const [otpType, setOtpType] = useState('all');
  const [otpResult, setOtpResult] = useState('');
  useEffect(() => { mailApi.list().then((m) => { setMails(m); setOtpMail(m[0]?.id || ''); }).catch(() => {}); }, []);

  const doSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      const startupUrls = browser.urls.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      const chromeParams = browser.params.split('\n').map((s) => s.trim()).filter(Boolean);
      const bookmarks = browser.bookmarks.split('\n').map((s) => s.trim()).filter(Boolean)
        .map((line) => { const [nm, ...rest] = line.split('|'); return { name: nm.trim(), url: rest.join('|').trim() }; })
        .filter((bm) => bm.name && bm.url);
      try {
        await profileApi.update(profile.id, {
          antiDetect: anti,
          browser: { clearCacheOnStart: browser.clearCacheOnStart, limitWindowToViewport: browser.limitWindowToViewport, restorePreviousSession: browser.restorePreviousSession, startupUrls, chromeParams, bookmarks },
          proxyRotation: { mode: rot.mode, pool: { tags: poolTags.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean), liveOnly: true }, rotateOnOpen: rot.rotateOnOpen, rotateOnFailure: rot.rotateOnFailure },
        });
        setSaved(true); setTimeout(() => setSaved(false), 1200);
      } catch (e) { toast.error((e as Error).message); }
    }, 250);
  }, [anti, browser, rot, poolTags, profile.id]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    doSave();
  }, [anti, browser, rot, poolTags, doSave]);

  async function commitRename() {
    const next = name.trim();
    if (!next || next === profile.name) { setName(profile.name); return; }
    try { await profileApi.update(profile.id, { name: next }); toast.success('Đã đổi tên hồ sơ'); onChanged(); }
    catch (e) { setName(profile.name); toast.error((e as Error).message); }
  }
  async function del() {
    if (!confirm(`Xóa hồ sơ "${profile.name}" + toàn bộ dữ liệu session trên đĩa? Không thể hoàn tác.`)) return;
    try { await profileApi.remove(profile.id); toast.success('Đã xóa hồ sơ'); onDeleted(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function rotateProxy() {
    try { const r = await profileApi.rotateProxy(profile.id); setCurProxy(r.proxy || 'chưa gán'); toast.success('Đã xoay proxy: ' + (r.proxy || '—')); onChanged(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function getOtp() {
    if (!otpMail) { toast.error('Chưa có mail trong kho — thêm ở tab Mail'); return; }
    setOtpResult('Đang lấy code...');
    try {
      const r = await mailApi.code(otpMail, otpType);
      setOtpResult(r.code ? `Code: ${r.code} (${r.source})${r.content ? ` — ${r.content}` : ''}` : `Không có code (${r.source})`);
    } catch (e) { setOtpResult(''); toast.error((e as Error).message); }
  }
  const A = <K extends keyof AntiDetectConfig>(k: K, v: AntiDetectConfig[K]) => setAnti((s) => ({ ...s, [k]: v }));

  return (
    <Card>
      <CardContent className="pt-5 space-y-6">
        <div className="flex items-center gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={commitRename} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="max-w-xs font-semibold" />
          {saved && <span className="text-xs text-green-600">✓ Đã lưu</span>}
          <div className="ml-auto flex gap-2">
            <Button variant={running ? 'secondary' : 'default'} onClick={() => onToggleRun(!running)}>{running ? <><Square className="h-4 w-4" /> Đóng</> : <><Play className="h-4 w-4" /> Mở</>}</Button>
            <Button variant="outline" onClick={del}><Trash2 className="h-4 w-4 text-destructive" /> Xóa</Button>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          <div className="space-y-4">
            <h3 className="font-semibold text-sm">Browser trigger</h3>
            <ToggleRow checked={browser.clearCacheOnStart} onChange={(v) => setBrowser((s) => ({ ...s, clearCacheOnStart: v }))}>Xóa Cache tự động</ToggleRow>
            <ToggleRow checked={browser.limitWindowToViewport} onChange={(v) => setBrowser((s) => ({ ...s, limitWindowToViewport: v }))}>Giới hạn kích thước cửa sổ</ToggleRow>
            <ToggleRow checked={browser.restorePreviousSession} onChange={(v) => setBrowser((s) => ({ ...s, restorePreviousSession: v }))}>Khôi phục phiên trước</ToggleRow>
            <Field label="URL khởi động"><Input value={browser.urls} onChange={(e) => setBrowser((s) => ({ ...s, urls: e.target.value }))} placeholder="https://a.com https://b.com" /></Field>
            <Field label="Chrome start parameters"><Textarea value={browser.params} onChange={(e) => setBrowser((s) => ({ ...s, params: e.target.value }))} placeholder="--param1&#10;--param2" /></Field>
            <Field label="Bookmarks"><Textarea value={browser.bookmarks} onChange={(e) => setBrowser((s) => ({ ...s, bookmarks: e.target.value }))} placeholder="name|url" /></Field>
          </div>
          <div className="space-y-4">
            <h3 className="font-semibold text-sm">Anti-detect</h3>
            <Field label="OS đồng bộ"><Segmented value={anti.osProfile} onChange={(v) => A('osProfile', v as any)} options={[['auto', 'Auto'], ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux']]} /></Field>
            <Field label="WebRTC"><Segmented value={anti.webrtc} onChange={(v) => A('webrtc', v as any)} options={[['base-on-ip', 'Base on IP'], ['real', 'Real'], ['disabled', 'Disabled']]} /></Field>
            <Field label="Language"><Segmented value={anti.language} onChange={(v) => A('language', v as any)} options={[['real', 'Real'], ['base-on-ip', 'Base on IP']]} /></Field>
            <Field label="Geo location"><Segmented value={anti.geolocation} onChange={(v) => A('geolocation', v as any)} options={[['prompt', 'Prompt'], ['allow', 'Allow'], ['disabled', 'Disabled']]} /></Field>
            <Field label="Độ phân giải màn hình">
              <Select value={anti.screen} onValueChange={(v) => A('screen', v)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{SCREEN_OPTS.map((r) => <SelectItem key={r} value={r}>{r === 'real' ? 'Real' : r}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <ToggleRow checked={anti.geoip} onChange={(v) => A('geoip', v)}>Timezone + Geo theo IP proxy (geoip)</ToggleRow>
            <ToggleRow checked={anti.maskMediaDevices} onChange={(v) => A('maskMediaDevices', v)}>Ẩn thiết bị Media (camera/mic/loa)</ToggleRow>
            <ToggleRow checked={anti.blockImages} onChange={(v) => A('blockImages', v)}>Tắt tải hình ảnh (nhanh + tiết kiệm băng thông)</ToggleRow>
            <Button variant="outline" size="sm" onClick={() => setAnti({ ...ANTI_DEFAULT })}><RefreshCw className="h-3.5 w-3.5" /> Khôi phục mặc định</Button>
          </div>
        </div>

        <div className="border-t pt-5 space-y-3">
          <h3 className="font-semibold text-sm">Proxy</h3>
          <div className="flex flex-wrap items-start gap-6">
            <Field label="Chế độ proxy"><Segmented value={rot.mode} onChange={(v) => setRot((s) => ({ ...s, mode: v as any }))} options={[['static', 'Tĩnh'], ['pool', 'Pool'], ['gateway', 'Gateway']]} /></Field>
            {rot.mode === 'pool' && (
              <div className="space-y-2">
                <Field label="Tags lọc (pool)"><Input value={poolTags} onChange={(e) => setPoolTags(e.target.value)} placeholder="us, residential" /></Field>
                <ToggleRow checked={!!rot.rotateOnOpen} onChange={(v) => setRot((s) => ({ ...s, rotateOnOpen: v }))}>Xoay proxy mỗi lần mở</ToggleRow>
                <ToggleRow checked={!!rot.rotateOnFailure} onChange={(v) => setRot((s) => ({ ...s, rotateOnFailure: v }))}>Đổi proxy khi lỗi/chết</ToggleRow>
              </div>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            <span className="text-muted-foreground">Proxy hiện tại: <strong className="text-foreground">{curProxy}</strong></span>
            <Button variant="outline" size="sm" disabled={rot.mode === 'static'} onClick={rotateProxy}><RotateCw className="h-3.5 w-3.5" /> Xoay proxy</Button>
          </div>
        </div>

        <div className="border-t pt-5 space-y-3">
          <h3 className="font-semibold text-sm">Lấy OTP từ mail</h3>
          <div className="flex flex-wrap items-center gap-2">
            <Select value={otpMail} onValueChange={setOtpMail}>
              <SelectTrigger className="w-64"><SelectValue placeholder="(kho mail trống)" /></SelectTrigger>
              <SelectContent>{mails.map((m) => <SelectItem key={m.id} value={m.id}>{m.email}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={otpType} onValueChange={setOtpType}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent>{CODE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="outline" onClick={getOtp}><MailIcon className="h-4 w-4" /> Lấy code</Button>
          </div>
          {otpResult && <div className="text-sm text-muted-foreground">{otpResult}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

function CreateProfileDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: (id: string) => void }) {
  const [name, setName] = useState('Profile ' + Math.floor(1000 + Math.random() * 9000));
  const [proxies, setProxies] = useState<ProxyDto[]>([]);
  const [proxyVal, setProxyVal] = useState('');
  const [anti, setAnti] = useState<AntiDetectConfig>({ ...ANTI_DEFAULT });
  const [urls, setUrls] = useState('');

  useEffect(() => { if (open) { proxyApi.list('').then(setProxies).catch(() => {}); setName('Profile ' + Math.floor(1000 + Math.random() * 9000)); setProxyVal(''); setAnti({ ...ANTI_DEFAULT }); setUrls(''); } }, [open]);

  async function create() {
    if (!name.trim()) { toast.error('Nhập tên hồ sơ'); return; }
    let proxy: any;
    if (proxyVal) { try { proxy = JSON.parse(proxyVal); } catch {} }
    try {
      const created = await profileApi.create({
        name: name.trim(),
        proxy,
        antiDetect: anti,
        browser: { ...BROWSER_DEFAULT, startupUrls: urls.split(/\s+/).map((s) => s.trim()).filter(Boolean) },
      });
      toast.success('Đã tạo hồ sơ'); onOpenChange(false); onCreated(created.id);
    } catch (e) { toast.error((e as Error).message); }
  }
  const A = <K extends keyof AntiDetectConfig>(k: K, v: AntiDetectConfig[K]) => setAnti((s) => ({ ...s, [k]: v }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Tạo hồ sơ mới</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <Field label="Tên hồ sơ"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Proxy (từ thư viện)">
            <Select value={proxyVal} onValueChange={setProxyVal}>
              <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
              <SelectContent>
                {proxies.map((px) => (
                  <SelectItem key={px.id} value={JSON.stringify({ server: `${px.type}://${px.host}:${px.port}`, username: px.username, password: px.password })}>
                    {px.display}{px.status === 'live' ? ' ✓' : px.status === 'dead' ? ' ✗' : ''}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="OS đồng bộ"><Segmented value={anti.osProfile} onChange={(v) => A('osProfile', v as any)} options={[['auto', 'Auto'], ['windows', 'Windows'], ['macos', 'macOS'], ['linux', 'Linux']]} /></Field>
            <Field label="WebRTC"><Segmented value={anti.webrtc} onChange={(v) => A('webrtc', v as any)} options={[['base-on-ip', 'IP'], ['real', 'Real'], ['disabled', 'Off']]} /></Field>
          </div>
          <div className="flex gap-6">
            <ToggleRow checked={anti.geoip} onChange={(v) => A('geoip', v)}>GeoIP</ToggleRow>
            <ToggleRow checked={anti.maskMediaDevices} onChange={(v) => A('maskMediaDevices', v)}>Ẩn media</ToggleRow>
            <ToggleRow checked={anti.blockImages} onChange={(v) => A('blockImages', v)}>Tắt ảnh</ToggleRow>
          </div>
          <Field label="URL khởi động"><Input value={urls} onChange={(e) => setUrls(e.target.value)} placeholder="https://..." /></Field>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button>
          <Button onClick={create}>Tạo</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
