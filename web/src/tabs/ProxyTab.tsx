import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Plus, RefreshCw, Play, Pencil, Trash2, ShoppingCart } from 'lucide-react';
import {
  proxyApi, mktApi, settingsApi,
  type ProxyDto, type ProxyType, type MktProduct,
} from '@/lib/api';
import { cn, fmtTime } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const PROXY_TYPES: ProxyType[] = ['socks5', 'http', 'https'];
const typeLabel = (t: string) => ({ socks5: 'Socks5', http: 'HTTP', https: 'HTTPS' } as any)[t] || t;

function StatusBadge({ p }: { p: ProxyDto }) {
  if (p.status === 'live') return <Badge variant="success">Live{p.latencyMs != null ? ` ${p.latencyMs}ms` : ''}</Badge>;
  if (p.status === 'dead') return <Badge variant="danger">Dead</Badge>;
  return <Badge variant="muted">-</Badge>;
}

export function ProxyTab() {
  const [list, setList] = useState<ProxyDto[]>([]);
  const [q, setQ] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [delAllOpen, setDelAllOpen] = useState(false);
  const [delAllInput, setDelAllInput] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<ProxyDto | null>(null);
  const [addMode, setAddMode] = useState<'list' | 'api'>('list');
  const [fType, setFType] = useState<ProxyType>('socks5');
  const [fLines, setFLines] = useState('');
  const [fApiKey, setFApiKey] = useState('');
  const [fHost, setFHost] = useState('');
  const [fPort, setFPort] = useState('');
  const [fUser, setFUser] = useState('');
  const [fPass, setFPass] = useState('');
  const [fTags, setFTags] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setList(await proxyApi.list(q)); } catch (e) { toast.error((e as Error).message); }
  }
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  function openAdd() {
    setEditing(null); setAddMode('list'); setFType('socks5'); setFLines(''); setFApiKey(''); setFTags('mktproxy');
    setFHost(''); setFPort(''); setFUser(''); setFPass(''); setModalOpen(true);
  }
  function openEdit(p: ProxyDto) {
    setEditing(p); setFType(p.type); setFTags(p.tags.join(', '));
    setFHost(p.host); setFPort(String(p.port)); setFUser(p.username || ''); setFPass(p.password || '');
    setModalOpen(true);
  }
  async function save() {
    setSaving(true);
    try {
      if (editing) {
        await proxyApi.update(editing.id, { type: fType, tags: fTags, host: fHost.trim(), port: fPort, username: fUser.trim(), password: fPass.trim() });
        toast.success('Đã cập nhật proxy');
      } else if (addMode === 'api') {
        if (!fApiKey.trim()) { toast.error('Dán API key proxy (key đơn xoay mktproxy)'); setSaving(false); return; }
        const created = await proxyApi.create({ apiProvider: 'mktproxy', apiKey: fApiKey.trim(), type: fType, tags: fTags });
        toast.success(`Đã thêm proxy API: ${created[0]?.display || ''}`);
      } else {
        if (!fLines.trim()) { toast.error('Nhập ít nhất một proxy'); setSaving(false); return; }
        const created = await proxyApi.create({ type: fType, tags: fTags, lines: fLines });
        toast.success(`Đã thêm ${created.length} proxy`);
      }
      setModalOpen(false); load();
    } catch (e) { toast.error((e as Error).message); }
    finally { setSaving(false); }
  }
  async function checkOne(p: ProxyDto) {
    try {
      const r = await proxyApi.check(p.id);
      toast[r.checkResult.alive ? 'success' : 'error'](r.checkResult.alive ? `Live (${r.checkResult.latencyMs}ms)` : `Dead: ${r.checkResult.error || ''}`);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function checkAll() {
    setRefreshing(true);
    try { await proxyApi.checkAll(); toast.success('Đã kiểm tra tất cả proxy'); load(); }
    catch (e) { toast.error((e as Error).message); }
    finally { setRefreshing(false); }
  }
  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }
  async function delSelected() {
    const ids = [...selected];
    if (!ids.length || !confirm(`Xoá ${ids.length} proxy đã chọn?`)) return;
    try {
      const result = await proxyApi.removeMany(ids);
      toast.success(`Đã xoá ${result.removed} proxy`);
      setSelected(new Set());
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  /** Xoá SẠCH kho proxy. Bắt gõ lại số lượng — confirm thường quá dễ bấm nhầm
   *  cho một thao tác không hoàn tác được. */
  async function delDead() {
    const dead = list.filter((p) => p.status === 'dead').map((p) => p.id);
    if (!dead.length) return toast.error('Không có proxy Dead nào');
    if (!confirm(`Xoá ${dead.length} proxy Dead?`)) return;
    try {
      const r = await proxyApi.removeMany(dead);
      toast.success(`Đã xoá ${r.removed} proxy Dead`);
      setSelected(new Set());
      load();
    } catch (e) { toast.error((e as Error).message); }
  }

  // Mở dialog gõ-số xác nhận. KHÔNG dùng window.prompt: Electron không hỗ trợ,
  // luôn trả null nên nút "Xoá tất cả" tưởng hỏng.
  function delAll() {
    if (!list.length) return toast.error('Kho proxy đang trống');
    setDelAllInput('');
    setDelAllOpen(true);
  }
  async function confirmDelAll() {
    if (delAllInput.trim() !== String(list.length)) return toast.error('Số không khớp, đã huỷ');
    try {
      const result = await proxyApi.removeMany();
      toast.success(`Đã xoá ${result.removed} proxy`);
      setSelected(new Set());
      setDelAllOpen(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function del(p: ProxyDto) {
    if (!confirm('Xóa proxy này?')) return;
    try { await proxyApi.remove(p.id); toast.success('Đã xóa proxy'); load(); }
    catch (e) { toast.error((e as Error).message); }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row flex-wrap items-center gap-2 space-y-0 border-b">
          <CardTitle className="mr-auto">Thư viện proxy</CardTitle>
          <Input placeholder="Tìm kiếm..." value={q} onChange={(e) => setQ(e.target.value)} className="max-w-56" />
          <Button variant="outline" onClick={checkAll} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} /> Làm mới
          </Button>
          <Button onClick={openAdd}><Plus className="h-4 w-4" /> Thêm mới</Button>
          <Button variant="ghost" onClick={() => void delDead()}>
            <Trash2 className="h-4 w-4" /> Xoá Dead
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => void delAll()}>
            <Trash2 className="h-4 w-4" /> Xoá tất cả
          </Button>
        </CardHeader>
        <CardContent>
          {selected.size > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2">
              <span className="text-sm font-medium">Đã chọn {selected.size}</span>
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => void delSelected()}>
                <Trash2 className="h-4 w-4" /> Xoá đã chọn
              </Button>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setSelected(new Set())}>Bỏ chọn</Button>
            </div>
          )}
          <div className="overflow-x-auto"><Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={list.length > 0 && list.every((p) => selected.has(p.id))}
                    onCheckedChange={(checked) => setSelected(checked ? new Set(list.map((p) => p.id)) : new Set())}
                    aria-label="Chọn tất cả proxy đang hiện"
                  />
                </TableHead>
                <TableHead>Loại</TableHead>
                <TableHead>Thông tin</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Thời gian tạo</TableHead>
                <TableHead>Trạng thái</TableHead>
                <TableHead className="w-32 text-right">Thao tác</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>
                    <Checkbox checked={selected.has(p.id)} onCheckedChange={() => toggle(p.id)} aria-label={`Chọn ${p.display}`} />
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1.5">
                      {typeLabel(p.type)}
                      {p.isApi && <Badge variant="default" className="text-[10px]">API</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{p.display}</TableCell>
                  <TableCell>
                    {p.tags.length ? p.tags.map((t) => <Badge key={t} variant="secondary" className="mr-1">{t}</Badge>) : <span className="text-muted-foreground">-</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground">{fmtTime(p.createdAt)}</TableCell>
                  <TableCell><StatusBadge p={p} /></TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon" title="Kiểm tra" onClick={() => checkOne(p)}><Play className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title="Sửa" onClick={() => openEdit(p)}><Pencil className="h-4 w-4" /></Button>
                    <Button variant="ghost" size="icon" title="Xóa" onClick={() => del(p)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table></div>
          {!list.length && <div className="py-10 text-center text-muted-foreground">Chưa có proxy nào. Bấm "Thêm mới" để thêm proxy thường hoặc proxy API (mktproxy).</div>}
        </CardContent>
      </Card>

      <MktProxyPanel onImported={load} />

      <Dialog open={delAllOpen} onOpenChange={setDelAllOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Xoá sạch kho proxy</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Sẽ xoá <b>{list.length}</b> proxy. Không hoàn tác được. Gõ <b>{list.length}</b> để xác nhận:
            </p>
            <Input
              autoFocus
              value={delAllInput}
              onChange={(e) => setDelAllInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void confirmDelAll(); }}
              placeholder={String(list.length)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDelAllOpen(false)}>Huỷ</Button>
            <Button variant="destructive" disabled={delAllInput.trim() !== String(list.length)} onClick={() => void confirmDelAll()}>Xoá tất cả</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editing ? 'Sửa proxy' : 'Thêm proxy'}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            {!editing && (
              <div className="inline-flex rounded-md border bg-muted p-0.5">
                {(['list', 'api'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setAddMode(m)}
                    className={cn('rounded px-3 py-1 text-sm transition-colors', addMode === m ? 'bg-background shadow font-medium' : 'text-muted-foreground')}
                  >
                    {m === 'list' ? 'Danh sách' : 'API (mktproxy)'}
                  </button>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Loại</Label>
              <Select value={fType} onValueChange={(v) => setFType(v as ProxyType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROXY_TYPES.map((t) => <SelectItem key={t} value={t}>{typeLabel(t)}</SelectItem>)}</SelectContent>
              </Select>
            </div>

            {editing ? (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><Label>Host</Label><Input value={fHost} onChange={(e) => setFHost(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Port</Label><Input value={fPort} onChange={(e) => setFPort(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>User</Label><Input value={fUser} onChange={(e) => setFUser(e.target.value)} /></div>
                <div className="space-y-1.5"><Label>Pass</Label><Input value={fPass} onChange={(e) => setFPass(e.target.value)} /></div>
              </div>
            ) : addMode === 'api' ? (
              <div className="space-y-1.5">
                <Label>API key proxy (key đơn xoay mktproxy)</Label>
                <Input placeholder="Dán key đơn proxy xoay..." value={fApiKey} onChange={(e) => setFApiKey(e.target.value)} />
                <p className="text-xs text-muted-foreground">Hệ thống gọi <code>/proxies/new</code> bằng key này để lấy IP hiện tại, lưu thành proxy dạng <b>API</b> — bấm Test để xoay/kiểm IP, profile dùng như proxy thường (gateway tự xoay).</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                <Label>Danh sách proxy</Label>
                <Textarea rows={5} placeholder="host:port:user:pass&#10;host:port" value={fLines} onChange={(e) => setFLines(e.target.value)} />
                <p className="text-xs text-muted-foreground">Mỗi dòng một proxy: <code>host:port</code> hoặc <code>host:port:user:pass</code>.</p>
              </div>
            )}

            <div className="space-y-1.5"><Label>Tags</Label><Input placeholder="us, residential" value={fTags} onChange={(e) => setFTags(e.target.value)} /></div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>Hủy</Button>
            <Button onClick={save} disabled={saving}>{saving ? 'Đang lưu...' : 'Lưu'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MktProxyPanel({ onImported }: { onImported: () => void }) {
  const [keyState, setKeyState] = useState('(chưa có)');
  const [products, setProducts] = useState<MktProduct[]>([]);
  const [productState, setProductState] = useState('');
  const [idx, setIdx] = useState<string>('');
  const [duration, setDuration] = useState('');
  const [qty, setQty] = useState('1');
  const [protocol, setProtocol] = useState('http');
  const [customFields, setCustomFields] = useState<Record<string, string>>({});
  const [tags, setTags] = useState('mktproxy');
  const [buying, setBuying] = useState(false);

  const product = idx === '' ? null : products[Number(idx)];

  async function loadKeyState() {
    try { const s = await settingsApi.get(); setKeyState(s.hasMktproxyKey ? `đã lưu: ${s.mktproxyMasked}` : 'chưa có'); } catch {}
  }
  useEffect(() => { loadKeyState(); }, []);

  useEffect(() => {
    if (!product) { setDuration(''); setProtocol('http'); setCustomFields({}); return; }
    setDuration(product.priceByDuration[0] ? String(product.priceByDuration[0].days) : '');
    setProtocol(product.protocols[0] || 'http');
    const cf: Record<string, string> = {};
    for (const f of product.customFields || []) {
      if (f.key) cf[f.key] = f.default != null ? String(f.default) : (Array.isArray(f.options) && f.options[0] ? String(f.options[0].key) : '');
    }
    setCustomFields(cf);
  }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadProducts() {
    setProductState('(đang tải...)');
    try { const r = await mktApi.products(); setProducts(r.products); setProductState(`(${r.products.length} sản phẩm)`); }
    catch (e) { setProductState(''); toast.error((e as Error).message); }
  }
  async function buy() {
    if (!product) { toast.error('Chọn sản phẩm (bấm "Tải sản phẩm" trước)'); return; }
    const quantity = Math.max(1, Number(qty) || 1);
    if (!confirm(`Mua "${product.name}" x${quantity}${duration ? ` (${duration} ngày)` : ''}? Thao tác này tốn tiền.`)) return;
    setBuying(true);
    try {
      const r = await mktApi.buy({ productCode: product.code, quantity, duration: duration ? Number(duration) : undefined, protocol, customFields, tags: tags.trim() });
      toast.success(`Đơn ${r.orderCode || '—'} (${r.orderStatus}): giao ${r.delivered}, nạp kho ${r.imported} proxy`);
      onImported();
    } catch (e) { toast.error((e as Error).message); }
    finally { setBuying(false); }
  }

  return (
    <details className="group overflow-hidden rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <ShoppingCart className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-semibold">Mua proxy từ mktproxy.com</span>
        <span className="text-xs text-muted-foreground">Mở khi cần mua và nạp proxy mới vào kho</span>
        <span className="ml-auto text-xs text-muted-foreground group-open:hidden">Mở cấu hình</span>
        <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">Thu gọn</span>
      </summary>
      <div className="space-y-4 border-t p-4">
        <div className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
          API key tài khoản mktproxy: <span className="font-medium text-foreground">{keyState}</span>
          {' — '}đổi key và xem số dư ở tab <span className="font-medium text-foreground">Cài đặt</span>.
        </div>

        <div className="space-y-1.5">
          <Label>Sản phẩm <span className="text-muted-foreground font-normal">{productState}</span></Label>
          <div className="flex gap-2">
            <Select value={idx} onValueChange={setIdx}>
              <SelectTrigger><SelectValue placeholder='— Bấm "Tải sản phẩm" —' /></SelectTrigger>
              <SelectContent>
                {products.map((p, i) => (
                  <SelectItem key={p.id} value={String(i)}>{p.name} — {p.country || ''} {p.proxyType || ''}{p.tag ? ` [${p.tag}]` : ''}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="outline" onClick={loadProducts}>Tải sản phẩm</Button>
          </div>
          {product?.note && <p className="text-xs text-muted-foreground whitespace-pre-line">{product.note}</p>}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <div className="space-y-1.5">
            <Label>Thời hạn</Label>
            <Select value={duration} onValueChange={setDuration} disabled={!product?.priceByDuration.length}>
              <SelectTrigger><SelectValue placeholder="(theo sản phẩm)" /></SelectTrigger>
              <SelectContent>{(product?.priceByDuration || []).map((d) => <SelectItem key={d.days} value={String(d.days)}>{d.days} ngày — {d.price}đ</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5"><Label>Số lượng</Label><Input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label>Giao thức</Label>
            <Select value={protocol} onValueChange={setProtocol}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(product?.protocols?.length ? product.protocols : ['http']).map((x) => <SelectItem key={x} value={x}>{x}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>

        {(product?.customFields || []).map((f, i) => (
          <div key={f.key || i} className="space-y-1.5">
            <Label>{f.label || f.key || `Tùy chọn ${i + 1}`}</Label>
            {Array.isArray(f.options) && f.options.length ? (
              <Select value={customFields[f.key] ?? ''} onValueChange={(v) => setCustomFields((c) => ({ ...c, [f.key]: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{f.options.map((o: any) => <SelectItem key={o.key} value={String(o.key)}>{o.label || o.key}</SelectItem>)}</SelectContent>
              </Select>
            ) : (
              <Input value={customFields[f.key] ?? ''} onChange={(e) => setCustomFields((c) => ({ ...c, [f.key]: e.target.value }))} />
            )}
          </div>
        ))}

        <div className="space-y-1.5"><Label>Tags (gán cho proxy nạp vào kho)</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} /></div>
        <Button onClick={buy} disabled={buying}>{buying ? 'Đang mua & chờ giao...' : 'Mua & nạp vào kho (tốn tiền)'}</Button>
      </div>
    </details>
  );
}
