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
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
      <Card className="h-fit">
        <CardHeader><Button onClick={() => setCreateOpen(true)}><Plus className="h-4 w-4" /> Tạo project</Button></CardHeader>
        <CardContent className="space-y-1.5">
          {!projects.length && <div className="text-sm text-muted-foreground">Chưa có project nào.</div>}
          {projects.map((p) => {
            const flowLbl = flows.find((f) => f.name === p.flowName)?.label || p.flowName;
            return (
              <div key={p.id} onClick={() => setSelectedId(p.id)} className={cn('rounded-lg border p-3 cursor-pointer transition-colors', p.id === selectedId ? 'border-primary bg-accent' : 'hover:bg-accent/50')}>
                <div className="font-medium">{p.name}</div>
                <div className="text-xs text-muted-foreground">{flowLbl} · {p.profileIds.length} profile</div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {selected ? (
        <ProjectConfig key={selected.id} project={selected} flows={flows} onChanged={load} onDeleted={() => { setSelectedId(null); load(); }} />
      ) : (
        <Card><CardContent className="py-16 text-center text-muted-foreground">Chọn một project bên trái để cấu hình, hoặc tạo project mới.</CardContent></Card>
      )}

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
  const [smsService, setSmsService] = useState(project.smsbowerService || (project.flowName === 'chatgpt-signup' ? 'dr' : ''));
  const [sellProducts, setSellProducts] = useState<SellProduct[]>([]);
  const [sellProductState, setSellProductState] = useState('');
  const [sellSearch, setSellSearch] = useState('outlook');
  const [usePool, setUsePool] = useState(!!project.ephemeralProxyPool);
  const [poolTags, setPoolTags] = useState((project.ephemeralProxyPool?.tags || []).join(', '));
  const [poolLive, setPoolLive] = useState(project.ephemeralProxyPool?.liveOnly !== false);
  const [note, setNote] = useState(project.note || '');
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
      smsbowerService: smsService || undefined,
      ephemeralProxyPool: usePool ? { tags: poolTags.split(',').map((s) => s.trim()).filter(Boolean), liveOnly: poolLive } : null,
      blockImages,
      headless,
      telegramDistribution: workEmployeesLoaded
        ? { enabled: distributionEnabled, allocations: distributionAllocations }
        : undefined,
      note,
    });
    setSaved(true); setTimeout(() => setSaved(false), 1200); onChanged();
  }, [name, flowName, profileIds, mailId, concurrency, ephemeral, mailProvider, buyType, buyQuality, buyProductId, smsService, usePool, poolTags, poolLive, blockImages, headless, distributionEnabled, quotaByEmployee, workEmployees, workEmployeesLoaded, note, project.id, project.name, onChanged]);

  const doSave = useCallback(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void saveNow().catch((error) => toast.error((error as Error).message));
    }, 300);
  }, [saveNow]);

  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    doSave();
  }, [flowName, profileIds, mailId, concurrency, ephemeral, mailProvider, buyType, buyQuality, buyProductId, smsService, usePool, poolTags, poolLive, blockImages, headless, distributionEnabled, quotaByEmployee, note, doSave]);

  useEffect(() => {
    if (workEmployeesLoaded && distributionEnabled && flowName === 'capcut-signin' && String(distributionTotal) !== ephemeral) {
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
  const nameById = (pid: string) => allProfiles.find((p) => p.id === pid)?.name || (pid.length > 10 ? pid.slice(0, 8) + '…' : pid);
  const sellNeedle = sellSearch.trim().toLowerCase();
  const sellFiltered = sellNeedle
    ? sellProducts.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(sellNeedle))
    : sellProducts;

  return (
    <Card>
      <CardContent className="pt-5 space-y-5">
        <div className="flex items-center gap-3">
          <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={doSave} className="max-w-xs font-semibold" />
          {saved && <span className="text-xs text-green-600">✓ Đã lưu</span>}
          <div className="ml-auto flex gap-2">
            <Button onClick={run} disabled={running}><Play className="h-4 w-4" /> {running ? 'Đang chạy...' : 'Chạy'}</Button>
            <Button variant="outline" onClick={del}><Trash2 className="h-4 w-4 text-destructive" /> Xóa</Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Flow</Label>
          <Select value={flowName} onValueChange={(value) => { setFlowName(value); if (value !== 'capcut-signin') setDistributionEnabled(false); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{flows.map((f) => <SelectItem key={f.name} value={f.name}>{f.label}</SelectItem>)}</SelectContent>
          </Select>
          {flowDesc && <p className="text-xs text-muted-foreground">{flowDesc}</p>}
        </div>

        {flowName === 'chatgpt-signup' && (
          <div className="space-y-1.5">
            <Label>Mã service SmsBower <span className="text-muted-foreground font-normal">(flow ChatGPT thuê gmail nhận OTP)</span></Label>
            <Input value={smsService} onChange={(e) => setSmsService(e.target.value)} placeholder="vd: dr" />
            <p className="text-xs text-muted-foreground">Lấy mã còn kho ở tab Mail → "Xem tồn kho gmail". Cần API key SmsBower đã lưu.</p>
          </div>
        )}

        {!distributionEnabled && <div className="space-y-1.5">
          <Label>Chọn profile chạy <span className="text-muted-foreground font-normal">(bỏ trống nếu dùng profile tạm)</span></Label>
          <div className="flex flex-wrap gap-3 rounded-lg border p-3 max-h-40 overflow-auto">
            {allProfiles.length ? allProfiles.map((pr) => (
              <label key={pr.id} className="flex items-center gap-2 text-sm cursor-pointer">
                <Checkbox checked={profileIds.includes(pr.id)} onCheckedChange={() => toggleProfile(pr.id)} /> {pr.name}
              </label>
            )) : <span className="text-sm text-muted-foreground">Chưa có hồ sơ nào.</span>}
          </div>
        </div>}

        {flowName === 'capcut-signin' && (
          <div className="border-t pt-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div><h3 className="font-semibold text-sm">Tự phân phối link CapCut</h3><p className="text-xs text-muted-foreground">Mỗi link thành một task, gửi email + password và nút thanh toán; chỉ thả ❤️ mới tính 1 con.</p></div>
              <Switch checked={distributionEnabled} onCheckedChange={(value) => { setDistributionEnabled(value); if (value) setProfileIds([]); }} />
            </div>
            {distributionEnabled && <>
              <div className="grid gap-2 sm:grid-cols-2">
                {workEmployees.filter((employee) => employee.status !== 'archived').map((employee) => (
                  <div key={employee.id} className="flex items-center gap-3 border p-3">
                    <div className="min-w-0 flex-1"><div className="truncate text-sm font-medium">{employee.fullName}</div><div className="text-xs text-muted-foreground">{employee.status === 'active' ? `${employee.defaultUnitRate.toLocaleString('vi-VN')}đ/con` : 'Chưa active/bind'}</div></div>
                    <Input className="w-24" type="number" min="0" value={quotaByEmployee[employee.id] ?? '0'} onChange={(e) => setQuotaByEmployee((current) => ({ ...current, [employee.id]: e.target.value }))} />
                    <span className="text-xs text-muted-foreground">con</span>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between border-t pt-3 text-sm"><span>Tổng profile sẽ tạo</span><strong>{distributionTotal} con</strong></div>
              <p className="text-xs text-muted-foreground">Quota chạy round-robin theo thứ tự nhân viên. Nhân viên chưa bind sẽ làm run bị từ chối trước khi mở browser.</p>
            </>}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5"><Label>Số lượng cần tạo <span className="text-muted-foreground font-normal">(account — tạo profile tạm rồi tự xóa)</span></Label><Input disabled={distributionEnabled} type="number" min={0} value={ephemeral} onChange={(e) => setEphemeral(e.target.value)} />{distributionEnabled && <p className="text-xs text-muted-foreground">Tự lấy từ tổng quota nhân viên.</p>}</div>
          <div className="space-y-1.5"><Label>Số proxy chạy song song <span className="text-muted-foreground font-normal">(= số luồng)</span></Label><Input type="number" min={1} value={concurrency} onChange={(e) => setConcurrency(e.target.value)} /></div>
        </div>
        {Number(ephemeral) > 0 && Number(concurrency) > 0 && (
          <p className="-mt-2 text-xs text-muted-foreground">
            ≈ {Math.ceil(Number(ephemeral) / Number(concurrency))} account mỗi proxy · mỗi account tự xoay ra IP egress <b>chưa từng reg</b>.
          </p>
        )}

        {flowName !== 'chatgpt-signup' && (
        <>
        <div className="space-y-1.5">
          <Label>Mail (tùy chọn, cho bước OTP)</Label>
          <Select value={mailId || 'none'} onValueChange={(v) => setMailId(v === 'none' ? '' : v)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="none">— Không gán —</SelectItem>{allMails.map((m) => <SelectItem key={m.id} value={m.id}>{m.email}</SelectItem>)}</SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Mua mail — nhà cung cấp <span className="text-muted-foreground font-normal">(khi flow tự mua)</span></Label>
          <Select value={mailProvider} onValueChange={(v) => setMailProvider(v as 'dongvanfb' | 'selltaikhoan')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="dongvanfb">dongvanfb</SelectItem>
              <SelectItem value="selltaikhoan">selltaikhoan (rẻ hơn)</SelectItem>
            </SelectContent>
          </Select>
          {mailProvider === 'dongvanfb' ? (
            <div className="flex gap-2">
              <Select value={buyType || 'none'} onValueChange={(v) => { if (v === 'none') { setBuyType(''); setBuyQuality(''); return; } setBuyType(v); const at = accountTypes.find((t) => String(t.id) === v); setBuyQuality(at ? String(at.quality) : ''); }}>
                <SelectTrigger><SelectValue placeholder={buyType ? `Đã lưu: id ${buyType} (q${buyQuality || '0'})` : '— Không mua tự động —'} /></SelectTrigger>
                <SelectContent><SelectItem value="none">— Không mua tự động —</SelectItem>{accountTypes.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name} — {t.price}đ (q{t.quality})</SelectItem>)}</SelectContent>
              </Select>
              <Button variant="outline" onClick={loadTypes}>Tải danh sách {typeState}</Button>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex gap-2">
                <Input placeholder="Lọc (vd outlook)" value={sellSearch} onChange={(e) => setSellSearch(e.target.value)} />
                <Button variant="outline" onClick={loadSellProducts}>Tải danh sách {sellProductState}</Button>
              </div>
              <Select value={buyProductId || 'none'} onValueChange={(v) => setBuyProductId(v === 'none' ? '' : v)}>
                <SelectTrigger><SelectValue placeholder={buyProductId ? `Đã lưu: id ${buyProductId}` : '— Không mua tự động —'} /></SelectTrigger>
                <SelectContent><SelectItem value="none">— Không mua tự động —</SelectItem>{sellFiltered.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} — {p.price}đ{p.amount != null ? ` (kho ${p.amount})` : ''}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
        </div>
        </>
        )}

        <div className="border-t pt-4 space-y-3">
          <h3 className="font-semibold text-sm">Nguồn IP (proxy)</h3>
          <p className="text-xs text-muted-foreground">
            Dùng proxy <b>có sẵn trong kho</b> (không mua tự động). Với proxy dạng <b>API (mktproxy xoay)</b>: mỗi account tự
            <b> xoay tới IP egress chưa từng reg</b> (lưu ở <code>used-ips.json</code>), tôn trọng cooldown ~60s.
          </p>
          <label className="flex items-center gap-3 cursor-pointer"><Switch checked={usePool} onCheckedChange={setUsePool} /><span className="text-sm">Rút proxy từ kho theo tag <span className="text-muted-foreground">(chỉ proxy Live)</span></span></label>
          <Input disabled={!usePool} value={poolTags} onChange={(e) => setPoolTags(e.target.value)} placeholder="tag proxy, cách nhau dấu phẩy (trống = mọi proxy Live)" />
          <label className="flex items-center gap-3 cursor-pointer"><Switch disabled={!usePool} checked={poolLive} onCheckedChange={setPoolLive} /><span className="text-sm">Chỉ dùng proxy Live</span></label>
        </div>

        <div className="border-t pt-4 space-y-3">
          <h3 className="font-semibold text-sm">Hiệu năng</h3>
          <label className="flex items-center gap-3 cursor-pointer">
            <Switch checked={headless} onCheckedChange={setHeadless} />
            <span className="text-sm">Chạy ẩn (Headless) <span className="text-muted-foreground">(không mở cửa sổ Camoufox)</span></span>
          </label>
          <p className="text-xs text-muted-foreground">Tắt để dùng chế độ mặc định: app desktop hiện cửa sổ, Docker tiếp tục dùng màn hình ảo.</p>
          <label className="flex items-center gap-3 cursor-pointer"><Switch checked={blockImages} onCheckedChange={setBlockImages} /><span className="text-sm">Chặn tải hình ảnh <span className="text-muted-foreground">(chạy nhanh hơn, tiết kiệm băng thông proxy)</span></span></label>
        </div>

        <div className="space-y-1.5"><Label>Ghi chú</Label><Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="(tùy chọn)" /></div>

        {(results || runError) && (
          <div className="border-t pt-4">
            {runError && <div className="text-destructive text-sm">Lỗi: {runError}</div>}
            {results && (
              <>
                <h3 className="font-semibold text-sm mb-2">Kết quả — {results.filter((r) => r.ok).length}/{results.length} thành công</h3>
                <div className="space-y-1">
                  {results.map((r, i) => (
                    <div key={i} className="flex items-center gap-2 text-sm">
                      {r.ok ? <Badge variant="success">✓</Badge> : <Badge variant="danger">✗</Badge>}
                      <span className="font-medium">{nameById(r.profileId)}</span>
                      <span className={r.ok ? 'text-muted-foreground' : 'text-destructive'}>{r.error || 'OK'}</span>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground mt-2">Mở panel Log ở dưới để xem flow dừng ở bước nào.</p>
              </>
            )}
          </div>
        )}

        {distributionRuns[0] && <DistributionStatus run={distributionRuns[0]} onChanged={refreshDistribution} />}
      </CardContent>
    </Card>
  );
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
    <div className="border-t pt-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">Phân phối gần nhất</h3>
        <Badge variant={run.status === 'paused' ? 'muted' : run.status === 'finished' ? 'outline' : 'success'}>{statusLabel}</Badge>
        <Button className="ml-auto" size="sm" variant="outline" onClick={onChanged}><RefreshCw /> Làm mới</Button>
        <Button size="sm" variant="outline" onClick={clearRun}><Trash2 className="text-destructive" /> Xóa đợt cũ</Button>
        {run.status === 'running' && <Button size="sm" variant="outline" onClick={() => action(() => workApi.pauseDistribution(run.id), 'Đã tạm dừng gửi Telegram')}><Pause /> Tạm dừng gửi</Button>}
        {run.status === 'paused' && <Button size="sm" onClick={() => action(() => workApi.resumeDistribution(run.id), 'Đã tiếp tục gửi Telegram')}><Play /> Tiếp tục gửi</Button>}
      </div>
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
    </div>
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
