import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Pause, Play, Plus, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import {
  projectApi, profileApi, mailApi, sellApi, workApi,
  type ProjectRecord, type FlowMeta, type Profile, type MailRecord, type RunResult, type AccountType, type SellProduct, type WorkEmployee, type DistributionRun,
} from '@/lib/api';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';

const PROJECT_MAIL_STATUS: Record<MailRecord['status'], string> = {
  unchecked: 'chưa kiểm tra',
  available: 'sẵn sàng',
  reserved: 'đang giữ',
  used: 'đã dùng',
  failed: 'lỗi',
  disabled: 'tạm tắt',
};

export function ProjectTab() {
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [flows, setFlows] = useState<FlowMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const load = useCallback(async () => {
    try { const [pj, fl] = await Promise.all([projectApi.list(), projectApi.flows()]); setProjects(pj); setFlows(fl); }
    catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const selected = projects.find((p) => p.id === selectedId) || null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Danh sách project</h2>
          <p className="mt-1 text-sm text-muted-foreground">Chọn một project để cấu hình và chạy flow.</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}><Plus /> Tạo project</Button>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="h-fit overflow-hidden rounded-lg border bg-card">
          <div className="border-b px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {projects.length} project
          </div>
          <div className="p-1.5">
          {!projects.length && <div className="text-sm text-muted-foreground">Chưa có project nào.</div>}
          {projects.map((p) => {
            const flowLbl = flows.find((f) => f.name === p.flowName)?.label || p.flowName;
            return (
              <button
                type="button"
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cn('w-full rounded-md px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', p.id === selectedId ? 'bg-accent text-accent-foreground' : 'hover:bg-muted')}
              >
                <span className="block truncate text-sm font-medium">{p.name}</span>
                <span className="mt-0.5 block truncate text-xs text-muted-foreground">{flowLbl} · {p.profileIds.length} profile</span>
              </button>
            );
          })}
          </div>
        </div>

        {selected ? (
          <ProjectConfig key={selected.id} project={selected} flows={flows} onChanged={load} onDeleted={() => { setSelectedId(null); load(); }} />
        ) : (
          <Card><CardContent className="py-20 text-center text-sm text-muted-foreground">Chọn một project bên trái để cấu hình, hoặc tạo project mới.</CardContent></Card>
        )}
      </div>

      <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} flows={flows} onCreated={(id) => { setSelectedId(id); load(); }} />
    </div>
  );
}

function ProjectConfig({ project, flows, onChanged, onDeleted }: { project: ProjectRecord; flows: FlowMeta[]; onChanged: () => void; onDeleted: () => void }) {
  const [name, setName] = useState(project.name);
  const [flowName, setFlowName] = useState(project.flowName);
  const [profileIds, setProfileIds] = useState<string[]>(project.profileIds);
  const [mailId, setMailId] = useState(project.mailId || '');
  const [ephemeral, setEphemeral] = useState(String(project.ephemeralCount || 0));
  const [concurrency, setConcurrency] = useState(String(project.concurrency || 2));
  const [buyType, setBuyType] = useState(project.buyAccountType || '');
  const [buyQuality, setBuyQuality] = useState(project.buyQuality || '');
  const [mailProvider, setMailProvider] = useState<'dongvanfb' | 'selltaikhoan'>(project.mailProvider || 'dongvanfb');
  const [buyProductId, setBuyProductId] = useState(project.buyProductId || '');
  const [mailStrategy, setMailStrategy] = useState<'api-only' | 'api-then-stock' | 'stock-then-api' | 'stock-only'>(project.mailStrategy || 'api-then-stock');
  const [mailStockTags, setMailStockTags] = useState((project.mailStockTags || []).join(', '));
  const [smsService, setSmsService] = useState(project.smsbowerService || (project.flowName === 'chatgpt-signup' ? 'dr' : ''));
  const [sellProducts, setSellProducts] = useState<SellProduct[]>([]);
  const [sellProductState, setSellProductState] = useState('');
  const [sellSearch, setSellSearch] = useState('outlook');
  const [usePool, setUsePool] = useState(!!project.ephemeralProxyPool);
  const [poolTags, setPoolTags] = useState((project.ephemeralProxyPool?.tags || []).join(', '));
  const [poolLive, setPoolLive] = useState(project.ephemeralProxyPool?.liveOnly !== false);
  const [note, setNote] = useState(project.note || '');
  const [teamInviteLink, setTeamInviteLink] = useState(project.teamInviteLink || '');
  const [blockImages, setBlockImages] = useState(!!project.blockImages);
  const [headless, setHeadless] = useState(project.headless === true);
  const [distributionEnabled, setDistributionEnabled] = useState(project.telegramDistribution?.enabled ?? false);
  const [quotaByEmployee, setQuotaByEmployee] = useState<Record<string, string>>(
    Object.fromEntries((project.telegramDistribution?.allocations ?? []).map((item) => [item.employeeId, String(item.quantity)])),
  );
  const [saved, setSaved] = useState(false);

  const [allProfiles, setAllProfiles] = useState<Profile[]>([]);
  const [allMails, setAllMails] = useState<MailRecord[]>([]);
  const [workEmployees, setWorkEmployees] = useState<WorkEmployee[]>([]);
  const [workEmployeesLoaded, setWorkEmployeesLoaded] = useState(false);
  const [distributionRuns, setDistributionRuns] = useState<DistributionRun[]>([]);
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [typeState, setTypeState] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [runError, setRunError] = useState('');

  const saveTimer = useRef<ReturnType<typeof setTimeout>>();
  const firstRun = useRef(true);

  useEffect(() => {
    profileApi.list().then(setAllProfiles).catch(() => {});
    mailApi.list().then(setAllMails).catch(() => {});
    workApi.employees().then((rows) => { setWorkEmployees(rows); setWorkEmployeesLoaded(true); }).catch(() => {});
    workApi.distributions(project.id).then(setDistributionRuns).catch(() => {});
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void mailApi.list().then(setAllMails).catch(() => {}), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const refreshDistribution = useCallback(() => {
    workApi.distributions(project.id).then(setDistributionRuns).catch(() => {});
  }, [project.id]);
  useEffect(() => {
    const timer = window.setInterval(refreshDistribution, 3_000);
    return () => window.clearInterval(timer);
  }, [refreshDistribution]);

  const distributionAllocations = workEmployees
    .filter((employee) => employee.status !== 'archived')
    .map((employee) => ({ employeeId: employee.id, quantity: Number(quotaByEmployee[employee.id] || 0) }))
    .filter((item) => Number.isSafeInteger(item.quantity) && item.quantity >= 0);
  const distributionTotal = distributionAllocations.reduce((sum, item) => sum + item.quantity, 0);

  const saveNow = useCallback(async () => {
    await projectApi.update(project.id, {
      name: name.trim() || project.name, flowName, profileIds, mailId: mailId || undefined,
      concurrency: Number(concurrency) || 2, ephemeralCount: Number(ephemeral) || 0,
      mailProvider,
      buyAccountType: buyType || undefined, buyQuality: buyQuality || undefined,
      buyProductId: buyProductId || undefined,
      mailStrategy,
      mailStockTags: mailStockTags.split(',').map((tag) => tag.trim()).filter(Boolean),
      smsbowerService: smsService || undefined,
      ephemeralProxyPool: usePool ? { tags: poolTags.split(',').map((s) => s.trim()).filter(Boolean), liveOnly: poolLive } : null,
      blockImages,
      headless,
      teamInviteLink: teamInviteLink.trim() || undefined,
      telegramDistribution: workEmployeesLoaded
        ? { enabled: distributionEnabled, allocations: distributionAllocations }
        : undefined,
      note,
    });
    setSaved(true); setTimeout(() => setSaved(false), 1200); onChanged();
  }, [name, flowName, profileIds, mailId, concurrency, ephemeral, mailProvider, buyType, buyQuality, buyProductId, mailStrategy, mailStockTags, smsService, usePool, poolTags, poolLive, blockImages, headless, teamInviteLink, distributionEnabled, quotaByEmployee, workEmployees, workEmployeesLoaded, note, project.id, project.name, onChanged]);

  const doSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveNow().catch((error) => toast.error((error as Error).message));
    }, 300);
  }, [saveNow]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    doSave();
  }, [flowName, profileIds, mailId, concurrency, ephemeral, mailProvider, buyType, buyQuality, buyProductId, mailStrategy, mailStockTags, smsService, usePool, poolTags, poolLive, blockImages, headless, teamInviteLink, distributionEnabled, quotaByEmployee, note, doSave]);

  useEffect(() => {
    if (workEmployeesLoaded && distributionEnabled && (flowName === 'capcut-signin' || flowName === 'capcut-signin-yopmail' || flowName === 'capcut-signin-tempmail') && String(distributionTotal) !== ephemeral) {
      setEphemeral(String(distributionTotal));
    }
  }, [workEmployeesLoaded, distributionEnabled, distributionTotal, flowName, ephemeral]);

  async function loadTypes() {
    setTypeState('(đang tải...)');
    try { const r = await mailApi.accountTypes(); setAccountTypes(r.accountTypes); setTypeState(`(${r.accountTypes.length} loại)`); }
    catch (e) { setTypeState(''); toast.error((e as Error).message); }
  }
  async function loadSellProducts() {
    setSellProductState('(đang tải...)');
    try { const r = await sellApi.products(); setSellProducts(r.products); setSellProductState(`(${r.products.length} sản phẩm)`); }
    catch (e) { setSellProductState(''); toast.error((e as Error).message); }
  }
  function toggleProfile(id: string) {
    setProfileIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }
  async function del() {
    if (!confirm(`Xóa project "${project.name}"?`)) return;
    try { await projectApi.remove(project.id); toast.success('Đã xóa project'); onDeleted(); } catch (e) { toast.error((e as Error).message); }
  }
  async function run() {
    if (distributionEnabled && distributionTotal < 1) return toast.error('Nhập số lượng cần gửi cho ít nhất một nhân viên');
    setRunning(true); setResults(null); setRunError('');
    try {
      clearTimeout(saveTimer.current);
      await saveNow();
      const r = await projectApi.run(project.id);
      setResults(r.results);
      if (r.distributionRunId) refreshDistribution();
      const ok = r.results.filter((x) => x.ok).length;
      toast[ok < r.results.length ? 'error' : 'success'](`Chạy xong: ${ok}/${r.results.length} thành công`);
    } catch (e) { setRunError((e as Error).message); toast.error((e as Error).message); }
    finally { setRunning(false); }
  }

  const flowDesc = flows.find((f) => f.name === flowName)?.description || '';
  // Mọi flow CapCut (mua-mail dongvanfb, yopmail, tempmail) đều tạo account CapCut
  // → đều phân phối được cho nhân viên. Flow mail-tạm (yopmail/tempmail) KHÔNG mua
  // mail nên ẩn phần cấu hình "Mail và OTP".
  const isSelfMail = flowName === 'capcut-signin-yopmail' || flowName === 'capcut-signin-tempmail';
  const isCapcutLogin = flowName === 'capcut-login';
  const isCapcut = flowName === 'capcut-signin' || isSelfMail;
  const nameById = (pid: string) => allProfiles.find((p) => p.id === pid)?.name || (pid.length > 10 ? pid.slice(0, 8) + '…' : pid);
  const sellNeedle = sellSearch.trim().toLowerCase();
  const sellFiltered = sellNeedle
    ? sellProducts.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(sellNeedle))
    : sellProducts;
  const stockTagList = mailStockTags.split(',').map((tag) => tag.trim()).filter(Boolean);
  const availableStock = allMails.filter((mail) => mail.status === 'available' && stockTagList.every((tag) => mail.tags.includes(tag))).length;
  const strategyUsesApi = mailStrategy !== 'stock-only';
  const strategyUsesStock = mailStrategy !== 'api-only';

  return (
    <div className="min-w-0 space-y-4">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={doSave} className="max-w-md font-semibold" aria-label="Tên project" />
            <div className="mt-1 h-4 text-xs text-muted-foreground">{saved ? 'Đã lưu thay đổi' : 'Tự động lưu khi thay đổi cấu hình'}</div>
          </div>
          <div className="flex gap-2">
            <Button onClick={run} disabled={running}><Play /> {running ? 'Đang chạy...' : 'Chạy project'}</Button>
            <Button variant="outline" onClick={del}><Trash2 className="text-destructive" /> Xóa</Button>
          </div>
        </CardContent>
      </Card>

      <ConfigSection title="Cấu hình chính" description="Chọn flow và nguồn hồ sơ dùng cho lần chạy này.">
        <div className="space-y-1.5">
          <Label>Flow</Label>
          <Select value={flowName} onValueChange={(value) => { setFlowName(value); if (value !== 'capcut-signin' && value !== 'capcut-signin-yopmail' && value !== 'capcut-signin-tempmail') setDistributionEnabled(false); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{flows.map((f) => <SelectItem key={f.name} value={f.name}>{f.label}</SelectItem>)}</SelectContent>
          </Select>
          {flowDesc && <p className="text-xs text-muted-foreground">{flowDesc}</p>}
        </div>

        {flowName === 'chatgpt-signup' && (
          <div className="space-y-1.5">
            <Label>Mã service SmsBower <span className="font-normal text-muted-foreground">(flow ChatGPT thuê gmail nhận OTP)</span></Label>
            <Input value={smsService} onChange={(e) => setSmsService(e.target.value)} placeholder="vd: dr" />
            <p className="text-xs text-muted-foreground">Lấy mã còn kho ở tab Mail → "Xem tồn kho gmail". Cần API key SmsBower đã lưu.</p>
          </div>
        )}

        {!distributionEnabled && <div className="space-y-1.5">
          <Label>Chọn profile chạy <span className="font-normal text-muted-foreground">(bỏ trống nếu dùng profile tạm)</span></Label>
          <div className="flex max-h-40 flex-wrap gap-3 overflow-auto rounded-md border p-3">
            {allProfiles.length ? allProfiles.map((pr) => (
              <label key={pr.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <Checkbox checked={profileIds.includes(pr.id)} onCheckedChange={() => toggleProfile(pr.id)} /> {pr.name}
              </label>
            )) : <span className="text-sm text-muted-foreground">Chưa có hồ sơ nào.</span>}
          </div>
        </div>}
      </ConfigSection>

      {isCapcut && (
        <ConfigSection title="Phân phối nhân viên" description="Gửi link CapCut theo quota và tự động ghi nhận khi tài khoản lên VIP.">
          <div className="flex items-center justify-between gap-4 rounded-md border bg-muted/30 p-3">
            <div>
              <div className="text-sm font-medium">Tự phân phối link CapCut</div>
              <p className="mt-0.5 text-xs text-muted-foreground">Telegram chỉ hiển thị email và nút thanh toán. Khi xác minh VIP thành công, bot tự thả tim, cộng công và thông báo kết quả.</p>
            </div>
            <Switch checked={distributionEnabled} onCheckedChange={(value) => { setDistributionEnabled(value); if (value) setProfileIds([]); }} />
          </div>
          {distributionEnabled && <>
            <div className="grid gap-2 sm:grid-cols-2">
              {workEmployees.filter((employee) => employee.status !== 'archived').map((employee) => (
                <div key={employee.id} className="flex items-center gap-3 rounded-md border p-3">
                  <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{employee.fullName}</div><div className="text-xs text-muted-foreground">{employee.status === 'active' ? `${employee.defaultUnitRate.toLocaleString('vi-VN')}đ/con` : 'Chưa active/bind'}</div></div>
                  <Input className="w-20" type="number" min="0" value={quotaByEmployee[employee.id] ?? '0'} onChange={(e) => setQuotaByEmployee((current) => ({ ...current, [employee.id]: e.target.value }))} />
                  <span className="text-xs text-muted-foreground">con</span>
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between border-t pt-3 text-sm"><span>Tổng profile sẽ tạo</span><strong>{distributionTotal} con</strong></div>
            <p className="text-xs text-muted-foreground">Quota chạy round-robin theo thứ tự nhân viên. Nhân viên chưa bind sẽ làm run bị từ chối trước khi mở browser.</p>
          </>}
        </ConfigSection>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <ConfigSection title="Số lượng và luồng chạy" description="Điều chỉnh quy mô của lần chạy.">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1 2xl:grid-cols-2">
            <div className="space-y-1.5"><Label>Số lượng cần tạo</Label><Input disabled={distributionEnabled} type="number" min={0} value={ephemeral} onChange={(e) => setEphemeral(e.target.value)} />{distributionEnabled && <p className="text-xs text-muted-foreground">Tự lấy từ tổng quota nhân viên.</p>}</div>
            <div className="space-y-1.5"><Label>Số luồng mỗi nhân viên</Label><Input type="number" min={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></div>
          </div>
          {Number(concurrency) > 0 && (() => {
            // Số luồng là MỖI NHÂN VIÊN. Có phân phối thì tổng browser song song
            // = luồng × số nhân viên, nên phải nói rõ con số thật.
            const staff = distributionEnabled ? Object.values(quotaByEmployee).filter((q) => Number(q) > 0).length : 0;
            const total = staff > 0 ? Number(concurrency) * staff : Number(concurrency);
            return (
              <p className="text-xs text-muted-foreground">
                {staff > 0
                  ? `${concurrency} luồng × ${staff} nhân viên = ${total} browser chạy song song.`
                  : `${total} browser chạy song song (chưa bật phân phối nên không nhân theo nhân viên).`}
                {Number(ephemeral) > 0 && ` Mỗi account tự xoay tới IP egress chưa từng đăng ký.`}
              </p>
            );
          })()}
        </ConfigSection>

        <ConfigSection title="Hiệu năng" description="Tùy chọn hiển thị và tải tài nguyên browser.">
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3"><span className="text-sm">Chạy ẩn (Headless)<span className="block text-xs text-muted-foreground">Không mở cửa sổ Camoufox</span></span><Switch checked={headless} onCheckedChange={setHeadless} /></label>
          <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3"><span className="text-sm">Chặn tải hình ảnh<span className="block text-xs text-muted-foreground">Chạy nhanh hơn, tiết kiệm băng thông proxy</span></span><Switch checked={blockImages} onCheckedChange={setBlockImages} /></label>
        </ConfigSection>

        {(isCapcut || isSelfMail) && (
        <ConfigSection title="Team CapCut" description="Sau đăng ký, tự join team qua link mời.">
          <Input value={teamInviteLink} onChange={(e) => setTeamInviteLink(e.target.value)} placeholder="https://www.capcut.com/sv2/..." />
          <p className="text-xs text-muted-foreground">Dán link mời từ trang Space. Bỏ trống = không join team. Link có hạn sử dụng và giới hạn thành viên.</p>
        </ConfigSection>
        )}
      </div>

      {flowName !== 'chatgpt-signup' && !isSelfMail && !isCapcutLogin && (
        <ConfigSection title="Mail và OTP" description="Chọn cách mua mail mới và cách dùng kho dự phòng khi nhà cung cấp lỗi hoặc hết hàng.">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Chiến lược cấp mail</Label>
              <Select value={mailStrategy} onValueChange={(value) => setMailStrategy(value as typeof mailStrategy)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="api-then-stock">API trước, kho dự phòng sau</SelectItem>
                  <SelectItem value="stock-then-api">Kho trước, API dự phòng</SelectItem>
                  <SelectItem value="stock-only">Chỉ dùng kho mail</SelectItem>
                  <SelectItem value="api-only">Chỉ mua qua API</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {strategyUsesStock && <div className="space-y-1.5">
              <Label>Tag kho dự phòng</Label>
              <Input value={mailStockTags} onChange={(event) => setMailStockTags(event.target.value)} placeholder="Bỏ trống để dùng mọi mail sẵn sàng" />
              <p className="text-xs text-muted-foreground">Có {availableStock} mail phù hợp đang sẵn sàng.</p>
            </div>}
          </div>
          <div className="space-y-1.5">
            <Label>Mail cố định <span className="font-normal text-muted-foreground">(chỉ dùng cho flow không tự cấp mail)</span></Label>
            <Select value={mailId || 'none'} onValueChange={(v) => setMailId(v === 'none' ? '' : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">— Không gán —</SelectItem>{allMails.map((m) => <SelectItem key={m.id} value={m.id} disabled={m.status === 'reserved' || m.status === 'failed' || m.status === 'disabled'}>{m.email} · {PROJECT_MAIL_STATUS[m.status]}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          {strategyUsesApi && <div className="space-y-1.5">
            <Label>Nhà cung cấp khi flow tự mua mail</Label>
            <Select value={mailProvider} onValueChange={(v) => setMailProvider(v as 'dongvanfb' | 'selltaikhoan')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="dongvanfb">dongvanfb</SelectItem><SelectItem value="selltaikhoan">selltaikhoan (rẻ hơn)</SelectItem></SelectContent>
            </Select>
            {mailProvider === 'dongvanfb' ? (
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={buyType || 'none'} onValueChange={(v) => { if (v === 'none') { setBuyType(''); setBuyQuality(''); return; } setBuyType(v); const at = accountTypes.find((t) => String(t.id) === v); setBuyQuality(at ? String(at.quality) : ''); }}>
                  <SelectTrigger><SelectValue placeholder={buyType ? `Đã lưu: id ${buyType} (q${buyQuality || '0'})` : '— Không mua tự động —'} /></SelectTrigger>
                  <SelectContent><SelectItem value="none">— Không mua tự động —</SelectItem>{accountTypes.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name} — {t.price}đ (q{t.quality})</SelectItem>)}</SelectContent>
                </Select>
                <Button className="shrink-0" variant="outline" onClick={loadTypes}>Tải danh sách {typeState}</Button>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-col gap-2 sm:flex-row"><Input placeholder="Lọc (vd outlook)" value={sellSearch} onChange={(e) => setSellSearch(e.target.value)} /><Button className="shrink-0" variant="outline" onClick={loadSellProducts}>Tải danh sách {sellProductState}</Button></div>
                <Select value={buyProductId || 'none'} onValueChange={(v) => setBuyProductId(v === 'none' ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder={buyProductId ? `Đã lưu: id ${buyProductId}` : '— Không mua tự động —'} /></SelectTrigger>
                  <SelectContent><SelectItem value="none">— Không mua tự động —</SelectItem>{sellFiltered.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} — {p.price}đ{p.amount != null ? ` (kho ${p.amount})` : ''}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            )}
          </div>}
          <p className="text-xs text-muted-foreground">Mail được khóa riêng cho từng profile. Thành công chuyển sang “Đã dùng”; flow lỗi chuyển sang “Lỗi” và không tự cấp lại.</p>
        </ConfigSection>
      )}

      <ConfigSection title="Nguồn IP" description="Chỉ dùng proxy có sẵn trong kho; proxy API tự xoay tới IP chưa từng đăng ký.">
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-md border p-3"><span className="text-sm">Rút proxy từ kho theo tag<span className="block text-xs text-muted-foreground">Bỏ trống tag để dùng mọi proxy phù hợp</span></span><Switch checked={usePool} onCheckedChange={setUsePool} /></label>
        <Input disabled={!usePool} value={poolTags} onChange={(e) => setPoolTags(e.target.value)} placeholder="Các tag proxy, cách nhau bằng dấu phẩy" />
        <label className="flex cursor-pointer items-center gap-3 text-sm"><Switch disabled={!usePool} checked={poolLive} onCheckedChange={setPoolLive} /> Chỉ dùng proxy Live</label>
        <p className="text-xs text-muted-foreground">IP đã dùng được lưu trong <code>used-ips.json</code>; hệ thống tôn trọng cooldown khoảng 60 giây.</p>
      </ConfigSection>

      <ConfigSection title="Ghi chú" description="Thông tin nội bộ cho project.">
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ghi chú tùy chọn" />
      </ConfigSection>

      {(results || runError) && (
        <ConfigSection title="Kết quả lần chạy" description="Mở bảng Log phía dưới để xem chi tiết từng bước.">
          {runError && <div className="text-sm text-destructive">Lỗi: {runError}</div>}
          {results && <div className="space-y-1">
            <div className="mb-2 text-sm font-medium">{results.filter((r) => r.ok).length}/{results.length} thành công</div>
            {results.map((r, i) => <div key={i} className="flex items-center gap-2 text-sm"><Badge variant={r.ok ? 'success' : 'danger'}>{r.ok ? '✓' : '✗'}</Badge><span className="font-medium">{nameById(r.profileId)}</span><span className={r.ok ? 'text-muted-foreground' : 'text-destructive'}>{r.error || 'OK'}</span></div>)}
          </div>}
        </ConfigSection>
      )}

      {distributionRuns[0] && <DistributionStatus run={distributionRuns[0]} onChanged={refreshDistribution} />}
    </div>
  );
}

function ConfigSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return <Card>
    <CardHeader className="border-b">
      <CardTitle className="text-sm">{title}</CardTitle>
      <p className="text-xs text-muted-foreground">{description}</p>
    </CardHeader>
    <CardContent className="space-y-4 pt-4">{children}</CardContent>
  </Card>;
}

function DistributionStatus({ run, onChanged }: { run: DistributionRun; onChanged: () => void }) {
  async function action(request: () => Promise<unknown>, message: string) {
    try { await request(); toast.success(message); onChanged(); } catch (error) { toast.error((error as Error).message); }
  }
  function clearRun() {
    if (!confirm('Xóa đợt phân phối này? Link đang chờ sẽ bị bỏ; task đã gửi, số tim và tiền công vẫn được giữ.')) return;
    void action(() => workApi.clearDistribution(run.id), 'Đã xóa đợt phân phối cũ');
  }
  const statusLabel = run.status === 'running' ? 'Đang gửi' : run.status === 'paused' ? 'Tạm dừng' : 'Đã kết thúc';
  const failedItems = run.items.filter((item) => item.status === 'failed');
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center gap-3 space-y-0 border-b">
        <CardTitle className="text-sm">Phân phối gần nhất</CardTitle>
        <Badge variant={run.status === 'paused' ? 'muted' : run.status === 'finished' ? 'outline' : 'success'}>{statusLabel}</Badge>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={onChanged}><RefreshCw /> Làm mới</Button>
          <Button size="sm" variant="outline" onClick={clearRun}><Trash2 className="text-destructive" /> Xóa đợt cũ</Button>
          {run.status === 'running' && <Button size="sm" variant="outline" onClick={() => action(() => workApi.pauseDistribution(run.id), 'Đã tạm dừng gửi Telegram')}><Pause /> Tạm dừng gửi</Button>}
          {run.status === 'paused' && <Button size="sm" onClick={() => action(() => workApi.resumeDistribution(run.id), 'Đã tiếp tục gửi Telegram')}><Play /> Tiếp tục gửi</Button>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
      <div className="grid grid-cols-2 gap-px overflow-hidden border bg-border text-sm sm:grid-cols-5">
        {[
          ['Đã tạo', `${run.generated}/${run.target}`], ['Đang chờ', run.queued], ['Đã gửi', run.sent], ['Đã tim', run.completed], ['Gửi lỗi', run.failed],
        ].map(([label, value]) => <div key={label} className="bg-background p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-semibold">{value}</div></div>)}
      </div>
      <div className="divide-y border">
        {run.allocationStats.map((allocation) => (
          <div key={allocation.employeeId} className="grid grid-cols-2 gap-2 px-3 py-2 text-sm md:grid-cols-[1fr_auto_auto_auto] md:gap-5">
            <span className="font-medium">{allocation.fullName}</span>
            <span>Gán {allocation.assigned}/{allocation.quantity}</span>
            <span>Đã gửi {allocation.sent}</span>
            <span>Đã tim {allocation.completed}</span>
          </div>
        ))}
      </div>
      {failedItems.length > 0 && <div className="space-y-2">
        <div className="text-sm font-medium text-destructive">Link gửi lỗi</div>
        {failedItems.map((item) => <div key={item.id} className="flex items-center gap-3 border px-3 py-2 text-sm">
          <div className="min-w-0 flex-1"><div className="truncate font-medium">{item.email}</div><div className="truncate text-xs text-destructive">{item.error}</div></div>
          <Button size="sm" variant="outline" onClick={() => action(() => workApi.retryDistributionItem(item.id), 'Đã đưa link về hàng chờ')}><RotateCcw /> Gửi lại</Button>
        </div>)}
      </div>}
      </CardContent>
    </Card>
  );
}

function CreateProjectDialog({ open, onOpenChange, flows, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; flows: FlowMeta[]; onCreated: (id: string) => void }) {
  const [name, setName] = useState('Project mới');
  const [flowName, setFlowName] = useState('');
  useEffect(() => { if (open) { setName('Project mới'); setFlowName(flows[0]?.name || ''); } }, [open, flows]);

  async function create() {
    if (!name.trim()) { toast.error('Nhập tên project'); return; }
    if (!flowName) { toast.error('Chọn flow'); return; }
    try { const created = await projectApi.create({ name: name.trim(), flowName, profileIds: [] }); toast.success('Đã tạo project'); onOpenChange(false); onCreated(created.id); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader><DialogTitle>Tạo project mới</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Tên project</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>Flow</Label>
            <Select value={flowName} onValueChange={setFlowName}>
              <SelectTrigger><SelectValue placeholder="Chọn flow" /></SelectTrigger>
              <SelectContent>{flows.map((f) => <SelectItem key={f.name} value={f.name}>{f.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter className="gap-2"><Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button><Button onClick={create}>Tạo</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
