import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { RefreshCw, Mail as MailIcon, Inbox, Trash2 } from 'lucide-react';
import {
  settingsApi, mailApi, sellApi, smsbowerApi, CODE_TYPES,
  type MailRecord, type AccountType, type MailMessage, type SellProduct, type SmsbowerRest,
} from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Bảng tên gợi ý cho mã service SmsBower (chuẩn sms-activate). Chỉ để HIỂN THỊ
// cho dễ nhận diện — mã thô luôn hiện kèm nên không sợ nhầm. OpenAI/ChatGPT là
// 'dr'. Mã nào không có trong bảng thì chỉ hiện mã thô.
const SMS_SERVICE_NAMES: Record<string, string> = {
  dr: 'OpenAI / ChatGPT',
  go: 'Google / Gmail / YouTube',
  tg: 'Telegram',
  wa: 'WhatsApp',
  ig: 'Instagram',
  fb: 'Facebook',
  tw: 'Twitter / X',
  mm: 'Microsoft / Outlook',
  mb: 'Yahoo',
  am: 'Amazon',
  ds: 'Discord',
  vi: 'Viber',
  ub: 'Uber',
  ts: 'PayPal',
  ot: 'Khác (bất kỳ)',
};

export function MailTab() {
  const [keyState, setKeyState] = useState('(chưa có)');
  const [apiKey, setApiKey] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [sheetState, setSheetState] = useState('(chưa có)');
  const [tgToken, setTgToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [tgState, setTgState] = useState('(chưa có)');
  const [balance, setBalance] = useState('');
  const [accountTypes, setAccountTypes] = useState<AccountType[]>([]);
  const [typeState, setTypeState] = useState('');
  const [buyType, setBuyType] = useState('');
  const [manual, setManual] = useState('');
  // selltaikhoan (nhà cung cấp mail thứ 2)
  const [buyProvider, setBuyProvider] = useState<'dongvanfb' | 'selltaikhoan'>('dongvanfb');
  const [sellKey, setSellKey] = useState('');
  const [sellKeyState, setSellKeyState] = useState('(chưa có)');
  const [sellBalance, setSellBalance] = useState('');
  const [sellProducts, setSellProducts] = useState<SellProduct[]>([]);
  const [sellProductState, setSellProductState] = useState('');
  const [sellSearch, setSellSearch] = useState('outlook');
  const [buyProductId, setBuyProductId] = useState('');
  // smsbower (thuê gmail nhận OTP theo service — cho flow chatgpt)
  const [smsKey, setSmsKey] = useState('');
  const [smsKeyState, setSmsKeyState] = useState('(chưa có)');
  const [smsRests, setSmsRests] = useState<SmsbowerRest[]>([]);
  const [smsRestState, setSmsRestState] = useState('');
  const [mails, setMails] = useState<MailRecord[]>([]);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [codeType, setCodeType] = useState<Record<string, string>>({});
  const [codeResult, setCodeResult] = useState<Record<string, string>>({});
  const [inbox, setInbox] = useState<{ open: boolean; email: string; loading: boolean; msgs: MailMessage[]; error?: string }>({ open: false, email: '', loading: false, msgs: [] });

  async function loadSettings() {
    try {
      const s = await settingsApi.get();
      setKeyState(s.hasKey ? `(đã lưu: ${s.masked})` : '(chưa có)');
      setSheetUrl(s.sheetWebhookUrl || '');
      setSheetState(s.sheetWebhookUrl ? '(đã lưu)' : '(chưa có)');
      setTgChatId(s.telegramChatId || '');
      setTgState(s.hasTelegram ? `(đã lưu: ${s.telegramMasked})` : '(chưa có)');
      setSellKeyState(s.hasSelltaikhoanKey ? `(đã lưu: ${s.selltaikhoanMasked})` : '(chưa có)');
      setSmsKeyState(s.hasSmsbowerKey ? `(đã lưu: ${s.smsbowerMasked})` : '(chưa có)');
    } catch {}
  }
  async function loadMails() {
    try { setMails(await mailApi.list()); } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => { loadSettings(); loadMails(); }, []);

  async function saveKey() {
    if (!apiKey.trim()) { toast.error('Nhập API key'); return; }
    try { const s = await settingsApi.save({ dongvanfbApiKey: apiKey.trim() }); setApiKey(''); setKeyState(s.hasKey ? `(đã lưu: ${s.masked})` : '(chưa có)'); toast.success('Đã lưu API key'); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function saveSheet() {
    try { const s = await settingsApi.save({ sheetWebhookUrl: sheetUrl.trim() }); setSheetState(s.sheetWebhookUrl ? '(đã lưu)' : '(chưa có)'); toast.success(sheetUrl ? 'Đã lưu Sheet URL' : 'Đã xóa Sheet URL'); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function saveTelegram() {
    try {
      const s = await settingsApi.save({ telegramBotToken: tgToken.trim(), telegramChatId: tgChatId.trim() });
      setTgToken('');
      setTgState(s.hasTelegram ? `(đã lưu: ${s.telegramMasked})` : '(chưa có)');
      toast.success('Đã lưu Telegram');
    } catch (e) { toast.error((e as Error).message); }
  }
  async function loadBalance() {
    try { const r = await mailApi.balance(); setBalance(`Số dư: ${r.balance}`); } catch (e) { toast.error((e as Error).message); }
  }
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
  async function saveSellKey() {
    if (!sellKey.trim()) { toast.error('Nhập API key selltaikhoan'); return; }
    try { const s = await settingsApi.save({ selltaikhoanApiKey: sellKey.trim() }); setSellKey(''); setSellKeyState(s.hasSelltaikhoanKey ? `(đã lưu: ${s.selltaikhoanMasked})` : '(chưa có)'); toast.success('Đã lưu API key selltaikhoan'); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function loadSellBalance() {
    try { const r = await sellApi.balance(); setSellBalance(`Số dư: ${r.balance}`); } catch (e) { toast.error((e as Error).message); }
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
  async function saveSmsKey() {
    if (!smsKey.trim()) { toast.error('Nhập API key SmsBower'); return; }
    try { const s = await settingsApi.save({ smsbowerApiKey: smsKey.trim() }); setSmsKey(''); setSmsKeyState(s.hasSmsbowerKey ? `(đã lưu: ${s.smsbowerMasked})` : '(chưa có)'); toast.success('Đã lưu API key SmsBower'); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function loadSmsRests() {
    setSmsRestState('(đang tải...)');
    try {
      const r = await smsbowerApi.rests('gmail.com');
      const sorted = [...r.rests].sort((a, b) => b.count - a.count);
      setSmsRests(sorted);
      setSmsRestState(`(${sorted.length} service)`);
    } catch (e) { setSmsRestState(''); toast.error((e as Error).message); }
  }
  async function addManual() {
    const lines = manual.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { toast.error('Nhập ít nhất một mail'); return; }
    let ok = 0;
    for (const line of lines) { try { await mailApi.add({ line }); ok++; } catch (e) { toast.error((e as Error).message); } }
    if (ok) { setManual(''); toast.success(`Đã thêm ${ok} mail`); loadMails(); }
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
    try { await mailApi.remove(id); toast.success('Đã xóa mail'); loadMails(); } catch (e) { toast.error((e as Error).message); }
  }
  async function delAll() {
    if (!confirm(`Xóa sạch ${mails.length} mail trong kho? Không thể hoàn tác.`)) return;
    try { const r = await mailApi.removeMany(); toast.success(`Đã xóa ${r.removed} mail`); setPage(1); loadMails(); }
    catch (e) { toast.error((e as Error).message); }
  }
  async function openInbox(m: MailRecord) {
    setInbox({ open: true, email: m.email, loading: true, msgs: [] });
    try { const r = await mailApi.messages(m.id); setInbox({ open: true, email: m.email, loading: false, msgs: r.messages || [] }); }
    catch (e) { setInbox({ open: true, email: m.email, loading: false, msgs: [], error: (e as Error).message }); }
  }

  const PAGE_SIZE = 50;
  const needle = q.trim().toLowerCase();
  const filtered = needle
    ? mails.filter((m) => `${m.email} ${m.provider ?? ''}`.toLowerCase().includes(needle))
    : mails;
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pageCount);
  const pageMails = filtered.slice((curPage - 1) * PAGE_SIZE, curPage * PAGE_SIZE);

  const sellNeedle = sellSearch.trim().toLowerCase();
  const sellFiltered = sellNeedle
    ? sellProducts.filter((p) => `${p.name} ${p.category}`.toLowerCase().includes(sellNeedle))
    : sellProducts;

  return (
    <div className="grid grid-cols-[360px_1fr] gap-5">
      <div className="space-y-5">
        <Card>
          <CardHeader><CardTitle>Cài đặt &amp; số dư</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>API key dongvanfb <span className="text-muted-foreground font-normal">{keyState}</span></Label>
              <div className="flex gap-2"><Input type="password" placeholder="Dán API key..." value={apiKey} onChange={(e) => setApiKey(e.target.value)} /><Button onClick={saveKey}>Lưu</Button></div>
            </div>
            <div className="flex items-center gap-2"><Button variant="outline" onClick={loadBalance}>Xem số dư</Button><span className="text-sm font-semibold text-primary">{balance}</span></div>
            <div className="space-y-1.5">
              <Label>API key selltaikhoan <span className="text-muted-foreground font-normal">{sellKeyState}</span></Label>
              <div className="flex gap-2"><Input type="password" placeholder="Dán API key selltaikhoan..." value={sellKey} onChange={(e) => setSellKey(e.target.value)} /><Button onClick={saveSellKey}>Lưu</Button></div>
              <p className="text-xs text-muted-foreground">Nhà cung cấp mail thứ 2 (Outlook rẻ hơn). Mail cùng định dạng nên đọc OTP dùng chung.</p>
            </div>
            <div className="flex items-center gap-2"><Button variant="outline" onClick={loadSellBalance}>Xem số dư selltaikhoan</Button><span className="text-sm font-semibold text-primary">{sellBalance}</span></div>
            <div className="space-y-1.5">
              <Label>API key SmsBower <span className="text-muted-foreground font-normal">{smsKeyState}</span></Label>
              <div className="flex gap-2"><Input type="password" placeholder="Dán API key SmsBower..." value={smsKey} onChange={(e) => setSmsKey(e.target.value)} /><Button onClick={saveSmsKey}>Lưu</Button></div>
              <p className="text-xs text-muted-foreground">Thuê gmail nhận OTP theo service (dùng cho flow ChatGPT). Đặt "Mã service" trong tab Project.</p>
            </div>
            <div className="space-y-1.5">
              <Button variant="outline" onClick={loadSmsRests}>Xem tồn kho gmail <span className="text-muted-foreground font-normal">{smsRestState}</span></Button>
              {smsRests.length > 0 && (
                <div className="max-h-48 overflow-auto rounded-lg border p-2 text-xs">
                  {smsRests.map((r) => (
                    <div key={`${r.service}-${r.domain}`} className="flex justify-between gap-2 py-0.5">
                      <span className="truncate">
                        <span className="font-mono font-medium">{r.service}</span>
                        {SMS_SERVICE_NAMES[r.service] && <span className="text-muted-foreground"> · {SMS_SERVICE_NAMES[r.service]}</span>}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{r.price}đ · kho {r.count}</span>
                    </div>
                  ))}
                  <p className="mt-1 text-muted-foreground">Cột trái (mã) là "Mã service" điền ở tab Project. ChatGPT = <b>dr</b> (nếu có trong danh sách này). Nếu không thấy <b>dr</b> nghĩa là SmsBower chưa bán mail gmail cho OpenAI.</p>
                </div>
              )}
              {smsRestState === '(0 service)' && (
                <p className="text-xs text-destructive">SmsBower không trả service nào cho gmail.com — có thể hết hàng hoặc sai key.</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label>Google Sheet URL <span className="text-muted-foreground font-normal">{sheetState}</span></Label>
              <div className="flex gap-2"><Input placeholder=".../exec" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} /><Button onClick={saveSheet}>Lưu</Button></div>
              <p className="text-xs text-muted-foreground">Mỗi lần chạy flow ghi 1 dòng (mail + link checkout) vào sheet.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Telegram báo thành công <span className="text-muted-foreground font-normal">{tgState}</span></Label>
              <Input type="password" placeholder="Bot token (123456:ABC...)" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
              <div className="flex gap-2"><Input placeholder="Chat ID (-100... hoặc id cá nhân)" value={tgChatId} onChange={(e) => setTgChatId(e.target.value)} /><Button onClick={saveTelegram}>Lưu</Button></div>
              <p className="text-xs text-muted-foreground">Mỗi account đăng ký thành công gửi 1 tin nhắn (mail + dòng credential + link thanh toán).</p>
            </div>
          </CardContent>
        </Card>
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
        <Card>
          <CardHeader><CardTitle>Thêm mail thủ công</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Textarea placeholder="email|pass|refresh|client (mỗi dòng 1 mail)" value={manual} onChange={(e) => setManual(e.target.value)} />
            <Button variant="outline" onClick={addManual}>Thêm vào kho</Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="flex-row items-center gap-3 space-y-0">
          <CardTitle className="mr-auto">Kho mail {mails.length ? `(${mails.length})` : ''}</CardTitle>
          <Input
            placeholder="Tìm email / provider..."
            value={q}
            onChange={(e) => { setQ(e.target.value); setPage(1); }}
            className="max-w-56"
          />
          <Button variant="outline" onClick={loadMails}><RefreshCw className="h-4 w-4" /> Tải lại</Button>
          <Button variant="outline" onClick={delAll} disabled={!mails.length} className="text-destructive">
            <Trash2 className="h-4 w-4" /> Xóa hết
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader><TableRow><TableHead>Email</TableHead><TableHead>Provider</TableHead><TableHead className="w-72">Lấy code</TableHead><TableHead className="w-28 text-right">Thao tác</TableHead></TableRow></TableHeader>
            <TableBody>
              {pageMails.map((m) => (
                <TableRow key={m.id}>
                  <TableCell><div className="font-medium">{m.email}</div>{codeResult[m.id] && <div className="text-xs text-muted-foreground">{codeResult[m.id]}</div>}</TableCell>
                  <TableCell className="text-muted-foreground">{m.provider || '—'}</TableCell>
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
                    <Button variant="ghost" size="icon" title="Hộp thư" onClick={() => openInbox(m)}><Inbox className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title="Xóa" onClick={() => del(m.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
