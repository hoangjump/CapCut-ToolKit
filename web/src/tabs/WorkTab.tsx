import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive,
  Check,
  ClipboardCopy,
  Eye,
  Monitor,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Settings,
  Unplug,
  Users,
  WalletCards,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  workApi,
  type PayrollRow,
  type PaymentAdminSession,
  type PaymentControl,
  type SalaryVisibility,
  type WorkEmployee,
  type WorkTask,
  type WorkTelegramConfig,
  type TunnelStatus,
} from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { RemotePaymentScreen } from '@/PaymentViewer';

const formatMoney = (value: number) => `${new Intl.NumberFormat('vi-VN').format(value)}đ`;
const employeeStatus: Record<WorkEmployee['status'], string> = {
  unbound: 'Chờ bind', active: 'Hoạt động', inactive: 'Tạm ngừng', archived: 'Đã lưu trữ',
};
const taskStatus: Record<WorkTask['status'], string> = {
  queued: 'Đang gửi', pending: 'Chờ hoàn thành', completed: 'Hoàn thành', cancelled: 'Đã hủy', failed: 'Gửi lỗi',
};
const paymentStatus: Record<PaymentAdminSession['status'], string> = {
  pending: 'Chờ nhân viên',
  starting: 'Đang mở browser',
  ready: 'Đang thao tác',
  verifying: 'Đang xác minh VIP',
  paid: 'VIP đã xác minh',
  verification_failed: 'Lỗi xác minh VIP',
  expired: 'Hết hạn',
  failed: 'Mở lỗi',
  closed: 'Đã đóng',
};

function statusVariant(status: string): 'success' | 'danger' | 'muted' | 'outline' {
  if (status === 'active' || status === 'completed') return 'success';
  if (status === 'ready' || status === 'paid') return 'success';
  if (status === 'failed' || status === 'verification_failed' || status === 'cancelled') return 'danger';
  if (status === 'inactive' || status === 'archived') return 'muted';
  return 'outline';
}

export function WorkTab() {
  return (
    <Tabs defaultValue="employees">
      <div className="flex flex-col items-start justify-between gap-3 border-b pb-3 md:flex-row md:items-center">
        <div>
          <h2 className="text-lg font-semibold">Công việc nhân viên</h2>
          <p className="text-sm text-muted-foreground">Giao việc theo Telegram topic; task CapCut tự cộng công sau khi xác minh VIP.</p>
        </div>
        <TabsList className="max-w-full overflow-x-auto">
          <TabsTrigger value="employees"><Users className="h-4 w-4" /> Nhân viên</TabsTrigger>
          <TabsTrigger value="tasks"><Send className="h-4 w-4" /> Giao việc</TabsTrigger>
          <TabsTrigger value="payroll"><WalletCards className="h-4 w-4" /> Bảng công</TabsTrigger>
          <TabsTrigger value="payments"><Monitor className="h-4 w-4" /> Thanh toán</TabsTrigger>
          <TabsTrigger value="config"><Settings className="h-4 w-4" /> Telegram</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="employees"><EmployeesPanel /></TabsContent>
      <TabsContent value="tasks"><TasksPanel /></TabsContent>
      <TabsContent value="payroll"><PayrollPanel /></TabsContent>
      <TabsContent value="payments"><PaymentControlPanel /></TabsContent>
      <TabsContent value="config"><TelegramConfigPanel /></TabsContent>
    </Tabs>
  );
}

function EmployeesPanel() {
  const [employees, setEmployees] = useState<WorkEmployee[]>([]);
  const [editing, setEditing] = useState<WorkEmployee | null | undefined>(undefined);
  const load = useCallback(async () => {
    try { setEmployees(await workApi.employees()); } catch (err) { toast.error((err as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(load, 10_000); return () => window.clearInterval(timer); }, [load]);
  const visibleEmployees = employees.filter((employee) => employee.status !== 'archived');

  async function copyBind(employee: WorkEmployee) {
    const command = `/bind ${employee.bindCode}`;
    try { await navigator.clipboard.writeText(command); toast.success(`Đã copy ${command}`); }
    catch { toast.error(`Không copy được. Lệnh: ${command}`); }
  }

  async function action(run: () => Promise<unknown>, success: string) {
    try { await run(); toast.success(success); await load(); } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Danh sách nhân viên</CardTitle>
        <div className="flex gap-2"><Button variant="outline" onClick={load}><RefreshCw /> Làm mới</Button><Button onClick={() => setEditing(null)}><Plus /> Thêm nhân viên</Button></div>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow>
            <TableHead>Nhân viên</TableHead><TableHead>Telegram topic</TableHead><TableHead>Đơn giá</TableHead>
            <TableHead>Hôm nay</TableHead><TableHead>Tháng này</TableHead><TableHead>Trạng thái</TableHead><TableHead className="text-right">Thao tác</TableHead>
          </TableRow></TableHeader>
          <TableBody>
            {!visibleEmployees.length && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">Chưa có nhân viên.</TableCell></TableRow>}
            {visibleEmployees.map((employee) => (
              <TableRow key={employee.id}>
                <TableCell><div className="font-medium">{employee.fullName}</div><div className="text-xs text-muted-foreground">User ID: {employee.telegramUserId || 'chưa bind'}</div></TableCell>
                <TableCell>
                  <div>{employee.telegramTopicId ? `Topic #${employee.telegramTopicId}` : 'Chưa có topic'}</div>
                  {employee.status === 'unbound'
                    ? <button className="mt-1 font-mono text-xs text-primary hover:underline" onClick={() => copyBind(employee)}>/bind {employee.bindCode}</button>
                    : <div className="mt-1 text-xs text-muted-foreground">Đã liên kết</div>}
                </TableCell>
                <TableCell>{formatMoney(employee.defaultUnitRate)}/con</TableCell>
                <TableCell>{employee.totals.todayQuantity} con<div className="text-xs text-muted-foreground">{formatMoney(employee.totals.todayAmount)}</div></TableCell>
                <TableCell>{employee.totals.monthQuantity} con<div className="text-xs text-muted-foreground">{formatMoney(employee.totals.monthAmount)}</div></TableCell>
                <TableCell><Badge variant={statusVariant(employee.status)}>{employeeStatus[employee.status]}</Badge></TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button size="icon" variant="ghost" title="Copy lệnh bind" onClick={() => copyBind(employee)}><ClipboardCopy /></Button>
                    {!employee.telegramTopicId && <Button size="icon" variant="ghost" title="Tạo topic" onClick={() => action(() => workApi.createTopic(employee.id), 'Đã tạo topic')}><Plus /></Button>}
                    {employee.telegramTopicId && <Button size="icon" variant="ghost" title="Gửi thử" onClick={() => action(() => workApi.testTopic(employee.id), 'Đã gửi tin thử')}><Send /></Button>}
                    <Button size="icon" variant="ghost" title="Tạo mã bind mới" onClick={() => action(() => workApi.regenerateBind(employee.id), 'Đã tạo mã bind mới')}><RefreshCw /></Button>
                    <Button size="icon" variant="ghost" title="Sửa" onClick={() => setEditing(employee)}><Pencil /></Button>
                    <Button size="icon" variant="ghost" title="Lưu trữ" onClick={() => {
                      if (confirm(`Lưu trữ nhân viên ${employee.fullName}?`)) void action(() => workApi.archiveEmployee(employee.id), 'Đã lưu trữ nhân viên');
                    }}><Archive /></Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
      {editing !== undefined && <EmployeeDialog employee={editing} onClose={() => setEditing(undefined)} onSaved={load} />}
    </Card>
  );
}

function EmployeeDialog({ employee, onClose, onSaved }: { employee: WorkEmployee | null; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(employee?.fullName ?? '');
  const [rate, setRate] = useState(String(employee?.defaultUnitRate ?? 0));
  const [visibility, setVisibility] = useState<SalaryVisibility>(employee?.salaryVisibility ?? 'topic');
  const [status, setStatus] = useState<'active' | 'inactive'>(employee?.status === 'inactive' ? 'inactive' : 'active');
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return toast.error('Nhập tên nhân viên');
    setSaving(true);
    try {
      if (employee) await workApi.updateEmployee(employee.id, { fullName: name.trim(), defaultUnitRate: Number(rate), salaryVisibility: visibility, status });
      else await workApi.createEmployee({ fullName: name.trim(), defaultUnitRate: Number(rate), salaryVisibility: visibility });
      toast.success(employee ? 'Đã cập nhật nhân viên' : 'Đã tạo nhân viên');
      await onSaved(); onClose();
    } catch (err) { toast.error((err as Error).message); } finally { setSaving(false); }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{employee ? 'Sửa nhân viên' : 'Thêm nhân viên'}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5"><Label>Họ tên</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Đơn giá mỗi con</Label><Input type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Hiển thị tiền công</Label><Select value={visibility} onValueChange={(v) => setVisibility(v as SalaryVisibility)}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="topic">Hiện trong topic</SelectItem><SelectItem value="private">Nhắn riêng nhân viên</SelectItem><SelectItem value="admin-only">Chỉ hiện trên app</SelectItem>
          </SelectContent></Select></div>
          {employee?.telegramUserId && <div className="space-y-1.5"><Label>Trạng thái</Label><Select value={status} onValueChange={(v) => setStatus(v as 'active' | 'inactive')}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem value="active">Hoạt động</SelectItem><SelectItem value="inactive">Tạm ngừng</SelectItem>
          </SelectContent></Select></div>}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Hủy</Button><Button disabled={saving} onClick={save}>{saving ? 'Đang lưu...' : 'Lưu'}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TasksPanel() {
  const [employees, setEmployees] = useState<WorkEmployee[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [employeeId, setEmployeeId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [rate, setRate] = useState('0');
  const [deadline, setDeadline] = useState('');
  const [editing, setEditing] = useState<WorkTask | null>(null);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [employeeRows, taskRows] = await Promise.all([workApi.employees(), workApi.tasks()]);
      setEmployees(employeeRows); setTasks(taskRows);
      if (!employeeId) {
        const first = employeeRows.find((item) => item.status === 'active');
        if (first) { setEmployeeId(first.id); setRate(String(first.defaultUnitRate)); }
      }
    } catch (err) { toast.error((err as Error).message); }
  }, [employeeId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(load, 10_000); return () => window.clearInterval(timer); }, [load]);
  const names = useMemo(() => new Map(employees.map((item) => [item.id, item.fullName])), [employees]);

  async function create() {
    if (!employeeId || !description.trim()) return toast.error('Chọn nhân viên và nhập nội dung');
    setSending(true);
    try {
      await workApi.createTask({ employeeId, description: description.trim(), quantity: Number(quantity), unitRate: Number(rate), deadline: deadline || undefined });
      toast.success('Đã giao việc vào Telegram topic');
      setDescription(''); setQuantity('1'); setDeadline(''); await load();
    } catch (err) { toast.error((err as Error).message); } finally { setSending(false); }
  }

  async function taskAction(run: () => Promise<unknown>, success: string) {
    try { await run(); toast.success(success); await load(); } catch (err) { toast.error((err as Error).message); }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Giao công việc mới</CardTitle></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-[220px_110px_150px_190px_1fr_auto] md:items-end">
          <div className="space-y-1.5"><Label>Nhân viên</Label><Select value={employeeId} onValueChange={(id) => { setEmployeeId(id); const e = employees.find((item) => item.id === id); if (e) setRate(String(e.defaultUnitRate)); }}><SelectTrigger><SelectValue placeholder="Chọn nhân viên" /></SelectTrigger><SelectContent>
            {employees.filter((e) => e.status === 'active').map((e) => <SelectItem key={e.id} value={e.id}>{e.fullName}</SelectItem>)}
          </SelectContent></Select></div>
          <div className="space-y-1.5"><Label>Số lượng</Label><Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Đơn giá/con</Label><Input type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Deadline</Label><Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div>
          <div className="space-y-1.5"><Label>Nội dung</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Mô tả công việc" /></div>
          <Button disabled={sending} onClick={create}><Send /> {sending ? 'Đang gửi...' : 'Giao việc'}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Lịch sử công việc</CardTitle></CardHeader>
        <CardContent><Table>
          <TableHeader><TableRow><TableHead>Nhân viên</TableHead><TableHead>Nội dung</TableHead><TableHead>Sản lượng</TableHead><TableHead>Tiền công</TableHead><TableHead>Trạng thái</TableHead><TableHead className="text-right">Thao tác</TableHead></TableRow></TableHeader>
          <TableBody>
            {!tasks.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Chưa giao công việc nào.</TableCell></TableRow>}
            {tasks.map((task) => <TableRow key={task.id}>
              <TableCell className="font-medium">{names.get(task.employeeId) || task.employeeId.slice(0, 8)}</TableCell>
              <TableCell className="max-w-[360px]"><div className="truncate">{task.description}</div><div className="text-xs text-muted-foreground">{new Date(task.createdAt).toLocaleString('vi-VN')}{task.deadline ? ` · Hạn ${new Date(task.deadline).toLocaleString('vi-VN')}` : ''}{task.source === 'capcut-distribution' ? ' · Chỉ tính khi đúng nhân viên thả ❤️' : ''}</div>{task.deliveryError && <div className="text-xs text-destructive">{task.deliveryError}</div>}</TableCell>
              <TableCell>{task.quantity} con<div className="text-xs text-muted-foreground">{formatMoney(task.unitRate)}/con</div></TableCell>
              <TableCell>{formatMoney(task.amount)}{task.source === 'capcut-distribution' && task.status === 'pending' && <div className="text-xs text-muted-foreground">Chưa cộng</div>}</TableCell>
              <TableCell><Badge variant={statusVariant(task.status)}>{task.source === 'capcut-distribution' && task.status === 'pending' ? 'Chờ ❤️' : taskStatus[task.status]}</Badge></TableCell>
              <TableCell><div className="flex justify-end gap-1">
                {task.status === 'pending' && task.source !== 'capcut-distribution' && <><Button size="icon" variant="ghost" title="Sửa" onClick={() => setEditing(task)}><Pencil /></Button><Button size="icon" variant="ghost" title="Hoàn thành thủ công" onClick={() => taskAction(() => workApi.completeTask(task.id), 'Đã hoàn thành')}><Check /></Button><Button size="icon" variant="ghost" title="Hủy" onClick={() => taskAction(() => workApi.cancelTask(task.id), 'Đã hủy')}><X /></Button></>}
                {task.status === 'completed' && task.source !== 'capcut-distribution' && <Button size="icon" variant="ghost" title="Mở lại" onClick={() => taskAction(() => workApi.reopenTask(task.id), 'Đã mở lại công việc')}><RotateCcw /></Button>}
                {task.status === 'failed' && task.source !== 'capcut-distribution' && <><Button size="icon" variant="ghost" title="Gửi lại" onClick={() => taskAction(() => workApi.retryTask(task.id), 'Đã gửi lại công việc')}><RefreshCw /></Button><Button size="icon" variant="ghost" title="Hủy" onClick={() => taskAction(() => workApi.cancelTask(task.id), 'Đã hủy')}><X /></Button></>}
              </div></TableCell>
            </TableRow>)}
          </TableBody>
        </Table></CardContent>
      </Card>
      {editing && <TaskEditDialog task={editing} onClose={() => setEditing(null)} onSaved={load} />}
    </div>
  );
}

function TaskEditDialog({ task, onClose, onSaved }: { task: WorkTask; onClose: () => void; onSaved: () => Promise<void> }) {
  const [description, setDescription] = useState(task.description);
  const [quantity, setQuantity] = useState(String(task.quantity));
  const [rate, setRate] = useState(String(task.unitRate));
  const [deadline, setDeadline] = useState(task.deadline ? task.deadline.slice(0, 16) : '');
  async function save() {
    try {
      await workApi.updateTask(task.id, { description, quantity: Number(quantity), unitRate: Number(rate), deadline: deadline || undefined });
      toast.success('Đã sửa task và tin Telegram'); await onSaved(); onClose();
    } catch (err) { toast.error((err as Error).message); }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Sửa công việc</DialogTitle></DialogHeader>
    <div className="space-y-4"><div className="space-y-1.5"><Label>Nội dung</Label><Textarea value={description} onChange={(e) => setDescription(e.target.value)} /></div>
      <div className="grid grid-cols-2 gap-4"><div className="space-y-1.5"><Label>Số lượng</Label><Input type="number" min="1" value={quantity} onChange={(e) => setQuantity(e.target.value)} /></div><div className="space-y-1.5"><Label>Đơn giá/con</Label><Input type="number" min="0" value={rate} onChange={(e) => setRate(e.target.value)} /></div></div>
      <div className="space-y-1.5"><Label>Deadline</Label><Input type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} /></div></div>
    <DialogFooter><Button variant="outline" onClick={onClose}>Hủy</Button><Button onClick={save}>Lưu thay đổi</Button></DialogFooter>
  </DialogContent></Dialog>;
}

function PayrollPanel() {
  const [rows, setRows] = useState<PayrollRow[]>([]);
  const load = useCallback(async () => { try { setRows(await workApi.payroll()); } catch (err) { toast.error((err as Error).message); } }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const timer = window.setInterval(load, 10_000); return () => window.clearInterval(timer); }, [load]);
  const total = rows.reduce((sum, row) => sum + row.totals.monthAmount, 0);
  return <Card><CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle className="text-base">Sản lượng và tiền công</CardTitle><div className="text-sm">Tổng tháng này: <strong>{formatMoney(total)}</strong></div></CardHeader><CardContent><Table>
    <TableHeader><TableRow><TableHead>Nhân viên</TableHead><TableHead>Đơn giá mặc định</TableHead><TableHead>Hôm nay</TableHead><TableHead>Tháng này</TableHead><TableHead>Lũy kế</TableHead><TableHead>Đang chờ</TableHead></TableRow></TableHeader>
    <TableBody>{!rows.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Chưa có dữ liệu.</TableCell></TableRow>}{rows.map((row) => <TableRow key={row.employeeId}>
      <TableCell className="font-medium">{row.fullName}</TableCell><TableCell>{formatMoney(row.defaultUnitRate)}/con</TableCell>
      <TableCell>{row.totals.todayQuantity} con<div className="text-xs text-muted-foreground">{formatMoney(row.totals.todayAmount)}</div></TableCell>
      <TableCell>{row.totals.monthQuantity} con<div className="text-xs text-muted-foreground">{formatMoney(row.totals.monthAmount)}</div></TableCell>
      <TableCell>{row.totals.allQuantity} con<div className="text-xs text-muted-foreground">{formatMoney(row.totals.allAmount)}</div></TableCell><TableCell>{row.totals.pendingTasks} task</TableCell>
    </TableRow>)}</TableBody>
  </Table></CardContent></Card>;
}

function PaymentControlPanel() {
  const [control, setControl] = useState<PaymentControl>({ maxSessions: null, running: 0, sessions: [] });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [limitValue, setLimitValue] = useState('6');
  const [savingLimit, setSavingLimit] = useState(false);
  const limitDirty = useRef(false);

  const load = useCallback(async (silent = false) => {
    try {
      const next = await workApi.paymentControl();
      setControl(next);
      if (!limitDirty.current) {
        setLimitEnabled(next.maxSessions !== null);
        if (next.maxSessions !== null) setLimitValue(String(next.maxSessions));
      }
    }
    catch (err) { if (!silent) toast.error((err as Error).message); }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 1_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const selected = selectedId ? control.sessions.find((session) => session.id === selectedId) : undefined;

  async function closeSession(session: PaymentAdminSession) {
    if (!confirm(`Đóng phiên thanh toán của ${session.email}?`)) return;
    try {
      await workApi.closePaymentControlSession(session.id);
      setSelectedId(null);
      await load(true);
      toast.success('Đã đóng browser thanh toán');
    } catch (err) { toast.error((err as Error).message); }
  }

  async function saveLimit() {
    const maxSessions = limitEnabled ? Number(limitValue) : null;
    if (maxSessions !== null && (!Number.isSafeInteger(maxSessions) || maxSessions <= 0)) {
      toast.error('Giới hạn browser phải là số nguyên lớn hơn 0');
      return;
    }
    setSavingLimit(true);
    try {
      const next = await workApi.updatePaymentControl(maxSessions);
      limitDirty.current = false;
      setControl(next);
      setLimitEnabled(next.maxSessions !== null);
      if (next.maxSessions !== null) setLimitValue(String(next.maxSessions));
      toast.success(next.maxSessions === null ? 'Đã tắt giới hạn phiên' : `Đã giới hạn ${next.maxSessions} phiên thanh toán`);
    } catch (err) { toast.error((err as Error).message); }
    finally { setSavingLimit(false); }
  }

  return <>
    <Card>
      <CardHeader className="gap-3 space-y-0 md:flex-row md:items-center md:justify-between">
        <div>
          <CardTitle className="text-base">Bảng điều khiển thanh toán</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">Camoufox chạy trên máy này; màn hình được truyền cho nhân viên qua Cloudflare Tunnel.</p>
        </div>
        <div className="flex w-full flex-wrap items-center justify-between gap-2 md:w-auto md:justify-end">
          <span className="whitespace-nowrap text-sm tabular-nums"><strong>{control.running}</strong>{control.maxSessions === null ? ' browser đang chạy · Không giới hạn' : `/${control.maxSessions} browser đang chạy`}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}><RefreshCw /> Làm mới</Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-end gap-3 border-b pb-4">
          <label className="flex h-9 items-center gap-2 text-sm">
            <Switch checked={limitEnabled} onCheckedChange={(checked) => { limitDirty.current = true; setLimitEnabled(checked); }} />
            Giới hạn số browser
          </label>
          <div className="space-y-1">
            <Label htmlFor="payment-session-limit" className="text-xs text-muted-foreground">Số phiên tối đa</Label>
            <Input
              id="payment-session-limit"
              className="h-9 w-28"
              type="number"
              min="1"
              step="1"
              disabled={!limitEnabled}
              value={limitValue}
              onChange={(event) => { limitDirty.current = true; setLimitValue(event.target.value); }}
            />
          </div>
          <Button size="sm" disabled={savingLimit} onClick={() => void saveLimit()}>
            {savingLimit && <RefreshCw className="animate-spin" />} Lưu giới hạn
          </Button>
          <span className="pb-2 text-xs text-muted-foreground">Phiên đang chạy không bị đóng khi giảm giới hạn.</span>
        </div>
        <div className="overflow-x-auto"><Table>
        <TableHeader><TableRow><TableHead>Nhân viên</TableHead><TableHead>Tài khoản</TableHead><TableHead>Proxy</TableHead><TableHead>Thời gian</TableHead><TableHead>Trạng thái</TableHead><TableHead className="text-right">Thao tác</TableHead></TableRow></TableHeader>
        <TableBody>
          {!control.sessions.length && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">Chưa có phiên thanh toán đang chờ hoặc đang chạy.</TableCell></TableRow>}
          {control.sessions.map((session) => <TableRow key={session.id}>
            <TableCell className="font-medium">{session.employeeName}</TableCell>
            <TableCell><div>{session.email}</div>{session.error && <div className="max-w-[360px] truncate text-xs text-destructive" title={session.error}>{session.error}</div>}</TableCell>
            <TableCell className="max-w-[220px] truncate font-mono text-xs" title={session.proxyServer}>{session.proxyServer || 'Không dùng proxy'}</TableCell>
            <TableCell><div className="text-sm">{new Date(session.createdAt).toLocaleTimeString('vi-VN')}</div><div className="text-xs text-muted-foreground">Hết hạn {new Date(session.expiresAt).toLocaleTimeString('vi-VN')}</div></TableCell>
            <TableCell><Badge variant={statusVariant(session.status)}>{paymentStatus[session.status]}</Badge></TableCell>
            <TableCell><div className="flex justify-end gap-1">
              {session.viewable && <Button size="sm" variant="outline" onClick={() => setSelectedId(session.id)}><Eye /> Xem</Button>}
              {session.status !== 'paid' && <Button size="sm" variant="ghost" onClick={() => void closeSession(session)}>Đóng</Button>}
            </div></TableCell>
          </TableRow>)}
        </TableBody>
        </Table></div>
      </CardContent>
    </Card>
    {selected && <PaymentMonitorDialog session={selected} onClose={() => setSelectedId(null)} onStop={() => closeSession(selected)} />}
  </>;
}

function PaymentMonitorDialog({
  session,
  onClose,
  onStop,
}: {
  session: PaymentAdminSession;
  onClose: () => void;
  onStop: () => Promise<void>;
}) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="w-[96vw] max-w-6xl gap-0 overflow-hidden p-0">
      <DialogHeader className="border-b px-4 py-3 pr-12">
        <DialogTitle className="text-base">Màn hình thanh toán — {session.email}</DialogTitle>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>{session.employeeName}</span><span>{session.proxyServer || 'Không dùng proxy'}</span><span>{paymentStatus[session.status]}</span>
        </div>
      </DialogHeader>
      {session.status === 'ready'
        ? <RemotePaymentScreen
            frameEndpoint={workApi.paymentControlFrameUrl(session.id)}
            streamEndpoint={workApi.paymentControlStreamUrl(session.id)}
            onInput={(input) => workApi.sendPaymentControlInput(session.id, input)}
          />
        : <div className="flex min-h-80 flex-col items-center justify-center gap-3 bg-neutral-950 text-neutral-100">
            {session.status === 'paid' ? <Check className="h-9 w-9 text-green-500" /> : session.status === 'verification_failed' ? <X className="h-9 w-9 text-red-500" /> : <RefreshCw className="h-7 w-7 animate-spin" />}
            <strong>{session.status === 'paid' ? 'VIP đã xác minh và cộng công' : paymentStatus[session.status]}</strong>
            <span className="text-sm text-neutral-400">Browser sẽ tự đóng và giải phóng slot.</span>
          </div>}
      <DialogFooter className="border-t p-3">
        <Button variant="outline" onClick={onClose}>Ẩn popup</Button>
        {!['paid', 'verification_failed'].includes(session.status) && <Button variant="destructive" onClick={() => void onStop()}>Đóng browser</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TelegramConfigPanel() {
  const [config, setConfig] = useState<WorkTelegramConfig | null>(null);
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [paymentPublicUrl, setPaymentPublicUrl] = useState('');
  const [tunnelToken, setTunnelToken] = useState('');
  const [tunnelDomain, setTunnelDomain] = useState('');
  const tunnelDomainDirty = useRef(false);
  const syncConfig = useCallback((value: WorkTelegramConfig) => {
    setConfig(value);
    setChatId(value.chatId);
    setWebhookUrl(value.webhookUrl);
    setPaymentPublicUrl(value.paymentPublicUrl);
    if (!tunnelDomainDirty.current) setTunnelDomain(value.paymentTunnelDomain);
  }, []);
  const load = useCallback(async () => { try { syncConfig(await workApi.config()); } catch (err) { toast.error((err as Error).message); } }, [syncConfig]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => { void workApi.config().then(syncConfig).catch(() => {}); }, 3_000);
    return () => window.clearInterval(timer);
  }, [syncConfig]);

  async function run(action: () => Promise<WorkTelegramConfig>, success: string) {
    try { const value = await action(); syncConfig(value); setToken(''); toast.success(success); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function runTunnel(action: () => Promise<TunnelStatus>, success: string) {
    try { await action(); syncConfig(await workApi.config()); toast.success(success); }
    catch (err) { toast.error((err as Error).message); }
  }

  async function saveTunnelConfig(clear = false) {
    if (!clear && !tunnelToken.trim() && !config?.paymentTunnelHasToken) {
      return toast.error('Nhập Tunnel token lấy từ Cloudflare Zero Trust');
    }
    if (!clear && !tunnelDomain.trim()) return toast.error('Nhập domain đã gắn Public Hostname');
    try {
      if (config?.tunnel && config.tunnel.state !== 'off') await workApi.stopTunnel();
      const value = await workApi.saveConfig(clear
        ? { clearPaymentTunnelToken: true, paymentTunnelDomain: '' }
        : { paymentTunnelToken: tunnelToken.trim() || undefined, paymentTunnelDomain: tunnelDomain });
      tunnelDomainDirty.current = false;
      syncConfig(value);
      setTunnelToken('');
      toast.success(clear ? 'Đã chuyển về Quick Tunnel' : 'Đã lưu Named Tunnel');
    } catch (err) { toast.error((err as Error).message); }
  }

  return <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
    <div className="space-y-4">
      <Card><CardHeader><CardTitle className="text-base">Kết nối bot giao việc</CardTitle></CardHeader><CardContent className="space-y-4">
        <div className="space-y-1.5"><Label>Bot token</Label><Input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={config?.tokenMasked || 'Token từ @BotFather'} /></div>
        <div className="space-y-1.5"><Label>Supergroup chat ID</Label><Input value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-100xxxxxxxxxx" /></div>
        <Button onClick={() => run(() => workApi.saveConfig({ botToken: token || undefined, chatId }), 'Đã lưu cấu hình bot')}>Lưu cấu hình</Button>
        <div className="border-t pt-4"><div className="mb-3 flex items-center gap-2"><span className="text-sm font-medium">Chế độ nhận reaction</span><Badge variant={config?.mode === 'off' ? 'muted' : 'success'}>{config?.mode || 'off'}</Badge>{config?.pollingActive && <span className="text-xs text-muted-foreground">đang chạy</span>}</div>
          <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => run(workApi.enablePolling, 'Đã bật polling cho app Windows')}>Bật polling</Button><Button variant="ghost" onClick={() => run(workApi.disable, 'Đã tắt nhận update')}>Tắt</Button></div>
        </div>
        <div className="border-t pt-4 space-y-2"><Label>Webhook URL công khai</Label><div className="flex gap-2"><Input value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://domain.com" /><Button variant="outline" onClick={() => run(() => workApi.configureWebhook(webhookUrl), 'Đã đăng ký webhook')}>Đăng ký</Button></div></div>
      </CardContent></Card>

      <Card><CardHeader className="flex-row items-center justify-between space-y-0"><CardTitle className="text-base">Link thanh toán cho nhân viên</CardTitle><Badge variant={config?.tunnel?.state === 'online' ? 'success' : config?.tunnel?.state === 'error' ? 'danger' : 'muted'}>{config?.tunnel?.state === 'online' ? 'Đang mở' : config?.tunnel?.state === 'starting' ? 'Đang kết nối' : config?.tunnel?.state === 'error' ? 'Có lỗi' : 'Đang tắt'}</Badge></CardHeader><CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1.5"><Label>Cloudflare Tunnel token</Label><Input type="password" value={tunnelToken} onChange={(e) => setTunnelToken(e.target.value)} placeholder={config?.paymentTunnelTokenMasked || 'Token từ lệnh cài connector'} /></div>
          <div className="space-y-1.5"><Label>Domain thanh toán</Label><Input value={tunnelDomain} onChange={(e) => { tunnelDomainDirty.current = true; setTunnelDomain(e.target.value); }} placeholder="pay.example.com" /></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void saveTunnelConfig()}>Lưu Named Tunnel</Button>
          {config?.paymentTunnelHasToken && <Button variant="ghost" onClick={() => void saveTunnelConfig(true)}>Dùng Quick Tunnel</Button>}
        </div>
        <p className="text-xs text-muted-foreground">Trên Cloudflare Public Hostname, đặt Service thành <code className="text-foreground">{config?.tunnel?.originUrl || 'http://127.0.0.1:61367'}</code>. Đây là Tunnel token, không phải API token.</p>
        <div className="space-y-1.5"><Label>Địa chỉ công khai</Label><Input readOnly value={paymentPublicUrl} placeholder={config?.paymentTunnelDomain || 'App sẽ tự tạo link trycloudflare.com'} /><p className="text-xs text-muted-foreground">App chỉ gửi link Telegram sau khi địa chỉ này truy cập được.</p></div>
        {config?.tunnel?.error && <p className="text-sm text-destructive">{config.tunnel.error}</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={config?.tunnel?.state === 'starting' || config?.tunnel?.state === 'online'} onClick={() => runTunnel(workApi.startTunnel, 'Đã bật link nhân viên')}>{config?.tunnel?.state === 'starting' && <RefreshCw className="animate-spin" />}Bật link nhân viên</Button>
          <Button variant="outline" disabled={!config?.tunnel || config.tunnel.state === 'off'} onClick={() => runTunnel(workApi.stopTunnel, 'Đã tắt link nhân viên')}><Unplug /> Tắt</Button>
        </div>
        <p className="text-xs text-muted-foreground">{config?.tunnel?.autoStart ? 'Tunnel sẽ tự bật ở những lần mở app tiếp theo.' : 'Bấm bật một lần để app ghi nhớ và tự mở tunnel lần sau.'}</p>
      </CardContent></Card>
    </div>
    <Card><CardHeader><CardTitle className="text-base">Thiết lập Telegram</CardTitle></CardHeader><CardContent className="space-y-3 text-sm text-muted-foreground">
      <p>Bot phải là Administrator của Supergroup và có quyền quản lý topic.</p>
      <p>Bản Windows chạy local nên dùng polling. Chỉ dùng webhook khi backend có URL HTTPS công khai.</p>
      <p>Sau khi tạo nhân viên, cho người đó gửi lệnh <code className="rounded bg-muted px-1 py-0.5 text-foreground">/bind MÃ</code> trong đúng topic.</p>
      <p>Nếu chọn nhắn lương riêng, nhân viên cần mở chat riêng với bot và bấm <code className="rounded bg-muted px-1 py-0.5 text-foreground">/start</code>.</p>
      <p>Camoufox thanh toán chỉ mở khi nhân viên bấm “Bắt đầu thanh toán”, chạy ẩn ngay trong app và tự đóng sau 15 phút.</p>
    </CardContent></Card>
  </div>;
}
