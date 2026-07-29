import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Ban, CheckCircle2, RefreshCw, Mail as MailIcon, Inbox, Trash2, Upload } from 'lucide-react';
import {
  mailApi, sellApi, CODE_TYPES,
  type MailRecord, type AccountType, type MailMessage, type SellProduct,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DialogFooter } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';

const MAIL_STATUS_LABEL: Record<MailRecord['status'], string> = {
  unchecked: 'Chưa kiểm tra',
  available: 'Sẵn sàng',
  reserved: 'Đang giữ',
  used: 'Đã dùng',
  failed: 'Lỗi',
  disabled: 'Tạm tắt',
};

const MAIL_SOURCE_LABEL: Record<MailRecord['source'], string> = {
  manual: 'Nhập kho',
  dongvanfb: 'dongvanfb',
  selltaikhoan: 'selltaikhoan',
};

function mailStatusVariant(status: MailRecord['status']): 'success' | 'danger' | 'muted' | 'outline' | 'secondary' {
  if (status === 'available') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'used') return 'secondary';
  if (status === 'disabled') return 'muted';
  return 'outline';
}

export function MailTab() {
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [typeState, setTypeState] = useState('');
  const [buyType, setBuyType] = useState('');
  const [importOpen, setImportOpen] = useState(false);
  // selltaikhoan (nhà cung cấp mail thứ 2)
  const [buyProvider, setBuyProvider] = useState<'dongvanfb' | 'selltaikhoan'>('dongvanfb');
  const [sellProducts, setSellProducts] = useState<SellProduct[]>([]);
  const [sellProductState, setSellProductState] = useState('');
  const [sellSearch, setSellSearch] = useState('outlook');
  const [buyProductId, setBuyProductId] = useState('');
  // smsbower (thuê gmail nhận OTP theo service — cho flow chatgpt)
  const [mails, setMails] = useState<MailRecord[]>([]);
  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | MailRecord['status']>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [checking, setChecking] = useState(false);
  const [page, setPage] = useState(1);
  const [codeType, setCodeType] = useState<Record<string, string>>({});
  const [codeResult, setCodeResult] = useState<Record<string, string>>({});
  const [inbox, setInbox] = useState<{ open: boolean; email: string; loading: boolean; msgs: MailMessage[]; error?: string }>({ open: false, email: '', loading: false, msgs: [] });

  const loadMails = useCallback(async () => {
    try {
      const rows = await mailApi.list();
      setMails(rows);
      setSelected((current) => new Set([...current].filter((id) => rows.some((mail) => mail.id === id && mail.status !== 'reserved'))));
    } catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void loadMails(); }, []);
  useEffect(() => {
    const timer = window.setInterval(() => void loadMails(), 5_000);
    return () => window.clearInterval(timer);
  }, [loadMails]);

  async function loadTypes() {
    setTypeState('(đang tải...)');
    try { const r = await mailApi.accountTypes(); setAccountTypes(r.accountTypes); setTypeState(`(${r.accountTypes.length} loại)`); }
    catch (e) { setTypeState(''); toast.error((e as Error).message); }
  }
  async function buy() {
    const at = accountTypes.find((t) => String(t.id) === buyType);
    if (!at) { toast.error('Chọn loại mail (bấm "Tải danh sách" trước)'); return; }
    if (!confirm(`Mua "${at.name}"? Thao tác này tốn tiền.`)) return;
    try {
      const r = await mailApi.buy({ accountType: String(at.id), quality: String(at.quality) });
      toast.success(`Mua ok: ${r.bought} mail, thêm ${r.added}. Số dư ${r.balance ?? '—'}`);
      loadMails();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function loadSellProducts() {
    setSellProductState('(đang tải...)');
    try { const r = await sellApi.products(); setSellProducts(r.products); setSellProductState(`(${r.products.length} sản phẩm)`); }
    catch (e) { setSellProductState(''); toast.error((e as Error).message); }
  }
  async function buySell() {
    const p = sellProducts.find((x) => x.id === buyProductId);
    if (!p) { toast.error('Chọn sản phẩm (bấm "Tải danh sách" trước)'); return; }
    if (!confirm(`Mua "${p.name}" (${p.price}đ)? Thao tác này tốn tiền.`)) return;
    try {
      const r = await sellApi.buy({ productId: p.id, amount: 1 });
      toast.success(`Mua ok: ${r.bought} mail, thêm ${r.added}.`);
      loadMails();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function checkMails(ids: string[]) {
    if (!ids.length) return toast.error('Chọn ít nhất một mail');
    setChecking(true);
    try {
      const result = await mailApi.check(ids);
      toast.success(`Đã kiểm tra ${result.checked}: ${result.available} dùng được, ${result.failed} lỗi`);
      await loadMails();
    } catch (error) { toast.error((error as Error).message); }
    finally { setChecking(false); }
  }

  async function setMailStatus(status: MailRecord['status']) {
    const ids = [...selected];
    if (!ids.length) return toast.error('Chọn ít nhất một mail');
    try {
      const result = await mailApi.setStatus(ids, status);
      toast.success(`Đã cập nhật ${result.updated} mail`);
      setSelected(new Set());
      await loadMails();
    } catch (error) { toast.error((error as Error).message); }
  }
  async function getCode(id: string) {
    const type = codeType[id] || 'all';
    setCodeResult((s) => ({ ...s, [id]: 'Đang lấy code...' }));
    try {
      const r = await mailApi.code(id, type);
      setCodeResult((s) => ({ ...s, [id]: r.code ? `Code: ${r.code} (${r.source})` : `Không có code (${r.source})` }));
    } catch (e) { setCodeResult((s) => ({ ...s, [id]: '' })); toast.error((e as Error).message); }
  }
  async function del(id: string) {
    try { await mailApi.remove(id); setSelected((current) => { const next = new Set(current); next.delete(id); return next; }); toast.success('Đã xóa mail'); loadMails(); } catch (e) { toast.error((e as Error).message); }
  }
  /** Xoá SẠCH kho mail. Gõ lại số lượng để xác nhận — hộp confirm thường quá dễ
   *  bấm nhầm cho một thao tác không hoàn tác được. */
  async function delAll() {
    const total = mails.length;
    if (!total) return toast.error('Kho mail đang trống');
    const answer = prompt(`Xoá SẠCH ${total} mail trong kho? Không hoàn tác được.\nGõ ${total} để xác nhận:`);
    if (answer === null) return;
    if (answer.trim() !== String(total)) return toast.error('Số không khớp, đã huỷ');
    try {
      const result = await mailApi.removeMany();
      toast.success(`Đã xoá ${result.removed} mail`);
      setSelected(new Set());
      void loadMails();
    } catch (e) { toast.error((e as Error).message); }
  }

  async function delSelected() {
    const ids = [...selected];
    if (!ids.length || !confirm(`Xóa ${ids.length} mail đã chọn?`)) return;
    try { const result = await mailApi.removeMany(ids); toast.success(`Đã xóa ${result.removed} mail`); setSelected(new Set()); loadMails(); }
    catch (error) { toast.error((error as Error).message); }
  }
  async function openInbox(m: MailRecord) {
    setInbox({ open: true, email: m.email, loading: true, msgs: [] });
    try { const r = await mailApi.messages(m.id); setInbox({ open: true, email: m.email, loading: false, msgs: r.messages || [] }); }
    catch (e) { setInbox({ open: true, email: m.email, loading: false, msgs: [], error: (e as Error).message }); }
  }

  const PAGE_SIZE = 50;
  const needle = q.trim().toLowerCase();
  const filtered = mails.filter((mail) => {
    if (statusFilter !== 'all' && mail.status !== statusFilter) return false;
    return !needle || `${mail.email} ${mail.provider ?? ''} ${mail.source} ${mail.tags.join(' ')}`.toLowerCase().includes(needle);
  });
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageMails = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);
  const selectablePageMails = pageMails.filter((mail) => mail.status !== 'reserved');
  const pageSelected = selectablePageMails.length > 0 && selectablePageMails.every((mail) => selected.has(mail.id));
  const availableCount = mails.filter((mail) => mail.status === 'available').length;
  const failedCount = mails.filter((mail) => mail.status === 'failed').length;

  const sellNeedle = sellSearch.trim().toLowerCase();
  const sellFiltered = sellNeedle
    ? sellProducts.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(sellNeedle))
    : sellProducts;

  return (
    <div className="grid grid-cols-1 gap-4 2xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Mua mail</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label>Nhà cung cấp</Label>
            <Select value={buyProvider} onValueChange={(v) => setBuyProvider(v as 'dongvanfb' | 'selltaikhoan')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dongvanfb">dongvanfb</SelectItem>
                <SelectItem value="selltaikhoan">selltaikhoan (rẻ hơn)</SelectItem>
              </SelectContent>
            </Select>
            {buyProvider === 'dongvanfb' ? (
              <>
                <Label>Loại mail <span className="text-muted-foreground font-normal">{typeState}</span></Label>
                <div className="flex gap-2">
                  <Select value={buyType} onValueChange={setBuyType}>
                    <SelectTrigger><SelectValue placeholder='— Bấm "Tải danh sách" —' /></SelectTrigger>
                    <SelectContent>{accountTypes.map((t) => <SelectItem key={t.id} value={String(t.id)}>{t.name} — {t.price}đ (q{t.quality})</SelectItem>)}</SelectContent>
                  </Select>
                  <Button variant="outline" onClick={loadTypes}>Tải danh sách</Button>
                </div>
                <Button onClick={buy}>Mua (tốn tiền)</Button>
              </>
            ) : (
              <>
                <Label>Sản phẩm <span className="text-muted-foreground font-normal">{sellProductState}</span></Label>
                <div className="flex gap-2">
                  <Input placeholder="Lọc (vd outlook)" value={sellSearch} onChange={(e) => setSellSearch(e.target.value)} />
                  <Button variant="outline" onClick={loadSellProducts}>Tải danh sách</Button>
                </div>
                <Select value={buyProductId} onValueChange={setBuyProductId}>
                  <SelectTrigger><SelectValue placeholder='— Bấm "Tải danh sách" —' /></SelectTrigger>
                  <SelectContent>{sellFiltered.map((p) => <SelectItem key={p.id} value={p.id}>{p.name} — {p.price}đ{p.amount != null ? ` (kho ${p.amount})` : ''}</SelectItem>)}</SelectContent>
                </Select>
                <Button onClick={buySell}>Mua (tốn tiền)</Button>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 border-b">
          <div className="mr-auto">
            <CardTitle>Kho mail {mails.length ? `(${mails.length})` : ''}</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{availableCount} sẵn sàng · {failedCount} lỗi · tự cập nhật mỗi 5 giây</p>
          </div>
          <Input
            placeholder="Tìm email / provider..."
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            className="max-w-56"
          />
          <Select value={statusFilter} onValueChange={(value) => { setStatusFilter(value as typeof statusFilter); setPage(1); }}>
            <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">Mọi trạng thái</SelectItem>{Object.entries(MAIL_STATUS_LABEL).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent>
          </Select>
          <Button variant="outline" onClick={() => void loadMails()}><RefreshCw /> Tải lại</Button>
          <Button onClick={() => setImportOpen(true)}><Upload /> Import mail</Button>
          <Button variant="ghost" className="text-destructive" onClick={() => void delAll()}><Trash2 /> Xoá tất cả</Button>
        </CardHeader>
        <CardContent>
          {selected.size > 0 && <div className="mb-3 flex flex-wrap items-center gap-2 border-b pb-3">
            <span className="mr-1 text-sm font-medium">Đã chọn {selected.size}</span>
            <Button size="sm" variant="outline" disabled={checking} onClick={() => void checkMails([...selected])}><RefreshCw className={checking ? 'animate-spin' : ''} /> Kiểm tra</Button>
            <Button size="sm" variant="outline" onClick={() => void setMailStatus('available')}><CheckCircle2 /> Đưa vào kho</Button>
            <Button size="sm" variant="outline" onClick={() => void setMailStatus('disabled')}><Ban /> Tạm tắt</Button>
            <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void delSelected()}><Trash2 /> Xóa</Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Bỏ chọn</Button>
          </div>}
          <div className="overflow-x-auto"><Table>
            <TableHeader><TableRow>
              <TableHead className="w-10"><Checkbox disabled={!selectablePageMails.length} checked={pageSelected} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); for (const mail of selectablePageMails) checked ? next.add(mail.id) : next.delete(mail.id); return next; })} aria-label="Chọn trang hiện tại" /></TableHead>
              <TableHead>Email</TableHead><TableHead>Trạng thái</TableHead><TableHead>Nguồn</TableHead><TableHead>Kiểm tra gần nhất</TableHead><TableHead className="w-48">Lấy code</TableHead><TableHead className="w-32 text-right">Thao tác</TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {pageMails.map((m) => (
                <TableRow key={m.id}>
                  <TableCell><Checkbox disabled={m.status === 'reserved'} checked={selected.has(m.id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); checked ? next.add(m.id) : next.delete(m.id); return next; })} aria-label={`Chọn ${m.email}`} /></TableCell>
                  <TableCell><div className="font-medium">{m.email}</div><div className="text-xs text-muted-foreground">{m.tags.length ? m.tags.join(', ') : m.provider || '—'}</div>{m.lastError && <div className="max-w-80 truncate text-xs text-destructive" title={m.lastError}>{m.lastError}</div>}{codeResult[m.id] && <div className="text-xs text-muted-foreground">{codeResult[m.id]}</div>}</TableCell>
                  <TableCell><Badge variant={mailStatusVariant(m.status)}>{MAIL_STATUS_LABEL[m.status]}</Badge>{m.reservedByProfileId && <div className="mt-1 max-w-28 truncate text-xs text-muted-foreground" title={m.reservedByProfileId}>{m.reservedByProfileId}</div>}</TableCell>
                  <TableCell><div className="text-sm">{MAIL_SOURCE_LABEL[m.source]}</div><div className="text-xs text-muted-foreground">{m.provider || '—'}</div></TableCell>
                  <TableCell className="text-xs text-muted-foreground">{m.lastCheckedAt ? new Date(m.lastCheckedAt).toLocaleString('vi-VN') : 'Chưa kiểm tra'}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      <Select value={codeType[m.id] || 'all'} onValueChange={(v) => setCodeType((s) => ({ ...s, [m.id]: v }))}>
                        <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
                        <SelectContent>{CODE_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                      <Button size="sm" variant="outline" onClick={() => getCode(m.id)}><MailIcon className="h-3.5 w-3.5" /> Code</Button>
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" title="Kiểm tra mail" disabled={checking || m.status === 'reserved'} onClick={() => void checkMails([m.id])}><RefreshCw className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title="Hộp thư" onClick={() => openInbox(m)}><Inbox className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title={m.status === 'reserved' ? 'Mail đang được profile sử dụng' : 'Xóa'} disabled={m.status === 'reserved'} onClick={() => del(m.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          {!mails.length && <div className="py-10 text-center text-muted-foreground">Chưa có mail nào.</div>}
          {mails.length > 0 && !filtered.length && <div className="py-10 text-center text-muted-foreground">Không có mail khớp "{q}".</div>}
          {pageCount > 1 && (
            <div className="flex items-center justify-center gap-3 pt-4">
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={curPage <= 1}>Trước</Button>
              <span className="text-sm text-muted-foreground">Trang {curPage}/{pageCount} · {filtered.length} mail</span>
              <Button variant="outline" size="sm" onClick={() => setPage((p) => Math.min(pageCount, p + 1))} disabled={curPage >= pageCount}>Sau</Button>
            </div>
          )}
        </CardContent>
      </Card>

      <MailImportDialog open={importOpen} onOpenChange={setImportOpen} onImported={loadMails} />

      <Dialog open={inbox.open} onOpenChange={(o) => setInbox((s) => ({ ...s, open: o }))}>
        <DialogContent className="max-w-3xl">
          <DialogHeader><DialogTitle>Hộp thư — {inbox.email}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            {inbox.loading && <div className="text-muted-foreground">Đang tải hộp thư...</div>}
            {inbox.error && <div className="text-destructive">Lỗi: {inbox.error}</div>}
            {!inbox.loading && !inbox.error && !inbox.msgs.length && <div className="text-muted-foreground">Hộp thư trống.</div>}
            {inbox.msgs.map((m, i) => (
              <div key={i} className="rounded-lg border p-3">
                <div className="font-semibold">{m.subject || '(không tiêu đề)'}</div>
                <div className="text-xs text-muted-foreground mb-2">{(m.from || []).map((f) => f.address || f.name).join(', ')} · {m.date || ''}{m.code ? ` · code: ${m.code}` : ''}</div>
                <iframe className="w-full h-64 border rounded bg-white" sandbox="" srcDoc={m.message || ''} />
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MailImportDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: () => Promise<void>;
}) {
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('backup');
  const [checkAfterImport, setCheckAfterImport] = useState(true);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState<Array<{ line: number; error: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setInvalid([]);
  }, [open]);

  async function importMails() {
    const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.length) return toast.error('Dán danh sách hoặc chọn file mail');
    setBusy(true);
    try {
      const result = await mailApi.import(lines, tags.split(',').map((tag) => tag.trim()).filter(Boolean));
      setInvalid(result.invalid);
      let checkedText = '';
      if (checkAfterImport && result.mails.length) {
        const checked = await mailApi.check(result.mails.map((mail) => mail.id));
        checkedText = ` · kiểm tra: ${checked.available} tốt, ${checked.failed} lỗi`;
      }
      toast.success(`Import ${result.added}/${result.total} mail · trùng ${result.duplicates} · sai ${result.invalid.length}${checkedText}`);
      await onImported();
      if (!result.invalid.length) {
        setContent('');
        onOpenChange(false);
      }
    } catch (error) { toast.error((error as Error).message); }
    finally { setBusy(false); }
  }

  async function readFile(file?: File) {
    if (!file) return;
    try { setContent(await file.text()); }
    catch { toast.error('Không đọc được file mail'); }
  }

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-2xl">
      <DialogHeader><DialogTitle>Import kho mail dự phòng</DialogTitle></DialogHeader>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Danh sách mail</Label>
          <Textarea rows={9} value={content} onChange={(event) => setContent(event.target.value)} placeholder="email|password|refresh_token|client_id&#10;Mỗi dòng một mail; file CSV 4 cột cũng được hỗ trợ." />
          <input className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm" type="file" accept=".txt,.csv,text/plain,text/csv" onChange={(event) => void readFile(event.target.files?.[0])} />
        </div>
        <div className="space-y-1.5"><Label>Tags</Label><Input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="backup, outlook" /></div>
        <label className="flex cursor-pointer items-center gap-2 text-sm"><Checkbox checked={checkAfterImport} onCheckedChange={(value) => setCheckAfterImport(value === true)} /> Kiểm tra khả năng đọc inbox ngay sau khi import</label>
        {invalid.length > 0 && <div className="max-h-32 overflow-auto rounded-md border p-3 text-xs text-destructive">
          {invalid.map((item) => <div key={`${item.line}-${item.error}`}>Dòng {item.line}: {item.error}</div>)}
        </div>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Hủy</Button><Button disabled={busy} onClick={() => void importMails()}>{busy ? 'Đang import...' : 'Import vào kho'}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}
